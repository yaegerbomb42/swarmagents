/**
 * The codebase scanner that talks to a user's VM.
 *
 * The scanner program (lib/codebase/vm-analyzer-source.ts) is written into
 * the VM and run there: the repository lives in the VM, so that is the only
 * place where it can be read. The program leaves its result in
 * `~/.swarm/codebase/<repoHash>/scan.json`; the app reads that file back and
 * publishes the finished map next to it.
 */

import { WORKSPACE_ROOT } from "../vm/files";
import type { VmManager } from "../vm/manager";
import { repoHashForRoot } from "./hash";
import type {
  CodebaseMap,
  CodebaseRepoOption,
  CodebaseScan,
  CodebaseScanner,
} from "./types";
import { CODEBASE_ANALYZER_PATH, codebaseAnalyzerSource } from "./vm-analyzer-source";

/** How long one scan may take inside the VM. */
const SCAN_TIMEOUT_MS = 120_000;

/** Cached HOME per account (resolved once per VM). */
const homeCache = new Map<string, string>();

/** The HOME directory inside the user's VM. */
export async function vmHomeDir(vm: VmManager, userId: string): Promise<string> {
  const cached = homeCache.get(userId);
  if (cached) return cached;
  let out = "";
  await vm
    .exec(userId, ["sh", "-c", "echo $HOME"], { lane: "control", onStdout: (chunk) => { out += chunk; } })
    .catch(() => undefined);
  const home = out.trim() || "/home/node";
  homeCache.set(userId, home);
  return home;
}

/** Forget the cached HOME (the VM was reset or recreated). */
export function forgetVmHome(userId: string): void {
  homeCache.delete(userId);
}

/** Where a repository's map lives inside the VM. */
export function vmMapDir(home: string, repoHash: string): string {
  return `${home}/.swarm/codebase/${repoHash}`;
}

/** Where the account's choice of repository is remembered inside the VM. */
export function vmSelectionPath(home: string): string {
  return `${home}/.swarm/codebase/selection.json`;
}

/** A scanner that reads and writes inside one user's VM. */
export function createVmScanner(vm: VmManager): CodebaseScanner {
  async function runNode(userId: string, args: string[]): Promise<string> {
    let stdout = "";
    await vm
      .exec(userId, ["node", CODEBASE_ANALYZER_PATH, ...args], {
        timeoutMs: SCAN_TIMEOUT_MS,
        onStdout: (chunk) => { stdout += chunk; },
      })
      .catch(() => undefined);
    return stdout;
  }

  return {
    async scan(
      userId: string,
      repoRoot: string,
      options?: { sinceHead?: string },
    ): Promise<CodebaseScan | null> {
      try {
        await vm.writeFile(userId, CODEBASE_ANALYZER_PATH, codebaseAnalyzerSource());
      } catch {
        return null;
      }
      const stdout = await runNode(userId, [
        repoRoot,
        options?.sinceHead ? options.sinceHead : "-",
      ]);
      if (!stdout.trim()) return null;
      let parsed: { ok?: boolean; scanPath?: string; error?: string };
      try {
        parsed = JSON.parse(stdout) as { ok?: boolean; scanPath?: string; error?: string };
      } catch {
        return null;
      }
      if (!parsed.ok || !parsed.scanPath) return null;
      try {
        const raw = await vm.readFile(userId, parsed.scanPath);
        const scan = JSON.parse(raw) as CodebaseScan;
        if (!scan || !Array.isArray(scan.files)) return null;
        return scan;
      } catch {
        return null;
      }
    },

    async head(userId: string, repoRoot: string): Promise<string | undefined> {
      let stdout = "";
      try {
        await vm.exec(userId, ["git", "-C", repoRoot, "rev-parse", "HEAD"], {
          lane: "control",
          timeoutMs: 20_000,
          onStdout: (chunk) => { stdout += chunk; },
        });
      } catch {
        return undefined;
      }
      const head = stdout.trim();
      return head || undefined;
    },

    async publish(userId: string, repoRoot: string, map: CodebaseMap): Promise<void> {
      const home = await vmHomeDir(vm, userId);
      const dir = vmMapDir(home, map.repoHash || repoHashForRoot(repoRoot));
      await vm.writeFile(userId, `${dir}/map.json`, `${JSON.stringify(map, null, 2)}\n`).catch(() => undefined);
      await vm
        .writeFile(userId, `${dir}/context-pack.md`, map.contextPack.text)
        .catch(() => undefined);
    },

    async listRepos(userId: string): Promise<CodebaseRepoOption[]> {
      try {
        await vm.writeFile(userId, CODEBASE_ANALYZER_PATH, codebaseAnalyzerSource());
      } catch {
        return [];
      }
      const stdout = await runNode(userId, ["--list-repos", WORKSPACE_ROOT]);
      if (!stdout.trim()) return [];
      try {
        const parsed = JSON.parse(stdout) as { ok?: boolean; repos?: CodebaseRepoOption[] };
        if (!parsed.ok || !Array.isArray(parsed.repos)) return [];
        return parsed.repos;
      } catch {
        return [];
      }
    },

    async readMap(userId: string, repoRoot: string): Promise<CodebaseMap | null> {
      const home = await vmHomeDir(vm, userId);
      const file = `${vmMapDir(home, repoHashForRoot(repoRoot))}/map.json`;
      try {
        const raw = await vm.readFile(userId, file);
        const map = JSON.parse(raw) as CodebaseMap;
        return map?.contextPack?.text ? map : null;
      } catch {
        return null;
      }
    },

    async selectedRepo(userId: string): Promise<string | null> {
      const home = await vmHomeDir(vm, userId);
      try {
        const raw = await vm.readFile(userId, vmSelectionPath(home));
        const parsed = JSON.parse(raw) as { repoRoot?: unknown };
        const repoRoot = typeof parsed.repoRoot === "string" ? parsed.repoRoot : "";
        return repoRoot || null;
      } catch {
        return null;
      }
    },

    async selectRepo(userId: string, repoRoot: string): Promise<void> {
      const home = await vmHomeDir(vm, userId);
      await vm
        .writeFile(userId, vmSelectionPath(home), `${JSON.stringify({ repoRoot }, null, 2)}\n`)
        .catch(() => undefined);
    },
  };
}
