/**
 * Warm golden snapshots.
 *
 * When package.json, Dockerfile, or requirements.txt change, install
 * dependencies and warm language-server binaries into $HOME/.swarm-warm
 * (outside the workspace volume; the VM user can write its home) and
 * checkpoint that image. The next run
 * whose manifest fingerprint matches boots that image and keeps the live
 * workspace. Hotspot churn and fan-in decide which manifests are warmed
 * first when a repo has several.
 */

import { createHash } from "node:crypto";

export const WARM_LABEL_PREFIX = "warm-";
const MAX_MANIFESTS = 6;
const FIND_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 180_000;

const MANIFEST_FILE =
  /^(?:package\.json|Dockerfile|requirements\.txt)$/;

export interface HotspotHint {
  path: string;
  churn90d: number;
  fanIn: number;
}

export interface ManifestFile {
  /** Absolute path inside the VM, under /workspace. */
  path: string;
  sha256: string;
}

export type ManifestKind = "npm" | "docker" | "pip";

export interface RankedManifest extends ManifestFile {
  kind: ManifestKind;
  churn90d: number;
  fanIn: number;
  /** churn90d * (1 + fanIn). Higher is warmed first. */
  priority: number;
}

export interface WarmExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WarmVm {
  exec(
    userId: string,
    cmd: string[],
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ): Promise<{ exitCode: number; truncated?: boolean }>;
  listSnapshots(userId: string): Promise<Array<{ label: string }>>;
  snapshot(userId: string, label: string): Promise<unknown>;
  bootFromImage?(userId: string, label: string): Promise<void>;
}

export interface WarmApplyResult {
  fingerprint: string;
  label: string;
  action: "booted" | "built" | "skipped";
  reason?: string;
  manifests: RankedManifest[];
}

export function manifestKind(fileName: string): ManifestKind | null {
  if (fileName === "package.json") return "npm";
  if (fileName === "Dockerfile") return "docker";
  if (fileName === "requirements.txt") return "pip";
  return null;
}

/** Reject paths that could escape /workspace. */
export function isWorkspaceManifestPath(filePath: string): boolean {
  if (!filePath.startsWith("/workspace/")) return false;
  if (filePath.includes("\0") || filePath.includes("..")) return false;
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  return MANIFEST_FILE.test(base);
}

export function manifestPriority(churn90d: number, fanIn: number): number {
  const churn = Number.isFinite(churn90d) && churn90d > 0 ? churn90d : 0;
  const fan = Number.isFinite(fanIn) && fanIn > 0 ? fanIn : 0;
  return churn * (1 + fan);
}

export function rankManifests(
  files: ManifestFile[],
  hotspots: HotspotHint[],
): RankedManifest[] {
  const byPath = new Map<string, HotspotHint>();
  for (const hint of hotspots) {
    const normalized = hint.path.replace(/\\/g, "/").replace(/^\.\//, "");
    byPath.set(normalized, hint);
    byPath.set(`/workspace/${normalized.replace(/^\/+/, "")}`, hint);
  }
  const ranked: RankedManifest[] = [];
  for (const file of files) {
    if (!isWorkspaceManifestPath(file.path)) continue;
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) continue;
    const base = file.path.slice(file.path.lastIndexOf("/") + 1);
    const kind = manifestKind(base);
    if (!kind) continue;
    const rel = file.path.slice("/workspace/".length);
    const hint = byPath.get(file.path) ?? byPath.get(rel);
    const churn90d = hint?.churn90d ?? 0;
    const fanIn = hint?.fanIn ?? 0;
    ranked.push({
      ...file,
      kind,
      churn90d,
      fanIn,
      priority: manifestPriority(churn90d, fanIn),
    });
  }
  ranked.sort(
    (a, b) => b.priority - a.priority || a.path.localeCompare(b.path),
  );
  return ranked.slice(0, MAX_MANIFESTS);
}

/** Stable id for the set of manifest bytes. Empty input hashes to a fixed id. */
export function fingerprintManifests(files: RankedManifest[]): string {
  const hash = createHash("sha256");
  const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of ordered) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 12);
}

export function warmLabelFor(fingerprint: string): string {
  if (!/^[a-f0-9]{12}$/.test(fingerprint)) {
    throw new Error("Invalid warm fingerprint");
  }
  return `${WARM_LABEL_PREFIX}${fingerprint}`;
}

export function selectWarmSnapshot(
  labels: string[],
  fingerprint: string,
): string | null {
  const want = warmLabelFor(fingerprint);
  return labels.includes(want) ? want : null;
}

function parseFindOutput(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (isWorkspaceManifestPath(trimmed)) paths.push(trimmed);
  }
  return paths;
}

/**
 * Install deps for one manifest under $HOME/.swarm-warm/<fingerprint>.
 * Dockerfile has no daemon inside the VM; the file is copied so the
 * fingerprint still invalidates the snapshot when it changes.
 */
async function execCapture(
  vm: WarmVm,
  userId: string,
  cmd: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<WarmExecResult> {
  let stdout = "";
  let stderr = "";
  const result = await vm.exec(userId, cmd, {
    ...opts,
    onStdout: (chunk) => {
      stdout += chunk;
    },
    onStderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { exitCode: result.exitCode, stdout, stderr };
}

export function warmPlan(
  manifest: RankedManifest,
  root: string,
): { cmd: string[]; cwd?: string }[] {
  const dest = `${root}/${manifest.sha256.slice(0, 16)}`;
  const copy: { cmd: string[]; cwd?: string } = {
    cmd: ["mkdir", "-p", dest],
  };
  const copyFile: { cmd: string[]; cwd?: string } = {
    cmd: ["cp", "-f", manifest.path, `${dest}/${manifest.path.slice(manifest.path.lastIndexOf("/") + 1)}`],
  };
  if (manifest.kind === "npm") {
    return [
      copy,
      copyFile,
      { cmd: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: dest },
      {
        cmd: ["sh", "-c", "if [ -x node_modules/.bin/tsserver ]; then node_modules/.bin/tsserver --version; fi"],
        cwd: dest,
      },
    ];
  }
  if (manifest.kind === "pip") {
    return [
      copy,
      copyFile,
      {
        cmd: ["pip", "install", "--disable-pip-version-check", "-r", "requirements.txt"],
        cwd: dest,
      },
    ];
  }
  return [copy, copyFile];
}

export async function applyWarmGoldenSnapshot(
  vm: WarmVm,
  userId: string,
  hotspots: HotspotHint[],
): Promise<WarmApplyResult> {
  if (process.env.SWARM_WARM_SNAPSHOTS === "0") {
    return { fingerprint: "", label: "", action: "skipped", reason: "disabled", manifests: [] };
  }
  const found = await execCapture(vm,
    userId,
    [
      "find",
      "/workspace",
      "-maxdepth",
      "4",
      "(",
      "-name",
      "package.json",
      "-o",
      "-name",
      "Dockerfile",
      "-o",
      "-name",
      "requirements.txt",
      ")",
      "-type",
      "f",
    ],
    { timeoutMs: FIND_TIMEOUT_MS },
  );
  if (found.exitCode !== 0) {
    return {
      fingerprint: "",
      label: "",
      action: "skipped",
      reason: found.stderr.trim() || "find failed",
      manifests: [],
    };
  }
  const paths = parseFindOutput(found.stdout);
  const files: ManifestFile[] = [];
  for (const filePath of paths) {
    const hashed = await execCapture(vm, userId, ["sha256sum", "--", filePath], { timeoutMs: FIND_TIMEOUT_MS });
    if (hashed.exitCode !== 0) continue;
    const sha = hashed.stdout.trim().split(/\s+/)[0] ?? "";
    if (/^[a-f0-9]{64}$/.test(sha)) files.push({ path: filePath, sha256: sha });
  }
  const manifests = rankManifests(files, hotspots);
  if (manifests.length === 0) {
    return { fingerprint: "", label: "", action: "skipped", reason: "no manifests", manifests: [] };
  }
  const fingerprint = fingerprintManifests(manifests);
  const label = warmLabelFor(fingerprint);
  let existing: Array<{ label: string }> = [];
  try {
    existing = await vm.listSnapshots(userId);
  } catch (err) {
    return {
      fingerprint,
      label,
      action: "skipped",
      reason: err instanceof Error ? err.message : "listSnapshots failed",
      manifests,
    };
  }
  const selected = selectWarmSnapshot(existing.map((s) => s.label), fingerprint);
  if (selected && vm.bootFromImage) {
    await vm.bootFromImage(userId, selected);
    return { fingerprint, label: selected, action: "booted", manifests };
  }
  if (selected) {
    return { fingerprint, label: selected, action: "skipped", reason: "driver cannot boot image", manifests };
  }
  const home = await execCapture(vm, userId, ["sh", "-c", 'printf %s "$HOME"'], { timeoutMs: FIND_TIMEOUT_MS });
  const homeDir = home.stdout.trim();
  if (home.exitCode !== 0 || !homeDir.startsWith("/") || homeDir.includes("..")) {
    return { fingerprint, label, action: "skipped", reason: "could not resolve HOME", manifests };
  }
  const root = `${homeDir}/.swarm-warm/${fingerprint}`;
  const made = await execCapture(vm, userId, ["mkdir", "-p", root], { timeoutMs: FIND_TIMEOUT_MS });
  if (made.exitCode !== 0) {
    return {
      fingerprint,
      label,
      action: "skipped",
      reason: made.stderr.trim() || "could not create warm directory",
      manifests,
    };
  }
  for (const manifest of manifests) {
    for (const step of warmPlan(manifest, root)) {
      const result = await execCapture(vm, userId, step.cmd, {
        cwd: step.cwd,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      if (result.exitCode !== 0 && step.cmd[0] !== "sh") {
        return {
          fingerprint,
          label,
          action: "skipped",
          reason: `${manifest.path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
          manifests,
        };
      }
    }
  }
  await vm.snapshot(userId, label);
  return { fingerprint, label, action: "built", manifests };
}
