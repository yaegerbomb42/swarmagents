/**
 * Step 5.3 — Transient Worktree Lifecycle Manager (worktree.ts)
 *
 * Verifies that `createVerificationWorktree` provisions an isolated detached checkout that can
 * evaluate a candidate patch without touching the primary repository, and that `cleanup()` tears
 * it down defensively and idempotently.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../../../src/git/git.js';
import { createVerificationWorktree } from '../../../src/git/worktree.js';
import { tempRepo } from '../../support/tmp.js';

async function seeded(): Promise<{ repo: string; head: string }> {
  const repo = await tempRepo();
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  return { repo, head };
}

describe('Step 5.3: transient verification worktree manager', () => {
  it('creates a detached worktree at the repo HEAD', async () => {
    const { repo, head } = await seeded();
    const wt = await createVerificationWorktree(repo);
    try {
      expect(existsSync(wt.worktreePath)).toBe(true);
      expect((await git(wt.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
      // Detached checkout starts clean.
      expect((await git(wt.worktreePath, ['status', '--porcelain'])).stdout.trim()).toBe('');
    } finally {
      await wt.cleanup();
    }
  });

  it('checks out a requested baseSha when provided', async () => {
    const { repo } = await seeded();
    await writeFile(join(repo, 'b.txt'), 'two\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-qm', 'second']);
    const base = (await git(repo, ['rev-parse', 'HEAD~1'])).stdout.trim();
    const wt = await createVerificationWorktree(repo, { baseSha: base });
    try {
      expect((await git(wt.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(base);
      expect(existsSync(join(wt.worktreePath, 'b.txt'))).toBe(false);
    } finally {
      await wt.cleanup();
    }
  });

  it('applies a patch inside the worktree without touching the primary checkout', async () => {
    const { repo } = await seeded();
    const wt = await createVerificationWorktree(repo);
    try {
      const patch = [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1 +1,2 @@',
        ' one',
        '+two',
        '',
      ].join('\n');
      expect(await wt.applyPatch(patch)).toBe(true);
      expect(await readFile(join(wt.worktreePath, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
      // The primary repository working directory is completely untouched.
      expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    } finally {
      await wt.cleanup();
    }
  });

  it('reports false for an inapplicable patch and leaves the primary checkout untouched', async () => {
    const { repo } = await seeded();
    const wt = await createVerificationWorktree(repo);
    try {
      const bad = [
        'diff --git a/missing.txt b/missing.txt',
        '--- a/missing.txt',
        '+++ b/missing.txt',
        '@@ -1 +1,2 @@',
        '-one',
        '+one',
        '+two',
        '',
      ].join('\n');
      expect(await wt.applyPatch(bad)).toBe(false);
      expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    } finally {
      await wt.cleanup();
    }
  });

  it('cleanup removes the worktree, prunes metadata, and is idempotent', async () => {
    const { repo } = await seeded();
    const wt = await createVerificationWorktree(repo);
    const path = wt.worktreePath;
    expect(existsSync(path)).toBe(true);

    await wt.cleanup();
    expect(existsSync(path)).toBe(false);
    const list = await git(repo, ['worktree', 'list']);
    expect(list.stdout).not.toContain(path);

    // Second cleanup is a safe no-op.
    await wt.cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it('ignores the .worktrees root so the primary checkout stays clean', async () => {
    const { repo } = await seeded();
    const before = (
      await git(repo, ['status', '--porcelain', '--untracked-files=all'])
    ).stdout.trim();
    const wt = await createVerificationWorktree(repo);
    try {
      const after = (
        await git(repo, ['status', '--porcelain', '--untracked-files=all'])
      ).stdout.trim();
      expect(after).toBe(before);
    } finally {
      await wt.cleanup();
    }
  });
});
