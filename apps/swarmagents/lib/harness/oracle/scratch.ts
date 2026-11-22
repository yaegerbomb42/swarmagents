/**
 * Scratch copies for the oracle gate: a detached `git worktree` of the
 * repo's HEAD plus the repo's current uncommitted state, so a candidate
 * patch is judged against exactly the tree it would land on — without the
 * real tree ever seeing it.
 *
 * Dependency directories (node_modules) are symlinked in, not copied, so a
 * scratch costs a checkout, not an install.
 */

import { randomUUID } from "node:crypto";
import { posix as path } from "node:path";
import { writeFileViaExec, type OracleExec } from "./exec";

export interface ScratchOptions {
  /** Absolute git repository root. */
  repoRoot: string;
  /** Parent directory for scratch worktrees. Default: `${repoRoot}/../.oracle-scratch`. */
  scratchRoot?: string;
  /**
   * Repo-relative directories to symlink into the scratch when they exist
   * in the real tree, e.g. ["apps/swarmagents/node_modules"].
   */
  linkDirs?: string[];
}

export interface Scratch {
  /** Absolute path of the scratch worktree. */
  dir: string;
  /** Remove the worktree. Never throws. */
  dispose(): Promise<void>;
}

async function must(exec: OracleExec, cmd: string[], cwd: string | undefined, what: string): Promise<string> {
  const res = await exec(cmd, cwd ? { cwd } : undefined);
  if (res.exitCode !== 0) throw new Error(`${what} failed (exit ${res.exitCode}): ${res.stderr.trim().slice(0, 500)}`);
  return res.stdout;
}

/** Split a NUL-separated git listing. */
function nulList(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

export async function createScratch(exec: OracleExec, opts: ScratchOptions): Promise<Scratch> {
  const root = opts.repoRoot.replace(/\/+$/, "");
  const parent = opts.scratchRoot ?? path.join(path.dirname(root), ".oracle-scratch");
  const dir = path.join(parent, `oracle-${randomUUID()}`);
  await must(exec, ["mkdir", "-p", parent], undefined, "mkdir scratch root");
  await must(exec, ["git", "-C", root, "worktree", "add", "--detach", "--quiet", dir, "HEAD"], undefined, "git worktree add");

  const scratch: Scratch = {
    dir,
    dispose: async () => {
      try {
        await exec(["git", "-C", root, "worktree", "remove", "--force", dir]);
      } catch {
        /* fall through to rm */
      }
      try {
        await exec(["rm", "-rf", dir]);
        await exec(["git", "-C", root, "worktree", "prune"]);
      } catch {
        /* disposal is best-effort */
      }
    },
  };

  try {
    // Carry tracked uncommitted changes (binary-safe).
    const dirty = await must(exec, ["git", "-C", root, "diff", "--binary", "HEAD"], undefined, "git diff HEAD");
    if (dirty.trim()) {
      const patchFile = `${dir}.dirty.patch`;
      await writeFileViaExec(exec, patchFile, dirty);
      try {
        await must(exec, ["git", "-C", dir, "apply", "--whitespace=nowarn", patchFile], undefined, "carry dirty state");
      } finally {
        await exec(["rm", "-f", patchFile]);
      }
    }

    // Carry untracked (non-ignored) files, preserving their relative paths.
    // Avoid GNU-only `cp --parents` (not available on macOS/BSD): create each
    // parent directory and copy the file individually.
    const untracked = nulList(
      await must(exec, ["git", "-C", root, "ls-files", "--others", "--exclude-standard", "-z"], undefined, "git ls-files"),
    );
    for (const file of untracked) {
      const dstDir = path.join(dir, path.dirname(file));
      await must(exec, ["mkdir", "-p", dstDir], undefined, "mkdir untracked parent");
      await must(exec, ["cp", "-p", path.join(root, file), path.join(dstDir, path.basename(file))], undefined, "copy untracked file");
    }

    for (const rel of opts.linkDirs ?? []) {
      const src = path.join(root, rel);
      const exists = await exec(["test", "-e", src]);
      if (exists.exitCode !== 0) continue;
      const dst = path.join(dir, rel);
      await must(exec, ["mkdir", "-p", path.dirname(dst)], undefined, "mkdir link parent");
      await must(exec, ["ln", "-sfn", src, dst], undefined, `link ${rel}`);
    }
    return scratch;
  } catch (error) {
    await scratch.dispose();
    throw error;
  }
}
