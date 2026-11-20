import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypedMemory } from '../../../../src/agent/recursive/typed-memory.js';
import { bindTestEvidence } from '../../../../src/agent/recursive/return-contract.js';

describe('TypedMemory', () => {
  let tempDir: string;
  let repoDir: string;
  let memory: TypedMemory;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omnexx-mem-test-'));
    repoDir = await mkdtemp(join(tmpdir(), 'omnexx-repo-test-'));
    memory = new TypedMemory({
      scopeId: 'test-scope-1',
      storageDir: tempDir,
      repoRoot: repoDir,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('reads and writes scope state atomically', async () => {
    const initialState = await memory.readState();
    expect(initialState.goal).toBe('');
    expect(initialState.depth).toBe(0);

    await memory.writeState({
      goal: 'Implement recursive scope harness',
      acceptanceCriteria: ['Tests pass', 'Tokens flatline'],
      plan: ['Step 1: typed memory', 'Step 2: tree'],
      doneItems: [],
      nextAction: 'Write unit tests',
      depth: 1,
    });

    const updated = await memory.readState();
    expect(updated.goal).toBe('Implement recursive scope harness');
    expect(updated.depth).toBe(1);
    expect(updated.plan).toHaveLength(2);
    expect(updated.acceptanceCriteria).toHaveLength(2);
  });

  it('records facts bound to file SHA-256 and expires them when the file changes', async () => {
    const testFile = 'src/sample.ts';
    const absPath = join(repoDir, testFile);
    await mkdir(join(repoDir, 'src'), { recursive: true });
    await writeFile(absPath, 'export const version = "1.0.0";\n', 'utf8');

    const recorded = await memory.recordFact(testFile, 'version is 1.0.0', 'version');
    expect(recorded).not.toBeNull();
    expect(recorded?.statement).toBe('version is 1.0.0');

    // Currently file is unchanged -> fact is active
    let active = await memory.getActiveFacts();
    expect(active).toHaveLength(1);
    expect(active[0]?.statement).toBe('version is 1.0.0');

    // Modify file content -> fact expires automatically!
    await writeFile(absPath, 'export const version = "2.0.0";\n', 'utf8');

    active = await memory.getActiveFacts();
    expect(active).toHaveLength(0); // Automatically expired!
  });

  it('records failed attempts and done items with cryptographically bound evidence', async () => {
    await memory.recordFailedAttempt(
      'src/sample.ts',
      'Direct regex replace',
      'Broke AST parsing on line 42',
    );

    const failures = await memory.readFailedAttempts();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.target).toBe('src/sample.ts');
    expect(failures[0]?.error).toBe('Broke AST parsing on line 42');

    const evidence = bindTestEvidence(
      'npm test',
      0,
      'All tests passed (12/12)',
      'diff --git a/src/sample.ts b/src/sample.ts',
    );
    const doneItem = await memory.addDoneItem('Refactored AST parser', evidence);
    expect(doneItem.evidence.passed).toBe(true);
    expect(doneItem.evidence.diffHash).toBe(evidence.diffHash);

    const state = await memory.readState();
    expect(state.doneItems).toHaveLength(1);
    expect(state.doneItems[0]?.description).toBe('Refactored AST parser');
  });

  it('builds fresh context prompt without transcript history', async () => {
    const testFile = 'src/foo.ts';
    const absPath = join(repoDir, testFile);
    await mkdir(join(repoDir, 'src'), { recursive: true });
    await writeFile(absPath, 'export function foo() { return 42; }\n', 'utf8');
    await memory.recordFact(testFile, 'foo returns 42');

    await memory.writeState({
      goal: 'Upgrade math utils',
      acceptanceCriteria: ['foo returns 42', 'bar returns 84'],
      plan: ['Fix foo', 'Implement bar'],
      doneItems: [],
      nextAction: 'Implement bar',
      depth: 2,
    });

    const context = await memory.buildFreshContext({
      inheritedRules: ['Preserve all comments', 'No secret leakage'],
      subGoal: 'Implement bar() in foo.ts',
      targetFiles: [
        {
          path: testFile,
          content: 'export function foo() { return 42; }\n',
          symbols: ['foo'],
        },
      ],
      tokenBudget: 6000,
    });

    expect(context.prompt).toContain('# Core Invariants & Rules');
    expect(context.prompt).toContain('1. Preserve all comments');
    expect(context.prompt).toContain('**Sub-Problem Goal:** Implement bar() in foo.ts');
    expect(context.prompt).toContain('# Verified Codebase Facts');
    expect(context.prompt).toContain('foo returns 42');
    expect(context.prompt).toContain('### File: `src/foo.ts` (symbols: foo)');
    expect(context.estimatedTokens).toBeGreaterThan(0);
    expect(context.estimatedTokens).toBeLessThan(6000);
  });
});
