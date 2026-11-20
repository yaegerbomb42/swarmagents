/**
 * A codebase scanner that runs on the app server's own filesystem.
 *
 * It runs the very same analyzer program the VM runs (so both sides agree on
 * what a scan contains) and is used by the tests and by the tooling that
 * builds a map for a checkout on the server itself.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repoHashForRoot } from "./hash";
import type {
  CodebaseMap,
  CodebaseRepoOption,
  CodebaseScan,
  CodebaseScanner,
} from "./types";
import { codebaseAnalyzerSource } from "./vm-analyzer-source";

const execFileAsync = promisify(execFile);

let analyzerPath: string | null = null;

/** Write the analyzer to a temp file once and return its path. */
async function analyzerFile(): Promise<string> {
  if (analyzerPath) return analyzerPath;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-codebase-"));
  const file = path.join(dir, "codebase-analyzer.mjs");
  await fs.writeFile(file, codebaseAnalyzerSource(), "utf8");
  analyzerPath = file;
  return file;
}

/** Run the analyzer over a repository and return its scan. */
export async function scanRepoLocal(
  repoRoot: string,
  options?: { sinceHead?: string },
): Promise<CodebaseScan | null> {
  const file = await analyzerFile();
  try {
    // Match the scanner contract on platforms where the temp dir is a symlink
    // (notably macOS /var -> /private/var): repoRoot is always canonical.
    const canonicalRoot = await fs.realpath(path.resolve(repoRoot));
    const { stdout } = await execFileAsync(
      "node",
      [file, canonicalRoot, options?.sinceHead ?? "-"],
      { maxBuffer: 128 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { ok?: boolean; scanPath?: string };
    if (!parsed.ok || !parsed.scanPath) return null;
    const raw = await fs.readFile(parsed.scanPath, "utf8");
    return JSON.parse(raw) as CodebaseScan;
  } catch {
    return null;
  }
}

/** The HEAD of a local checkout. */
export async function localRepoHead(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", path.resolve(repoRoot), "rev-parse", "HEAD"], {
      maxBuffer: 1024 * 1024,
    });
    const head = stdout.trim();
    return head || undefined;
  } catch {
    return undefined;
  }
}

/** A scanner that reads and writes the server's own filesystem. */
export function createLocalScanner(home: string = os.homedir()): CodebaseScanner {
  return {
    async scan(
      _userId: string,
      repoRoot: string,
      options?: { sinceHead?: string },
    ): Promise<CodebaseScan | null> {
      return scanRepoLocal(repoRoot, options);
    },
    async head(_userId: string, repoRoot: string): Promise<string | undefined> {
      return localRepoHead(repoRoot);
    },
    async publish(_userId: string, repoRoot: string, map: CodebaseMap): Promise<void> {
      const dir = path.join(home, ".swarm", "codebase", map.repoHash || repoHashForRoot(repoRoot));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "map.json"), `${JSON.stringify(map, null, 2)}\n`, "utf8");
      await fs.writeFile(path.join(dir, "context-pack.md"), map.contextPack.text, "utf8");
    },
    async listRepos(_userId: string): Promise<CodebaseRepoOption[]> {
      return [];
    },
    async readMap(_userId: string, repoRoot: string): Promise<CodebaseMap | null> {
      const hash = repoHashForRoot(repoRoot);
      try {
        const raw = await fs.readFile(path.join(home, ".swarm", "codebase", hash, "map.json"), "utf8");
        return JSON.parse(raw) as CodebaseMap;
      } catch {
        return null;
      }
    },
    async selectedRepo(_userId: string): Promise<string | null> {
      try {
        const raw = await fs.readFile(path.join(home, ".swarm", "codebase", "selection.json"), "utf8");
        const parsed = JSON.parse(raw) as { repoRoot?: unknown };
        return typeof parsed.repoRoot === "string" && parsed.repoRoot ? parsed.repoRoot : null;
      } catch {
        return null;
      }
    },
    async selectRepo(_userId: string, repoRoot: string): Promise<void> {
      const dir = path.join(home, ".swarm", "codebase");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "selection.json"), `${JSON.stringify({ repoRoot }, null, 2)}\n`, "utf8");
    },
  };
}
