import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  computeDirtyHashes,
  computeFileHash,
  readTaskCheckpoint,
  reconcileCheckpoint,
  writeTaskCheckpointAtomic,
  type TaskCheckpoint,
} from '../../../src/core/checkpoint.js';
import { git } from '../../../src/git/git.js';

describe('src/core/checkpoint.ts', () => {
  it('returns undefined when checkpoint file does not exist', async () => {
    const testDir = join(tmpdir(), `checkpoint-empty-${Date.now()}-${Math.random()}`);
    expect(await readTaskCheckpoint(testDir, 'non-existent')).toBeUndefined();
  });

  it('handles computeFileHash on non-existent files gracefully', async () => {
    expect(await computeFileHash('/non/existent/path/file.txt')).toBe('');
  });

  it('writes and reads a checkpoint atomically', async () => {
    const testDir = join(tmpdir(), `checkpoint-test-${Date.now()}-${Math.random()}`);
    await mkdir(testDir, { recursive: true });

    try {
      const checkpoint: TaskCheckpoint = {
        version: 1,
        id: 'task-123',
        goal: 'Survive long runs',
        acceptanceCriteria: ['pass checks', 'zero lost state'],
        completedSteps: [
          {
            id: 'step-1',
            title: 'Initial setup',
            status: 'completed',
            filesModified: ['src/app.ts'],
            fileHashes: { 'src/app.ts': 'hash123' },
            evidence: { command: 'node test', output: 'ok', timestamp: Date.now() },
          },
        ],
        openDecisions: ['use atomic file writes'],
        nextAction: { phase: 'act', taskId: 'step-2', description: 'Write core logic' },
        gitHead: 'abcdef1234567890',
        dirtyFileHashes: { 'src/app.ts': 'hash123' },
        model: 'claude-3-5-sonnet',
        provider: 'anthropic',
        status: 'running',
        updatedAt: Date.now(),
      };

      await writeTaskCheckpointAtomic(testDir, checkpoint);
      const loaded = await readTaskCheckpoint(testDir, 'task-123');

      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe('task-123');
      expect(loaded?.goal).toBe('Survive long runs');
      expect(loaded?.completedSteps).toHaveLength(1);
      expect(loaded?.completedSteps[0]?.status).toBe('completed');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('computes dirty file hashes in git repository', async () => {
    const testDir = join(tmpdir(), `checkpoint-dirty-${Date.now()}-${Math.random()}`);
    await mkdir(join(testDir, 'src'), { recursive: true });

    try {
      await git(testDir, ['init', '-b', 'main']);
      await git(testDir, ['config', 'user.name', 'Test']);
      await git(testDir, ['config', 'user.email', 'test@example.com']);

      const f1 = join(testDir, 'src', 'dirty.txt');
      await writeFile(f1, 'dirty content');
      const dirty = await computeDirtyHashes(testDir);
      expect(Object.keys(dirty)).toContain('src/dirty.txt');
      expect(dirty['src/dirty.txt']).toBe(await computeFileHash(f1));
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('reconciles checkpoint against disk, marking mutated steps as unverified, recheck and detecting HEAD move', async () => {
    const testDir = join(tmpdir(), `checkpoint-reconcile-${Date.now()}-${Math.random()}`);
    await mkdir(join(testDir, 'src'), { recursive: true });

    try {
      await git(testDir, ['init', '-b', 'main']);
      await git(testDir, ['config', 'user.name', 'Test']);
      await git(testDir, ['config', 'user.email', 'test@example.com']);

      const file1 = join(testDir, 'src', 'file1.ts');
      const file2 = join(testDir, 'src', 'file2.ts');
      await writeFile(file1, 'console.log("file1");\n');
      await writeFile(file2, 'console.log("file2");\n');
      await git(testDir, ['add', '-A']);
      await git(testDir, ['commit', '-m', 'Initial commit']);

      const head = (await git(testDir, ['rev-parse', 'HEAD'])).stdout.trim();
      const hash1 = await computeFileHash(file1);
      const hash2 = await computeFileHash(file2);

      const checkpoint: TaskCheckpoint = {
        version: 1,
        id: 'task-recon',
        goal: 'Verify reconciliation',
        acceptanceCriteria: ['disk is source of truth'],
        completedSteps: [
          {
            id: 'step-1',
            title: 'Create file 1',
            status: 'completed',
            filesModified: ['src/file1.ts'],
            fileHashes: { 'src/file1.ts': hash1 },
          },
          {
            id: 'step-2',
            title: 'Create file 2',
            status: 'completed',
            filesModified: ['src/file2.ts'],
            fileHashes: { 'src/file2.ts': hash2 },
          },
        ],
        openDecisions: [],
        nextAction: { phase: 'verify' },
        gitHead: head,
        dirtyFileHashes: {},
        model: 'claude-3-5-sonnet',
        provider: 'anthropic',
        status: 'running',
        updatedAt: Date.now(),
      };

      // 1. Untouched files -> both verified
      const res1 = await reconcileCheckpoint(testDir, checkpoint);
      expect(res1.headMoved).toBe(false);
      expect(res1.unverifiedSteps).toHaveLength(0);
      expect(res1.verifiedSteps).toEqual(['step-1', 'step-2']);

      // 2. Mutate file2 outside the agent
      await writeFile(file2, 'console.log("file2 altered!");\n');

      // 3. Make a new commit moving HEAD
      await git(testDir, ['commit', '-am', 'External commit moving HEAD']);

      const res2 = await reconcileCheckpoint(testDir, checkpoint);
      expect(res2.headMoved).toBe(true);
      expect(res2.unverifiedSteps).toEqual(['step-2']);
      expect(res2.verifiedSteps).toEqual(['step-1']);
      expect(res2.checkpoint.completedSteps[1]?.status).toBe('unverified, recheck');
      expect(res2.details.some((d) => d.includes('Git HEAD moved'))).toBe(true);
      expect(res2.details.some((d) => d.includes('file2.ts'))).toBe(true);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
