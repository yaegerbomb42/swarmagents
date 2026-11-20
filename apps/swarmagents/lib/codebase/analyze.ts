/**
 * Turning a scan into a codebase map.
 *
 * The scan (see lib/codebase/vm-analyzer-source.ts) is raw material: files,
 * their sizes, their imports and their churn. This module turns that into the
 * two things the product needs:
 *
 *   - the context pack: a compact, token-bounded briefing about the repo that
 *     is prepended to every run's system prompt;
 *   - the heatmap: per-file churn x size x fan-in x the files this account's
 *     agent touched before.
 *
 * Everything here is pure: it takes a scan and returns a map, so the ranking
 * and the budget can be unit tested without a VM.
 */

import path from "node:path";
import { repoHashForRoot, repoNameForRoot } from "./hash";
import { guessModulePurpose, inferPurpose } from "./parse";
import { rankHeatmap, rankKeyFilesByFanIn } from "./ranking";
import { CONTEXT_PACK_TOKEN_BUDGET } from "./rules";
import { estimateTokens, truncateToTokenBudget } from "./tokens";
import type {
  BuildCodebaseMapOptions,
  CodebaseConventions,
  CodebaseContextPack,
  CodebaseFileInfo,
  CodebaseHeatmapEntry,
  CodebaseMap,
  CodebaseModuleInfo,
  CodebaseScan,
} from "./types";

/** Extensions tried when a relative import has no extension. */
const RESOLVE_EXTS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Resolve an import specifier to a repo-relative file path, when the target
 * is one of the scanned files. Bare specifiers (node modules) are ignored.
 */
export function resolveImportTarget(
  fromFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const fromDir = path.posix.dirname(toPosix(fromFile));
  const resolved = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [resolved];
  if (!path.posix.extname(resolved)) {
    for (const ext of RESOLVE_EXTS) candidates.push(resolved + ext);
  }
  for (const candidate of candidates) {
    const norm = candidate.replace(/^\.\//, "");
    if (knownFiles.has(norm)) return norm;
  }
  return null;
}

/** The build/test commands and the package manager, read from package.json. */
function readCommands(pkg: CodebaseScan["packageJson"]): {
  buildCommands: string[];
  testCommands: string[];
} {
  const scripts = pkg?.scripts ?? {};
  const buildCommands: string[] = [];
  const testCommands: string[] = [];
  for (const name of ["build", "typecheck", "lint", "dev"]) {
    if (scripts[name]) buildCommands.push(`npm run ${name}`);
  }
  for (const name of ["test", "test:unit", "test:e2e", "test:all"]) {
    if (scripts[name]) testCommands.push(`npm run ${name}`);
  }
  return { buildCommands, testCommands };
}

/**
 * The package that describes the repository: the one at the root, or the
 * shallowest one in a monorepo (the app the repository is really about).
 */
export function primaryPackage(scan: CodebaseScan): CodebaseScan["packageJson"] {
  if (scan.packageJson?.scripts && Object.keys(scan.packageJson.scripts).length > 0) {
    return scan.packageJson;
  }
  const candidates = scan.packageFiles ?? [];
  if (candidates.length === 0) return scan.packageJson;
  const scored = [...candidates].sort((a, b) => {
    const depth = a.path.split("/").length - b.path.split("/").length;
    if (depth !== 0) return depth;
    const scripts = Object.keys(b.scripts ?? {}).length - Object.keys(a.scripts ?? {}).length;
    if (scripts !== 0) return scripts;
    return a.path.localeCompare(b.path);
  });
  return scored[0];
}

/** The conventions a contributor should follow in this repository. */
export function detectConventions(
  pkg: CodebaseScan["packageJson"],
  lockFiles: string[] = [],
): CodebaseConventions {
  const conventions: CodebaseConventions = { notes: [] };
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const scripts = pkg?.scripts ?? {};
  // The command may live in `test`, but many projects keep the real runner in
  // `test:unit` / `test:e2e` and make `test` a thin wrapper.
  const test = [scripts.test, scripts["test:unit"], scripts["test:e2e"], scripts["test:all"]]
    .filter((script): script is string => typeof script === "string")
    .join(" ");

  if (deps.vitest || test.includes("vitest")) conventions.testFramework = "vitest";
  else if (deps.jest || test.includes("jest")) conventions.testFramework = "jest";
  else if (test.includes("node --test") || test.includes("tsx --test")) conventions.testFramework = "node:test";
  else if (deps.pytest) conventions.testFramework = "pytest";

  if (deps.eslint || scripts.lint?.includes("eslint")) conventions.lint = "eslint";
  else if (deps.biome || scripts.lint?.includes("biome")) conventions.lint = "biome";

  if (deps.prettier || scripts.format?.includes("prettier")) conventions.format = "prettier";
  else if (deps.biome || scripts.format?.includes("biome")) conventions.format = "biome";

  const manager = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (manager) conventions.packageManager = manager;
  else if (lockFiles.includes("pnpm-lock.yaml")) conventions.packageManager = "pnpm";
  else if (lockFiles.includes("yarn.lock")) conventions.packageManager = "yarn";
  else if (lockFiles.includes("bun.lockb") || lockFiles.includes("bun.lock")) conventions.packageManager = "bun";
  else if (lockFiles.includes("package-lock.json")) conventions.packageManager = "npm";

  if (scripts.typecheck) conventions.notes!.push(`typecheck: ${scripts.typecheck}`);
  if (!conventions.notes!.length) delete conventions.notes;
  return conventions;
}

/** The files that start the program: pages, entry points and API routes. */
export function detectEntryPoints(files: string[]): string[] {
  const known = new Set(files);
  const candidates = [
    "app/page.tsx",
    "app/layout.tsx",
    "app/main.ts",
    "pages/index.tsx",
    "src/main.ts",
    "src/index.ts",
    "src/index.tsx",
    "main.ts",
    "index.ts",
    "server.ts",
    "cmd/main.go",
    "main.go",
    "main.py",
    "app/main.py",
    "src/main.rs",
    "src/lib.rs",
  ];
  const found = candidates.filter((c) => known.has(c));
  // Monorepos keep their entry points inside an app: match the well known
  // names anywhere in the tree.
  const suffixes = [
    "/app/page.tsx",
    "/pages/index.tsx",
    "/src/main.ts",
    "/src/index.ts",
    "/src/index.tsx",
    "/cmd/main.go",
    "/src/main.rs",
    "/server.ts",
  ];
  const routes: string[] = [];
  for (const file of files) {
    if (suffixes.some((suffix) => file.endsWith(suffix))) found.push(file);
    if (/(^|\/)app\/api\//.test(file) && file.endsWith("/route.ts")) routes.push(file);
    if (file.startsWith("src/api/") && file.endsWith("/route.ts")) routes.push(file);
  }
  // A few API routes are enough to show the shape of the backend.
  found.push(...routes.slice(0, 5));
  return [...new Set(found)].slice(0, 20);
}

/** Group files into their top-level module and describe each one. */
export function buildTopLevelModules(
  files: string[],
  fileInfos: Map<string, CodebaseFileInfo>,
): CodebaseModuleInfo[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const top = file.includes("/") ? file.split("/")[0] : file;
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top)!.push(file);
  }
  const modules: CodebaseModuleInfo[] = [];
  for (const [top, groupFiles] of groups) {
    let bytes = 0;
    for (const file of groupFiles) bytes += fileInfos.get(file)?.bytes ?? 0;
    const kind: "dir" | "file" = fileInfos.has(top) ? "file" : "dir";
    modules.push({
      path: top,
      kind,
      purpose: kind === "file" ? (inferPurpose(top) ?? "File") : guessModulePurpose(top, groupFiles),
      files: groupFiles.length,
      bytes,
    });
  }
  return modules
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
    .slice(0, 40);
}

/** Render the context pack as the markdown block the agent reads. */
export function formatContextPack(
  pack: Omit<CodebaseContextPack, "text" | "tokenEstimate">,
  budget: number,
): string {
  const lines: string[] = [];
  lines.push(`# Codebase context: ${pack.repoName}`);
  lines.push(`root: ${pack.repoRoot}`);
  if (pack.gitHead) lines.push(`head: ${pack.gitHead.slice(0, 12)}`);
  const languages = Object.entries(pack.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");
  if (languages) lines.push(`languages: ${languages}`);
  if (pack.entryPoints.length) lines.push(`entry points: ${pack.entryPoints.slice(0, 12).join(", ")}`);
  if (pack.buildCommands.length) lines.push(`build/typecheck: ${pack.buildCommands.join(" | ")}`);
  if (pack.testCommands.length) lines.push(`tests: ${pack.testCommands.join(" | ")}`);
  const conventions: string[] = [];
  if (pack.conventions.testFramework) conventions.push(`test=${pack.conventions.testFramework}`);
  if (pack.conventions.lint) conventions.push(`lint=${pack.conventions.lint}`);
  if (pack.conventions.format) conventions.push(`format=${pack.conventions.format}`);
  if (pack.conventions.packageManager) conventions.push(`pm=${pack.conventions.packageManager}`);
  if (conventions.length) lines.push(`conventions: ${conventions.join(", ")}`);

  lines.push("");
  lines.push("## Top-level modules");
  for (const mod of pack.topLevelModules.slice(0, 24)) {
    const name = mod.kind === "dir" ? `${mod.path}/` : mod.path;
    lines.push(`- ${name} — ${mod.purpose} (${mod.files} files)`);
  }

  lines.push("");
  lines.push("## Key files (by fan-in)");
  for (const file of pack.keyFiles.slice(0, 40)) {
    const exports = file.exports?.length ? ` [exports: ${file.exports.slice(0, 6).join(", ")}]` : "";
    const purpose = file.purpose ? ` — ${file.purpose}` : "";
    lines.push(`- ${file.path} (fan-in ${file.fanIn})${purpose}${exports}`);
  }

  const full = `${lines.join("\n").trim()}\n`;
  return truncateToTokenBudget(full, budget).text;
}

/**
 * Relativize a coverage artifact's keys to repo-relative paths.
 *
 * Coverage artifacts key files however the runner saw them: absolute paths
 * under the repo root (vitest/jest), paths relative to the repo, or absolute
 * paths from another checkout of the same repo. Keys that match no scanned
 * file are dropped. Values are clamped to 0..100.
 */
export function normalizeCoverageMap(
  coverage: Record<string, number>,
  repoRoot: string,
  knownFiles: Set<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  const rootPosix = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const knownList = [...knownFiles];
  for (const [rawKey, rawPct] of Object.entries(coverage)) {
    if (typeof rawPct !== "number" || !Number.isFinite(rawPct)) continue;
    const pct = Math.max(0, Math.min(100, rawPct));
    const key = String(rawKey).replace(/\\/g, "/");
    let rel: string | null = null;
    if (rootPosix && key === rootPosix) continue;
    if (rootPosix && key.startsWith(`${rootPosix}/`)) rel = key.slice(rootPosix.length + 1);
    else if (knownFiles.has(key)) rel = key;
    else if (key.startsWith("/")) {
      // Absolute path from another checkout: the longest known file that is
      // a suffix of the key is the same file.
      let best: string | null = null;
      for (const known of knownList) {
        if (key.endsWith(`/${known}`) && (best === null || known.length > best.length)) best = known;
      }
      rel = best;
    }
    if (!rel || !knownFiles.has(rel)) continue;
    out.set(rel, pct);
  }
  return out;
}

/** Build the map for one repository from a scan. */
export function buildMapFromScan(
  scan: CodebaseScan,
  options: BuildCodebaseMapOptions & { nowMs?: number } = { repoRoot: scan.repoRoot },
): CodebaseMap {
  const started = Date.now();
  const budget = Math.max(512, Math.min(options.tokenBudget ?? CONTEXT_PACK_TOKEN_BUDGET, CONTEXT_PACK_TOKEN_BUDGET));
  const touches = options.agentTouchesByPath ?? {};
  const nowMs = options.nowMs ?? Date.now();

  const repoRoot = scan.repoRoot || options.repoRoot;
  const repoName = scan.repoName || repoNameForRoot(repoRoot);
  const repoHash = scan.repoHash || repoHashForRoot(repoRoot);

  const known = new Set(scan.files.map((f) => f.path));
  const primary = primaryPackage(scan);
  const fileInfos = new Map<string, CodebaseFileInfo>();
  const languages: Record<string, number> = {};
  const fanInCounts = new Map<string, number>();
  const coverageByPath = normalizeCoverageMap(scan.coverage ?? {}, repoRoot, known);

  for (const file of scan.files) {
    const language = file.language;
    if (language) languages[language] = (languages[language] ?? 0) + 1;
    const info: CodebaseFileInfo = {
      path: file.path,
      bytes: file.bytes,
      ...(file.lines !== undefined ? { lines: file.lines } : {}),
      ...(language ? { language } : {}),
      fanIn: 0,
      churn90d: scan.churn?.[file.path] ?? 0,
      agentTouches: touches[file.path] ?? 0,
      heat: 0,
      ...(file.complexity !== undefined ? { complexity: file.complexity } : {}),
      // Null is a normal state: no coverage artifact, or no data for this file.
      coveragePct: coverageByPath.get(file.path) ?? null,
    };
    fileInfos.set(file.path, info);
  }

  // Fan-in: how many other files import this one.
  for (const file of scan.files) {
    for (const specifier of file.imports ?? []) {
      const target = resolveImportTarget(file.path, specifier, known);
      if (!target) continue;
      fanInCounts.set(target, (fanInCounts.get(target) ?? 0) + 1);
    }
  }
  for (const [target, count] of fanInCounts) {
    const info = fileInfos.get(target);
    if (info) info.fanIn = count;
  }

  // Resolved direct imports, so a dependency slice can be built from the
  // map alone (the scan's raw specifiers are not kept on the file info).
  for (const file of scan.files) {
    const info = fileInfos.get(file.path);
    if (!info) continue;
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const specifier of file.imports ?? []) {
      const target = resolveImportTarget(file.path, specifier, known);
      if (target && !seen.has(target)) {
        seen.add(target);
        targets.push(target);
      }
    }
    if (targets.length) info.imports = targets;
  }

  // Purposes come from the path, falling back to the file's first meaningful
  // line: the pack stays small but still says what a file is for.
  const headByPath = new Map(scan.files.map((file) => [file.path, file.head]));
  for (const info of fileInfos.values()) {
    const purpose = inferPurpose(info.path, headByPath.get(info.path));
    if (purpose) info.purpose = purpose;
  }
  for (const file of scan.files) {
    const info = fileInfos.get(file.path);
    if (info && file.exports?.length) info.exports = file.exports.slice(0, 8);
  }

  const allInfos = [...fileInfos.values()];
  const heatmap: CodebaseHeatmapEntry[] = rankHeatmap(
    allInfos.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      fanIn: f.fanIn,
      churn90d: f.churn90d,
      agentTouches: f.agentTouches,
      ...(f.complexity !== undefined ? { complexity: f.complexity } : {}),
      coveragePct: f.coveragePct ?? null,
    })),
    300,
  );
  const heatByPath = new Map(heatmap.map((entry) => [entry.path, entry.heat]));
  for (const info of allInfos) info.heat = heatByPath.get(info.path) ?? 0;

  const topLevelModules = buildTopLevelModules([...known], fileInfos);
  const keyFiles = rankKeyFilesByFanIn(
    allInfos.filter((f) => f.fanIn > 0 || (f.exports?.length ?? 0) > 0),
    40,
  ).map((file) => ({
    path: file.path,
    ...(file.purpose ? { purpose: file.purpose } : {}),
    ...(file.exports?.length ? { exports: file.exports.slice(0, 8) } : {}),
    fanIn: file.fanIn,
  }));

  const commands = readCommands(primary);
  const conventions = detectConventions(primary, scan.lockFiles ?? []);

  const basePack = {
    repoRoot,
    repoName,
    repoHash,
    generatedAt: new Date(nowMs).toISOString(),
    ...(scan.gitHead ? { gitHead: scan.gitHead } : {}),
    languages,
    entryPoints: detectEntryPoints([...known]),
    buildCommands: commands.buildCommands,
    testCommands: commands.testCommands,
    topLevelModules,
    keyFiles,
    conventions,
  };

  let text = formatContextPack(basePack, budget);
  let tokenEstimate = estimateTokens(text);
  if (tokenEstimate > budget) {
    const shrunk = {
      ...basePack,
      keyFiles: basePack.keyFiles.slice(0, 20),
      topLevelModules: basePack.topLevelModules.slice(0, 12),
    };
    text = formatContextPack(shrunk, budget);
    tokenEstimate = estimateTokens(text);
  }
  if (tokenEstimate > budget) {
    const truncated = truncateToTokenBudget(text, budget);
    text = truncated.text;
    tokenEstimate = truncated.tokenEstimate;
  }

  const contextPack: CodebaseContextPack = { ...basePack, tokenEstimate, text };

  return {
    version: 1,
    repoRoot,
    repoName,
    repoHash,
    generatedAt: basePack.generatedAt,
    ...(scan.gitHead ? { gitHead: scan.gitHead } : {}),
    buildMs: Date.now() - started,
    files: allInfos,
    topLevelModules,
    languages,
    entryPoints: basePack.entryPoints,
    buildCommands: basePack.buildCommands,
    testCommands: basePack.testCommands,
    conventions,
    contextPack,
    heatmap,
  };
}

/** The top n hotspots of a map. */
export function selectHotspots(map: CodebaseMap, n = 20): CodebaseHeatmapEntry[] {
  const limit = Math.max(1, Math.min(200, Math.floor(n)));
  return [...(map.heatmap ?? [])].slice(0, limit);
}
