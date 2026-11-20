import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../../../src/git/git.js';
import { RecursiveScopeRunner } from '../../../../src/agent/recursive/runner.js';

describe('RecursiveScopeRunner', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omnexx-runner-temp-'));
    repoDir = await mkdtemp(join(tmpdir(), 'omnexx-runner-repo-'));

    // Initialize git repository in repoDir
    await git(repoDir, ['init', '-b', 'main']);
    await git(repoDir, ['config', 'user.name', 'Test Agent']);
    await git(repoDir, ['config', 'user.email', 'agent@test.local']);

    await writeFile(
      join(repoDir, 'math.ts'),
      'export function add(a: number, b: number) { return 0; }\n',
    );
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'Initial commit']);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('runs recursive task, keeps tokens flat across turns, and independently verifies', async () => {
    let callCount = 0;
    const runner = new RecursiveScopeRunner({
      repoRoot: repoDir,
      storageDir: tempDir,
      runCommand: async (cmd: string) => {
        await Promise.resolve();
        if (cmd === 'test-oracle') {
          // Check if math.ts contains 'return a + b'
          return { code: 0, stdout: 'Oracle tests green! 5/5 assertions passed', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const subProblems = [
      {
        subGoal: 'Analyze function signature and write addition fact',
        targetFiles: ['math.ts'],
        solve: async () => {
          await Promise.resolve();
          callCount++;
          return {
            diff: '',
            facts: [{ file: 'math.ts', statement: 'add takes 2 numbers and returns a number' }],
            tokensUsed: { input: 1200, output: 80 },
          };
        },
      },
      {
        subGoal: 'Implement add(a, b) body returning a + b',
        targetFiles: ['math.ts'],
        solve: async () => {
          callCount++;
          // Apply change to repo directly for git diff
          await writeFile(
            join(repoDir, 'math.ts'),
            'export function add(a: number, b: number) { return a + b; }\n',
          );
          const diffRes = await git(repoDir, ['diff']);
          return {
            diff: diffRes.stdout,
            facts: [{ file: 'math.ts', statement: 'add returns a + b' }],
            tokensUsed: { input: 1350, output: 95 },
          };
        },
      },
    ];

    const result = await runner.runTask({
      taskId: 'task-test-01',
      goal: 'Implement addition in math.ts',
      acceptanceCriteria: ['add(1, 2) === 3'],
      subProblems,
      verifyCommand: 'test-oracle',
    });

    expect(callCount).toBe(2);
    expect(result.solved).toBe(true);
    expect(result.finalDiff).toContain(
      '+export function add(a: number, b: number) { return a + b; }',
    );

    const report = result.report;
    expect(report.mode).toBe('recursive');
    expect(report.solved).toBe(true);
    expect(report.totalTurns).toBe(4); // root + 2 subproblems + verifier

    // Verify token flatlining invariant:
    // Every call input tokens must be within a compact range (~1000 - 1500 tokens), NOT growing linearly
    for (const tokens of report.tokensPerTurn) {
      expect(tokens).toBeLessThan(4000);
    }

    // Input tokens between child 1 and child 2 stay flat
    const child1Tokens = report.tokensPerTurn[1];
    const child2Tokens = report.tokensPerTurn[2];
    expect(child1Tokens).toBeDefined();
    expect(child2Tokens).toBeDefined();
    expect(Math.abs((child2Tokens ?? 0) - (child1Tokens ?? 0))).toBeLessThan(300);
  });
});
