import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitTreeSnapshotter } from '../../../src/agent/runtime/checkpoint.js';

const roots: string[] = [];

async function runGit(repoDir: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd: repoDir }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

/** Create an empty git repo with one initial commit containing seed.txt. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omnexx-snap-'));
  roots.push(root);
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'test@omnexx.dev']);
  await runGit(root, ['config', 'user.name', 'test']);
  await writeFile(path.join(root, 'seed.txt'), 'v1\n');
  await runGit(root, ['add', '-A']);
  await runGit(root, ['commit', '-qm', 'init']);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GitTreeSnapshotter', () => {
  it('captures uncommitted changes in the snapshot tree', async () => {
    const repoRoot = await makeRepo();
    const snap = new GitTreeSnapshotter(repoRoot);

    // Make an uncommitted change before snapshotting.
    await writeFile(path.join(repoRoot, 'seed.txt'), 'v2\n');

    const snapshot = await snap.snapshot();

    expect(snapshot.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.timestamp).toBeGreaterThan(0);

    // Restoring must reproduce the modified content, proving the change is captured.
    await snap.restore(snapshot);
    expect(await readFile(path.join(repoRoot, 'seed.txt'), 'utf8')).toBe('v2\n');
  });

  it('restore() resets the tree and deletes newly created untracked files', async () => {
    const repoRoot = await makeRepo();
    const snap = new GitTreeSnapshotter(repoRoot);
    const snapshot = await snap.snapshot();

    // Mutate a tracked file and create an untracked file (and a nested one).
    await writeFile(path.join(repoRoot, 'seed.txt'), 'changed\n');
    await writeFile(path.join(repoRoot, 'new.txt'), 'untracked\n');
    await mkdir(path.join(repoRoot, 'sub'));
    await writeFile(path.join(repoRoot, 'sub', 'nested.txt'), 'nested\n');

    await snap.restore(snapshot);

    expect(await readFile(path.join(repoRoot, 'seed.txt'), 'utf8')).toBe('v1\n');
    await expect(readFile(path.join(repoRoot, 'new.txt'))).rejects.toThrow();
    await expect(readFile(path.join(repoRoot, 'sub', 'nested.txt'))).rejects.toThrow();
  });

  it('restore() keeps files that exist in the snapshot', async () => {
    const repoRoot = await makeRepo();
    await writeFile(path.join(repoRoot, 'keep.txt'), 'keep\n');
    const snap = new GitTreeSnapshotter(repoRoot);
    const snapshot = await snap.snapshot();

    await writeFile(path.join(repoRoot, 'keep.txt'), 'changed\n');
    await snap.restore(snapshot);

    expect(await readFile(path.join(repoRoot, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('completes a full snapshot + restore cycle in under 100ms', async () => {
    const repoRoot = await makeRepo();
    const snap = new GitTreeSnapshotter(repoRoot);

    // Warm up git on the first run so the timed cycle measures steady-state cost.
    await snap.restore(await snap.snapshot());

    const start = performance.now();
    const snapshot = await snap.snapshot();
    await snap.restore(snapshot);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});
