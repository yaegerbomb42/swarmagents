/**
 * Step 5.5 — 3-Way Differential Matrix & 4-Way Gate Evaluator.
 *
 * The orchestrator runs real `createVerificationWorktree` worktrees (Step 5.3) against a
 * real seeded git repo, while the test-runner is a scripted `Executor` so every verdict
 * branch is driven deterministically.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/core/exec.js';
import { git } from '../../../src/git/git.js';
import { runDifferentialMatrix } from '../../../src/verify/differential-tdr.js';
import { tempDir, tempRepo } from '../../support/tmp.js';

const REPRO = 'test/repro.test.ts';

interface Seed {
  repo: string;
  baseSha: string;
}

async function seeded(): Promise<Seed> {
  const repo = await tempRepo();
  await writeFile(join(repo, 'math.ts'), 'export const add = (a,b)=>a+b;\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-qm', 'init']);
  const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  return { repo, baseSha };
}

/** Unified diff that adds a line to `math.ts` — applies cleanly. */
const PATCH = [
  'diff --git a/math.ts b/math.ts',
  '--- a/math.ts',
  '+++ b/math.ts',
  '@@ -1 +1,2 @@',
  ' export const add = (a,b)=>a+b;',
  '+// patched',
  '',
].join('\n');

/** Unified diff referencing a file that does not exist — `git apply` refuses it. */
const BAD_PATCH = [
  'diff --git a/missing.ts b/missing.ts',
  '--- a/missing.ts',
  '+++ b/missing.ts',
  '@@ -1 +0,0 @@',
  '-nothing',
  '',
].join('\n');

interface Script {
  output: string;
  exitCode: number;
  timedOut?: boolean;
}

function jsonOutput(failures: { file: string; name: string }[]): string {
  // Group by file like a real vitest `--reporter=json` payload (one testResults entry per file).
  const groups = new Map<string, { name: string }[]>();
  for (const f of failures) {
    const group = groups.get(f.file) ?? [];
    group.push({ name: f.name });
    groups.set(f.file, group);
  }
  const failed = failures.length;
  const testResults = [...groups.entries()].map(([file, asserts]) => ({
    name: file,
    status: asserts.length ? 'failed' : 'passed',
    assertionResults: asserts.map((a) => ({
      fullName: a.name,
      ancestorTitles: [],
      title: a.name,
      status: 'failed',
      failureMessages: [`${a.name} failed`],
    })),
  }));
  return JSON.stringify({
    numTotalTests: failed,
    numPassedTests: 0,
    numFailedTests: failed,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults,
  });
}

/** Scripted executor: returns `scripts[i]` for the i-th invocated run, recording calls. */
function scriptedExecutor(scripts: Script[]): {
  exec: Executor;
  calls: { command: string; cwd: string }[];
} {
  const calls: { command: string; cwd: string }[] = [];
  let i = 0;
  const exec: Executor = (command, opts) => {
    calls.push({ command, cwd: opts.cwd });
    const spec = scripts[Math.min(i, scripts.length - 1)] ?? { output: '', exitCode: 0 };
    i += 1;
    return Promise.resolve({
      output: spec.output,
      exitCode: spec.exitCode,
      timedOut: spec.timedOut ?? false,
      aborted: false,
      durationMs: 12,
    });
  };
  return { exec, calls };
}

const reproFail = [{ file: REPRO, name: 'repro should fail' }];
const oldFail = [{ file: 'test/old.test.ts', name: 'preExisting' }];
const newFail = [{ file: 'test/new.test.ts', name: 'newRegress' }];

describe('Step 5.5: runDifferentialMatrix — 4-way gate evaluator', () => {
  it('passes when baseline reproduces, patch fixes, and no regressions appear', async () => {
    const { repo, baseSha } = await seeded();
    const root = await tempDir();
    const { exec, calls } = scriptedExecutor([
      { output: jsonOutput(reproFail), exitCode: 1 },
      { output: jsonOutput([]), exitCode: 0 },
      { output: jsonOutput(oldFail), exitCode: 1 },
      { output: jsonOutput(oldFail), exitCode: 1 },
    ]);

    const result = await runDifferentialMatrix(repo, baseSha, PATCH, REPRO, {
      exec,
      worktreeRoot: root,
    });

    expect(result.verdict).toEqual({ status: 'pass' });
    expect(result.regressions).toEqual([]);
    expect(result.flaky).toEqual([]);
    expect(calls).toHaveLength(4);
    // The repro run targets the repro file; the regression run is the full suite.
    expect(calls[0]?.command).toContain("run 'test/repro.test.ts'");
    expect(calls[2]?.command).not.toContain('repro.test.ts');
    // Failure parsing is wired through the real parser.
    expect(result.runs.prePatch?.failures[0]?.id).toBe(`${REPRO} > repro should fail`);
    // Transient worktrees are gone.
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects with reject_repro when the repro passes on baseline', async () => {
    const { repo, baseSha } = await seeded();
    const root = await tempDir();
    const { exec, calls } = scriptedExecutor([{ output: jsonOutput([]), exitCode: 0 }]);

    const result = await runDifferentialMatrix(repo, baseSha, PATCH, REPRO, {
      exec,
      worktreeRoot: root,
    });

    expect(result.verdict).toEqual({ status: 'reject_repro', reason: 'passed-on-baseline' });
    expect(calls).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects with reject_repro when the baseline repro times out', async () => {
    const { repo, baseSha } = await seeded();
    const root = await tempDir();
    const { exec, calls } = scriptedExecutor([
      { output: jsonOutput(reproFail), exitCode: 1, timedOut: true },
    ]);

    const result = await runDifferentialMatrix(repo, baseSha, PATCH, REPRO, {
      exec,
      worktreeRoot: root,
    });

    expect(result.verdict).toEqual({ status: 'reject_repro', reason: 'timed-out-on-baseline' });
    expect(calls).toHaveLength(1);
  });

  it('rejects with reject_fix when the patched repro still fails', async () => {
    const { repo, baseSha } = await seeded();
    const root = await tempDir();
    const { exec, calls } = scriptedExecutor([
      { output: jsonOutput(reproFail), exitCode: 1 },
      { output: jsonOutput(reproFail), exitCode: 1 },
    ]);

    const result = await runDifferentialMatrix(repo, baseSha, PATCH, REPRO, {
      exec,
      worktreeRoot: root,
    });

    expect(result.verdict).toEqual({ status: 'reject_fix', reason: 'failed-after-patch' });
    expect(calls).toHaveLength(2);
  });

  it('rejects with reject_fix when the patch does not apply', async () => {
    const { repo, baseSha } = await seeded();
    const root = await tempDir();
    const { exec, calls } = scriptedExecutor([{ output: jsonOutput(reproFail), exitCode: 1 }]);

    const result = await runDifferentialMatrix(repo, baseSha, BAD_PATCH, REPRO, {
      exec,
      worktreeRoot: root,
    });

    expect(result.verdict).toEqual({ status: 'reject_fix', reason: 'patch-did-not-apply' });
    // Only the baseline repro ran; the post-patch run was skipped.
    expect(calls).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects with reject_regression when new failures appear on the patched tree', async () => {
    const { repo, baseSha } = await seeded();
    const root = await tempDir();
    const { exec, calls } = scriptedExecutor([
      { output: jsonOutput(reproFail), exitCode: 1 },
      { output: jsonOutput([]), exitCode: 0 },
      { output: jsonOutput(oldFail), exitCode: 1 },
      { output: jsonOutput([...oldFail, ...newFail]), exitCode: 1 },
    ]);

    const result = await runDifferentialMatrix(repo, baseSha, PATCH, REPRO, {
      exec,
      worktreeRoot: root,
    });

    expect(result.verdict).toEqual({ status: 'reject_regression' });
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]?.id).toBe('test/new.test.ts > newRegress');
    expect(result.regressions[0]?.message).toContain('newRegress');
    expect(calls).toHaveLength(4);
  });

  it('quarantines flaky regressions when enabled (rerun drops the new failure)', async () => {
    const { repo, baseSha } = await seeded();
    const root = await tempDir();
    const { exec, calls } = scriptedExecutor([
      { output: jsonOutput(reproFail), exitCode: 1 },
      { output: jsonOutput([]), exitCode: 0 },
      { output: jsonOutput(oldFail), exitCode: 1 },
      { output: jsonOutput([...oldFail, ...newFail]), exitCode: 1 },
      { output: jsonOutput(oldFail), exitCode: 1 }, // rerun: the new failure vanished
    ]);

    const result = await runDifferentialMatrix(repo, baseSha, PATCH, REPRO, {
      exec,
      worktreeRoot: root,
      flakyReruns: 1,
    });

    expect(result.verdict).toEqual({ status: 'pass' });
    expect(result.regressions).toEqual([]);
    expect(result.flaky).toHaveLength(1);
    expect(result.flaky[0]?.id).toBe('test/new.test.ts > newRegress');
    expect(calls).toHaveLength(5);
  });

  it('rejects a repro path that escapes the repo root', async () => {
    const { repo, baseSha } = await seeded();
    await expect(runDifferentialMatrix(repo, baseSha, PATCH, '../escape.test.ts')).rejects.toThrow(
      /escapes the repo root/,
    );
  });
});
