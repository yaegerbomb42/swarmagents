/**
 * Scratch copies for the oracle gate: a detached `git worktree` of the
 * repo's HEAD plus the repo's current uncommitted state, so a candidate
 * patch is judged against exactly the tree it would land on — without the
 * real tree ever seeing it.
 *
 * Dependency directories (node_modules) are symlinked in, not copied, so a
 * scratch costs a checkout, not an install.
 */

import { createHash, randomUUID } from "node:crypto";
import { posix as path } from "node:path";
import type { OracleExec } from "./exec";

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
  /** Fingerprint of the real workspace copied into this scratch. */
  fingerprint: string;
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

export async function workspaceFingerprint(exec: OracleExec, repoRoot: string): Promise<string> {
  const root = repoRoot.replace(/\/+$/, "");
  const head = await must(exec, ["git", "-C", root, "rev-parse", "HEAD"], undefined, "git rev-parse HEAD");
  const status = await must(
    exec,
    ["git", "-C", root, "status", "--porcelain", "-z"],
    undefined,
    "git status --porcelain",
  );
  const diffHash = await must(
    exec,
    [
      "bash",
      "-o",
      "pipefail",
      "-c",
      'git -C "$1" diff --binary HEAD | git hash-object --stdin',
      "bash",
      root,
    ],
    undefined,
    "hash git diff HEAD",
  );
  const statusHash = createHash("sha256").update(status).digest("hex");
  return `${head.trim()}:${statusHash}:${diffHash.trim()}`;
}

export async function createScratch(exec: OracleExec, opts: ScratchOptions): Promise<Scratch> {
  const root = opts.repoRoot.replace(/\/+$/, "");
  const parent = opts.scratchRoot ?? path.join(path.dirname(root), ".oracle-scratch");
  const dir = path.join(parent, `oracle-${randomUUID()}`);
  const fingerprint = await workspaceFingerprint(exec, root);
  await must(exec, ["mkdir", "-p", parent], undefined, "mkdir scratch root");
  await must(exec, ["git", "-C", root, "worktree", "add", "--detach", "--quiet", dir, "HEAD"], undefined, "git worktree add");

  const scratch: Scratch = {
    dir,
    fingerprint,
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
    // Keep the diff inside the VM: stream it straight from the real tree into
    // the scratch rather than copying binary patch bytes through the host.
    await must(
      exec,
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        'git -C "$1" diff --binary HEAD | git -C "$2" apply --allow-empty --whitespace=nowarn',
        "bash",
        root,
        dir,
      ],
      undefined,
      "carry dirty state",
    );

    // Carry untracked (non-ignored) files, preserving their relative paths.
    // Avoid GNU-only `cp --parents` (not available on macOS/BSD): create each
    // parent directory and copy the file individually.
    const untracked = nulList(
      await must(exec, ["git", "-C", root, "ls-files", "--others", "--exclude-standard", "-z"], undefined, "git ls-files"),
    );
    for (let i = 0; i < untracked.length; i += 200) {
      const batch = untracked.slice(i, i + 200);
      await must(
        exec,
        [
          "sh",
          "-c",
          'root=$1; dest=$2; shift 2; for rel do case "$rel" in */*) mkdir -p "$dest/${rel%/*}" || exit ;; esac; cp -Pp "$root/$rel" "$dest/$rel" || exit; done',
          "sh",
          root,
          dir,
          ...batch,
        ],
        undefined,
        "copy untracked files",
      );
    }

    for (const rel of opts.linkDirs ?? []) {
      const src = path.join(root, rel);
      const exists = await exec(["test", "-e", src]);
      if (exists.exitCode !== 0) continue;
      const dst = path.join(dir, rel);
      await must(exec, ["mkdir", "-p", path.dirname(dst)], undefined, "mkdir link parent");
      await must(exec, ["ln", "-sfn", src, dst], undefined, `link ${rel}`);
    }
    if (await workspaceFingerprint(exec, root) !== fingerprint) {
      throw new Error("real workspace changed while creating oracle scratch");
    }
    return scratch;
  } catch (error) {
    await scratch.dispose();
    throw error;
  }
}
