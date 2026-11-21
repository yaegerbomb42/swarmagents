import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilityEntry } from "../schema";
import { truncateSummary } from "../schema";
import { classifyRisk } from "../risk";
import { CURATED_CLI_MAP } from "./cli-manifest";

const execFileAsync = promisify(execFile);

export interface CliScanOptions {
  probeUnknownHelp?: boolean;
  maxUnknownProbes?: number;
  helpTimeoutMs?: number;
}

async function runCmd(
  cmd: string,
  args: string[],
  timeoutMs = 2000
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    return (stdout || stderr || "").trim();
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "stdout" in err &&
      typeof (err as { stdout?: unknown }).stdout === "string"
    ) {
      const out = (err as { stdout: string }).stdout.trim();
      if (out) return out;
    }
    return null;
  }
}

function parseHelpOneLiner(helpText: string, binName: string): string {
  const lines = helpText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 8 &&
        !l.startsWith("-") &&
        !/^(usage|options|flags|commands|arguments):?$/i.test(l)
    );
  const first = lines[0] ?? `CLI executable ${binName}`;
  return truncateSummary(first);
}

async function listPackageManagerTools(): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  const [brewOut, npmOut, pipxOut, cargoOut, aptOut] = await Promise.all([
    runCmd("brew", ["list", "--formula", "-1"], 3000),
    runCmd("npm", ["list", "-g", "--depth=0", "--json"], 3000),
    runCmd("pipx", ["list", "--short"], 3000),
    runCmd("cargo", ["install", "--list"], 3000),
    process.platform === "linux"
      ? runCmd("dpkg-query", ["-W", "-f=${binary:Package}\n"], 3000)
      : Promise.resolve(null),
  ]);

  if (brewOut) {
    for (const line of brewOut.split("\n")) {
      const name = line.trim();
      if (name) found.set(name, "cli:brew");
    }
  }

  if (npmOut) {
    try {
      const parsed = JSON.parse(npmOut) as {
        dependencies?: Record<string, unknown>;
      };
      for (const pkg of Object.keys(parsed.dependencies ?? {})) {
        found.set(pkg, "cli:npm-g");
      }
    } catch {
      // ignore malformed npm output
    }
  }

  if (pipxOut) {
    for (const line of pipxOut.split("\n")) {
      const name = line.trim().split(/\s+/)[0];
      if (name) found.set(name, "cli:pipx");
    }
  }

  if (cargoOut) {
    for (const line of cargoOut.split("\n")) {
      const match = line.match(/^([a-zA-Z0-9_-]+)\s+v[\d.]+:/);
      if (match?.[1]) found.set(match[1], "cli:cargo");
    }
  }

  if (aptOut) {
    for (const line of aptOut.split("\n")) {
      const name = line.trim();
      if (name && CURATED_CLI_MAP.has(name)) found.set(name, "cli:apt");
    }
  }

  return found;
}

async function scanPathExecutables(): Promise<Map<string, string>> {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const binaries = new Map<string, string>();

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      const base =
        process.platform === "win32"
          ? file.replace(/\.(exe|cmd|bat)$/i, "")
          : file;
      if (!binaries.has(base)) {
        binaries.set(base, path.join(dir, file));
      }
    }
  }
  return binaries;
}

export async function scanCliTools(
  options: CliScanOptions = {}
): Promise<CapabilityEntry[]> {
  const probeUnknownHelp = options.probeUnknownHelp ?? true;
  const maxUnknownProbes = options.maxUnknownProbes ?? 30;
  const helpTimeoutMs = options.helpTimeoutMs ?? 2000;

  const [pathBins, pkgSources] = await Promise.all([
    scanPathExecutables(),
    listPackageManagerTools(),
  ]);

  const entries: CapabilityEntry[] = [];
  const seen = new Set<string>();

  // 1. Curated manifest tools present on PATH or package managers
  for (const [name, curated] of CURATED_CLI_MAP.entries()) {
    const binPath = pathBins.get(name);
    const pkgSource = pkgSources.get(name);
    if (!binPath && !pkgSource) continue;

    seen.add(name);
    const versionOut = binPath
      ? await runCmd(binPath, curated.versionArgs, 2000)
      : null;
    const versionLine = versionOut?.split(/\r?\n/)[0]?.slice(0, 80);

    entries.push({
      id: `cli:${name}`,
      kind: "cli",
      name,
      summary: truncateSummary(curated.summary),
      risk: curated.risk,
      schema: {
        binary: binPath ?? name,
        version: versionLine,
        versionCommand: `${name} ${curated.versionArgs.join(" ")}`,
      },
      source: pkgSource ?? "cli:PATH",
    });
  }

  // 2. Unknown binaries from package managers (high-signal user-installed tools)
  if (probeUnknownHelp) {
    let probed = 0;
    for (const [name, source] of pkgSources.entries()) {
      if (seen.has(name) || probed >= maxUnknownProbes) continue;
      const binPath = pathBins.get(name);
      if (!binPath) continue;

      probed++;
      seen.add(name);
      const helpText = await runCmd(binPath, ["--help"], helpTimeoutMs);
      const summary = helpText
        ? parseHelpOneLiner(helpText, name)
        : truncateSummary(`Installed CLI tool (${source})`);

      entries.push({
        id: `cli:${name}`,
        kind: "cli",
        name,
        summary,
        risk: classifyRisk({ name, summary, kind: "cli" }),
        schema: { binary: binPath },
        source,
      });
    }
  }

  return entries;
}
