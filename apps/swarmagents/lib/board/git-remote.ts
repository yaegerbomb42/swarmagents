/**
 * Remote branch verification for submit_task_work (t97): a submission
 * names a branch the worker claims to have pushed, and the board checks
 * the ref actually exists on origin before accepting the work.
 *
 * The check is on by default and disabled with SWARM_GIT_REMOTE_CHECK=0
 * (unit tests, and any server whose git/network setup cannot reach the
 * remote). It runs `git ls-remote origin refs/heads/<branch>` from the
 * repo checkout the server runs in; the ref lookup is read-only and
 * bounded by a 10s timeout.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const REMOTE_CHECK_TIMEOUT_MS = 10_000;

export function isGitRemoteCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SWARM_GIT_REMOTE_CHECK !== "0";
}

/** Find the repo root by walking up from a directory to a `.git` dir/file. */
export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export type RemoteBranchCheck = { ok: true; exists: boolean } | { ok: false; reason: string };

export interface RemoteCheckDeps {
  /** Directory to start the repo-root search from (default: process.cwd()). */
  cwd?: string;
  /** Injectable git runner so tests can stub the remote without network. */
  exec?: (cmd: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<{ stdout: string }>;
}

type GitExec = NonNullable<RemoteCheckDeps["exec"]>;

const defaultExec: GitExec = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout as string };
};

/**
 * Verify a branch exists on origin. `exists: false` means git answered
 * cleanly with no matching ref (the branch was never pushed); `ok: false`
 * means the check itself could not run (no git, no repo, timeout, or the
 * remote could not be reached) — the caller decides how to report that,
 * and must not treat it as proof the branch is missing.
 *
 * `git ls-remote` treats its pattern argument as fnmatch, so a branch
 * like `feat/*` would match every feat branch. `validateGitBranch`
 * rejects glob characters, and this function additionally requires an
 * exact `refs/heads/<branch>` line in the output (defense in depth):
 * a non-empty response that lists only other refs is still "missing".
 */
export async function checkBranchOnRemote(branch: string, deps: RemoteCheckDeps = {}): Promise<RemoteBranchCheck> {
  const root = findRepoRoot(deps.cwd ?? process.cwd());
  if (!root) {
    return { ok: false, reason: "no git repository found above the server working directory" };
  }
  const exec = deps.exec ?? defaultExec;
  try {
    const { stdout } = await exec("git", ["-C", root, "ls-remote", "origin", `refs/heads/${branch}`], {
      cwd: root,
      timeout: REMOTE_CHECK_TIMEOUT_MS,
    });
    const expected = `refs/heads/${branch}`;
    const exists = stdout
      .split("\n")
      .some((line) => line.trim().split(/\s+/)[1] === expected);
    return { ok: true, exists };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `git ls-remote failed: ${detail}` };
  }
}
