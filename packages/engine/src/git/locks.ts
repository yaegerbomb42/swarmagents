import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.js';

export interface ClearStaleLocksOptions {
  /** Override the clock for deterministic tests; defaults to Date.now(). */
  now?: number;
  /** Minimum age in ms before a lock file is considered stale; defaults to 5000. */
  minAgeMs?: number;
}

/**
 * Resolve a working-tree path to its git directory. For the main checkout this
 * is `<repo>/.git`; for a linked worktree it is its own git dir
 * (`<repo>/.git/worktrees/<name>`), which is where `index.lock` lives.
 */
export async function gitDirFor(cwd: string): Promise<string> {
  const rel = (await git(cwd, ['rev-parse', '--git-dir'])).stdout.trim();
  return rel.startsWith('/') ? rel : join(cwd, rel);
}

/**
 * Defensively remove stale git lock files left behind by a killed git process.
 *
 * A git process that dies mid-operation (crash, SIGKILL, abrupt host shutdown)
 * can leave `index.lock` / `HEAD.lock` / `*.lock` in the git dir. Those wedge
 * every later index/HEAD write (`reset`, `add`, `commit`, `checkout`), so a
 * speculative rollback or worktree teardown would otherwise hang forever.
 *
 * Best-effort: only removes lock files older than `minAgeMs` so an in-flight
 * git process is never disturbed, and swallows per-file errors. Returns the
 * absolute paths it removed.
 */
export async function clearStaleGitLocks(
  cwd: string,
  options: ClearStaleLocksOptions = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? 5_000;
  const gitDir = await gitDirFor(cwd);
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(gitDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const p = join(gitDir, name);
    const mtimeMs = await stat(p).then(
      (s) => s.mtimeMs,
      () => Number.NaN,
    );
    if (!Number.isFinite(mtimeMs)) continue;
    if (now - mtimeMs >= minAgeMs) {
      await rm(p, { force: true }).catch(() => undefined);
      removed.push(p);
    }
  }
  return removed;
}
