/**
 * Subsystem 7 — Speculative Rollback & Transient Worktree Isolation.
 *
 * Audit + hardening coverage for the speculative-rollback and transient-worktree
 * primitives: `src/git/worktree.ts`, `src/git/rollback.ts`, `src/git/locks.ts`,
 * and `src/autonomous/worktree-manager.ts`. Verifies:
 *
 *   1. Atomic speculative rollbacks restore a worktree on simulated failure and
 *      never leave stale git index locks, unmerged heads, or orphaned branches.
 *   2. Path containment: speculative mutation primitives cannot escape the
 *      sandbox boundary via path traversal (`../`) or symlinks.
 *   3. Deterministic lifecycle cleanup: transient worktrees are pruned/deleted
 *      on completion/abort, and parallel agents get non-colliding names.
 */
import { existsSync } from 'node:fs';
import { readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeManager } from '../../../src/autonomous/worktree-manager.js';
import { git } from '../../../src/git/git.js';
import { clearStaleGitLocks, gitDirFor } from '../../../src/git/locks.js';
import { rollbackTo } from '../../../src/git/rollback.js';
import {
  createVerificationWorktree,
  createWorktree,
  removeWorktreeByPath,
} from '../../../src/git/worktree.js';
import { tempDir, tempRepo } from '../../support/tmp.js';

async function seededRepo(): Promise<{ repo: string; head: string }> {
  const repo = await tempRepo();
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  return { repo, head };
}

const patchTouching = (): string =>
  [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1,2 @@',
    ' one',
    '+two',
    '',
  ].join('\n');

const escapePatch = (target: string): string =>
  [
    `diff --git a/${target} b/${target}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${target}`,
    '@@ -0,0 +1 @@',
    '+pwned',
    '',
  ].join('\n');

function isInside(candidate: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

describe('atomic speculative rollback', () => {
  it('rolls back a failed run byte-identically and leaves no stray files or unmerged state', async () => {
    const { repo, head } = await seededRepo();
    const wt = await createWorktree(repo, await tempDir(), 'r_audit1');
    // Simulate a failed agent run: an edit, a brand-new file, an artifact dir.
    await writeFile(join(wt.path, 'a.txt'), 'broken\n');
    await writeFile(join(wt.path, 'junk.txt'), 'junk\n');
    const patchPath = join(await tempDir(), 'rejected.patch');
    const { savedPatch, exact } = await rollbackTo(wt.path, head, {
      path: patchPath,
      redact: (x) => x,
    });

    expect(savedPatch).toBe(true);
    expect(exact).toBe(true);
    // The failed attempt is persisted for review before the reset.
    expect(await readFile(patchPath, 'utf8')).toContain('+broken');

    // Byte-identical restore, no leftovers, no unmerged/conflicted entries.
    expect(await readFile(join(wt.path, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(wt.path, 'junk.txt'))).toBe(false);
    const status = (await git(wt.path, ['status', '--porcelain'])).stdout.trim();
    expect(status).toBe('');
    await rm(wt.path, { recursive: true, force: true });
  });

  it('recovers even when a stale index.lock would wedge a plain reset', async () => {
    const { repo, head } = await seededRepo();
    const wt = await createWorktree(repo, await tempDir(), 'r_audit2');
    await writeFile(join(wt.path, 'a.txt'), 'broken\n');

    // Plant a lock file exactly where git would put it during an interrupted run.
    const gitDir = await gitDirFor(wt.path);
    const lock = join(gitDir, 'index.lock');
    await writeFile(lock, '');

    const { savedPatch } = await rollbackTo(wt.path, head, {
      path: join(await tempDir(), 'p.patch'),
      redact: (x) => x,
    });
    expect(savedPatch).toBe(true);
    // The hardened rollback cleared the lock, so the reset went through.
    expect(existsSync(lock)).toBe(false);
    expect(await readFile(join(wt.path, 'a.txt'), 'utf8')).toBe('one\n');
    expect((await git(wt.path, ['status', '--porcelain'])).stdout.trim()).toBe('');
    await rm(wt.path, { recursive: true, force: true });
  });
});

describe('transient worktree path containment & airgap', () => {
  it('confines verification worktrees under their configured root', async () => {
    const { repo } = await seededRepo();
    const root = await tempDir();
    const wt = await createVerificationWorktree(repo, { root });
    try {
      expect(isInside(wt.worktreePath, root)).toBe(true);
      expect(existsSync(wt.worktreePath)).toBe(true);
    } finally {
      await wt.cleanup();
    }
  });

  it('rejects a patch that escapes the worktree via ../ traversal', async () => {
    const { repo } = await seededRepo();
    const root = await tempDir();
    const outside = await tempDir();
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'classified\n');

    const wt = await createVerificationWorktree(repo, { root });
    try {
      const r = await wt.applyPatch(escapePatch('../../escape.txt'));
      // Either git refuses the traversal outright, or it never reaches outside.
      expect(r).toBe(false);
      expect(await readFile(secret, 'utf8')).toBe('classified\n');
      // Nothing may leak above the configured root either.
      for (const name of await (await import('node:fs/promises')).readdir(root)) {
        if (name.startsWith('verify-')) {
          expect(isInside(join(root, name), root)).toBe(true);
        }
      }
    } finally {
      await wt.cleanup();
    }
  });

  it('cannot traverse through a symlink planted in the worktree', async () => {
    const { repo } = await seededRepo();
    const outside = await tempDir();
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'untouched\n');

    const wt = await createVerificationWorktree(repo, { root: await tempDir() });
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(outside, join(wt.worktreePath, 'evil'), 'dir');
      const r = await wt.applyPatch(escapePatch('evil/victim.txt'));
      // The symlink must not let a speculative patch mutate a host path.
      expect(await readFile(victim, 'utf8')).toBe('untouched\n');
      expect(r).toBe(false);
    } finally {
      await wt.cleanup();
    }
  });

  it('applies a well-formed patch inside the worktree only', async () => {
    const { repo } = await seededRepo();
    const wt = await createVerificationWorktree(repo);
    try {
      expect(await wt.applyPatch(patchTouching())).toBe(true);
      expect(await readFile(join(wt.worktreePath, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
      // Primary checkout untouched.
      expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    } finally {
      await wt.cleanup();
    }
  });
});

describe('parallel transient worktree allocation', () => {
  it('allocates non-colliding worktrees and leaves no orphaned branches', async () => {
    const { repo } = await seededRepo();
    const root = await tempDir();
    const beforeRefs = (await git(repo, ['for-each-ref', 'refs/heads'])).stdout;

    const wts = await Promise.all(
      Array.from({ length: 6 }, () => createVerificationWorktree(repo, { root })),
    );
    const paths = wts.map((w) => w.worktreePath);
    expect(new Set(paths).size).toBe(paths.length); // no collisions
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
      expect(isInside(p, root)).toBe(true);
    }

    await Promise.all(wts.map((w) => w.cleanup()));
    for (const p of paths) expect(existsSync(p)).toBe(false);

    // Detached throwaway worktrees must never create branches.
    const afterRefs = (await git(repo, ['for-each-ref', 'refs/heads'])).stdout;
    expect(afterRefs).toBe(beforeRefs);
  });
});

describe('worktree lifecycle + git lock hygiene', () => {
  it('clearStaleGitLocks removes only old locks and keeps fresh in-flight ones', async () => {
    const { repo } = await seededRepo();
    const gitDir = await gitDirFor(repo);

    const stale = join(gitDir, 'stale.lock');
    const fresh = join(gitDir, 'fresh.lock');
    await writeFile(stale, '');
    await writeFile(fresh, '');
    const past = new Date(Date.now() - 60_000);
    await utimes(stale, past, past);

    const removed = await clearStaleGitLocks(repo);
    expect(removed).toContain(stale);
    expect(removed).not.toContain(fresh);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // young lock preserved (in-flight guard)

    // An explicit zero-age sweep clears the remaining lock.
    const swept = await clearStaleGitLocks(repo, { minAgeMs: 0 });
    expect(swept).toContain(fresh);
    expect(existsSync(fresh)).toBe(false);
  });

  it('removeWorktreeByPath clears a stale lock during teardown', async () => {
    const { repo } = await seededRepo();
    const wt = await createWorktree(repo, await tempDir(), 'r_audit_rm');
    const lock = join(await gitDirFor(wt.path), 'index.lock');
    await writeFile(lock, '');
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);

    expect(await removeWorktreeByPath(wt.path)).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    const list = await git(repo, ['worktree', 'list']);
    expect(list.stdout).not.toContain(wt.path);
  });

  it('WorktreeManager.destroy clears a stale lock and prunes the worktree + wip ref', async () => {
    const { repo, head } = await seededRepo();
    const manager = new WorktreeManager({ repoRoot: repo, worktreesRoot: await tempDir() });
    await manager.create('t_audit', head);

    const taskPath = manager.pathFor('t_audit');
    expect(existsSync(taskPath)).toBe(true);
    const lock = join(await gitDirFor(taskPath), 'index.lock');
    await writeFile(lock, '');
    const past = new Date(Date.now() - 60_000);
    await utimes(lock, past, past);

    await manager.destroy('t_audit');
    expect(existsSync(taskPath)).toBe(false);
    expect(await manager.list()).toEqual([]);
    const wip = (
      await git(repo, ['show-ref', '--verify', '--quiet', manager.wipRef('t_audit')], {
        allowFailure: true,
      })
    ).exitCode;
    expect(wip).not.toBe(0);
  });
});
