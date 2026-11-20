import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { GitError } from '../errors.js';
import { git } from './git.js';
import { clearStaleGitLocks } from './locks.js';
import { resolveRef } from './repo.js';

export interface Worktree {
  path: string;
  branch: string;
  startRef: string;
}

export const runBranch = (runId: string): string => `omnexx/${runId}`;

/**
 * Create `omnexx/<runId>` from `from` in a new worktree outside the repo. The user's checkout,
 * HEAD, index and working files are never touched; git only records the worktree in `.git`.
 */
export async function createWorktree(
  repo: string,
  worktreesRoot: string,
  runId: string,
  from = 'HEAD',
): Promise<Worktree> {
  const startRef = await resolveRef(repo, from);
  const branch = runBranch(runId);
  const path = join(worktreesRoot, `${basename(repo)}-${runId}`);
  await mkdir(worktreesRoot, { recursive: true });
  const r = await git(repo, ['worktree', 'add', '-b', branch, path, startRef], {
    allowFailure: true,
  });
  if (r.exitCode !== 0)
    throw new GitError(`cannot create worktree for ${runId}: ${r.stderr.trim()}`);
  return { path, branch, startRef };
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path], { allowFailure: true });
  await git(repo, ['worktree', 'prune'], { allowFailure: true });
}

export interface WorktreeEntry {
  path: string;
  /** Run id parsed from `<repo>-<runId>`, when the name matches. */
  runId?: string | undefined;
  /** Directory mtime (creation is close enough when the run state is gone). */
  mtimeMs: number;
}

/** Every worktree under `~/.omnexx/worktrees`, newest first. */
export async function listWorktrees(worktreesRoot: string): Promise<WorktreeEntry[]> {
  let names: string[];
  try {
    names = await readdir(worktreesRoot);
  } catch {
    return [];
  }
  const out: WorktreeEntry[] = [];
  for (const name of names) {
    const path = join(worktreesRoot, name);
    const mtimeMs = await stat(path).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    const runId = /-(r_[^/]+)$/.exec(name)?.[1];
    out.push({ path, ...(runId ? { runId } : {}), mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Remove a worktree by path alone: a linked worktree's `.git` file names its git dir
 * (`<repo>/.git/worktrees/<name>`), which locates the repo. Falls back to deleting the
 * directory when the repo cannot be found (git metadata may then need a manual prune).
 * Returns false only when nothing could be removed.
 */
export async function removeWorktreeByPath(path: string): Promise<boolean> {
  try {
    const dotGit = await readFile(join(path, '.git'), 'utf8');
    const gitDir = /^gitdir: (.+)$/m.exec(dotGit.trim())?.[1];
    if (gitDir) {
      // Remove any stale lock (e.g. index.lock) left by a killed git process so
      // `git worktree remove` cannot wedge on it.
      await clearStaleGitLocks(path).catch(() => undefined);
      // <repo>/.git/worktrees/<name> -> <repo>
      await removeWorktree(resolve(gitDir, '..', '..', '..'), path);
      return true;
    }
  } catch {
    // Fall through to the plain delete below.
  }
  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export interface VerificationWorktreeOptions {
  /** Commit to check out detached; defaults to the repository's current HEAD. */
  baseSha?: string;
  /**
   * Root directory for transient verification worktrees. Defaults to `<repoRoot>/.worktrees`;
   * pass a temp dir to keep them entirely outside the repo. Worktrees are never symlinked
   * (notably `node_modules`), so a tool run inside one cannot cross-resolve the host tree.
   */
  root?: string;
}

export interface VerificationWorktree {
  /** Absolute path to the detached worktree checkout. */
  worktreePath: string;
  /**
   * Apply a candidate unified patch diff inside the worktree with `git apply --whitespace=fix`.
   * Returns true when it applied cleanly; false (without touching the primary checkout) otherwise.
   */
  applyPatch: (diff: string) => Promise<boolean>;
  /** Idempotent, defensive removal of the worktree and its git metadata. */
  cleanup: () => Promise<void>;
}

/**
 * Create a transient, detached verification worktree (Step 5.3).
 *
 * Unlike the run-scoped worktrees above, this is a throwaway checkout used to evaluate a patch in
 * isolation (e.g. a speculative verification diff) without touching the primary working tree, HEAD,
 * or index. The worktree is created via `git worktree add --detach` at `baseSha` (or the repo
 * HEAD), and `.worktrees/` is added to `.git/info/exclude` so it never shows up as untracked.
 */
export async function createVerificationWorktree(
  repoRoot: string,
  options: VerificationWorktreeOptions = {},
): Promise<VerificationWorktree> {
  const baseSha = await resolveRef(repoRoot, options.baseSha ?? 'HEAD');
  const root = options.root ?? join(repoRoot, '.worktrees');
  await mkdir(root, { recursive: true });
  if (isInside(root, repoRoot)) {
    await ensureIgnored(repoRoot, relative(repoRoot, root));
  }

  const name = `verify-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const worktreePath = join(root, name);
  const created = await git(repoRoot, ['worktree', 'add', '--detach', worktreePath, baseSha], {
    allowFailure: true,
  });
  if (created.exitCode !== 0) {
    throw new GitError(
      `cannot create verification worktree ${name}: ${created.stderr.trim() || created.stdout.trim()}`,
    );
  }

  let cleaned = false;
  const applyPatch = async (diff: string): Promise<boolean> => {
    if (cleaned) return false;
    const applied = await git(worktreePath, ['apply', '--whitespace=fix', '-'], {
      input: diff,
      allowFailure: true,
    });
    return applied.exitCode === 0;
  };
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // Clear stale git locks so the removal cannot wedge on a lock left by a
    // killed process (e.g. SIGKILL mid-verification).
    await clearStaleGitLocks(worktreePath).catch(() => undefined);
    await git(repoRoot, ['worktree', 'remove', '--force', worktreePath], {
      allowFailure: true,
    });
    await git(repoRoot, ['worktree', 'prune'], { allowFailure: true });
    // Unlink any residual artifacts the remove may have left behind.
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  };

  return { worktreePath, applyPatch, cleanup };
}

function isInside(candidate: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Ensure `.git/info/exclude` ignores a directory (relative to the repo root). */
async function ensureIgnored(repoRoot: string, relDir: string): Promise<void> {
  const infoDir = join(repoRoot, '.git', 'info');
  const excludePath = join(infoDir, 'exclude');
  let content = '';
  try {
    content = await readFile(excludePath, 'utf8');
  } catch {
    // Absent exclude file: create it.
  }
  const line = `${relDir.replace(/\\/g, '/')}/`;
  if (content.split('\n').some((l) => l.trim() === line)) return;
  const next =
    content === '' || content.endsWith('\n') ? `${content}${line}\n` : `${content}\n${line}\n`;
  await mkdir(infoDir, { recursive: true });
  await writeFile(excludePath, next);
}
