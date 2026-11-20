import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopeTree } from '../../../../src/agent/recursive/scope-tree.js';
import { defaultBudgetCurve } from '../../../../src/agent/recursive/types.js';
import { computeDiffHash } from '../../../../src/agent/recursive/return-contract.js';

describe('ScopeTree', () => {
  let tempDir: string;
  let repoDir: string;
  let tree: ScopeTree;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omnexx-tree-temp-'));
    repoDir = await mkdtemp(join(tmpdir(), 'omnexx-tree-repo-'));
    tree = new ScopeTree('Optimize compiler loop', ['Compile under 500ms'], {
      storageDir: tempDir,
      repoRoot: repoDir,
      baseBudget: 32_000,
    });
    await tree.initRoot();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('calculates the shrinking budget curve by depth correctly', () => {
    expect(defaultBudgetCurve(0, 32_000)).toBe(32_000);
    expect(defaultBudgetCurve(1, 32_000)).toBe(12_000);
    expect(defaultBudgetCurve(2, 32_000)).toBe(6_000);
    expect(defaultBudgetCurve(3, 32_000)).toBe(4_000);
    expect(defaultBudgetCurve(4, 32_000)).toBe(4_000);
  });

  it('spawns child scope with smaller budget and inherited rules verbatim', async () => {
    await mkdir(join(repoDir, 'src'), { recursive: true });
    await writeFile(join(repoDir, 'src/parser.ts'), 'export function parse() {}\n');
    await writeFile(join(repoDir, 'src/emitter.ts'), 'export function emit() {}\n');

    const parentMem = tree.getMemory(tree.root.id);
    await parentMem.recordFact('src/parser.ts', 'Uses recursive descent');
    await parentMem.recordFact('src/emitter.ts', 'Emits x86 assembly');

    const { node: child, request } = await tree.spawnChild(tree.root.id, {
      subGoal: 'Speed up lexer and parser',
      targetFiles: ['src/parser.ts'],
    });

    expect(child.depth).toBe(1);
    expect(child.budget).toBe(12_000);
    expect(request.budget).toBe(12_000);
    expect(request.inheritedRules).toEqual(tree.inheritedRules);

    // Only relevant facts for src/parser.ts are passed down; src/emitter.ts is excluded
    expect(request.relevantFacts).toHaveLength(1);
    expect(request.relevantFacts[0]?.file).toBe('src/parser.ts');
  });

  it('spawns grandchild scope with leaf budget (6,000 tokens)', async () => {
    const { node: child } = await tree.spawnChild(tree.root.id, {
      subGoal: 'Sub-problem',
      targetFiles: ['src/a.ts'],
    });

    const { node: grandchild } = await tree.spawnChild(child.id, {
      subGoal: 'Narrow symbol optimization',
      targetFiles: ['src/a.ts'],
      targetSymbols: ['tokenize'],
    });

    expect(grandchild.depth).toBe(2);
    expect(grandchild.budget).toBe(6_000);
    expect(child.children).toHaveLength(1);
    expect(child.children[0]?.id).toBe(grandchild.id);
  });

  it('splits scope by failing test cleanly', async () => {
    const { node, request } = await tree.splitByFailingTest(
      tree.root.id,
      'test/parser.test.ts',
      'Unexpected token ";" at line 14',
      ['src/parser.ts'],
    );

    expect(node.goal).toContain('test/parser.test.ts');
    expect(request.targetFiles).toContain('test/parser.test.ts');
    expect(request.targetFiles).toContain('src/parser.ts');
    expect(request.acceptanceCriteria[0]).toContain('test/parser.test.ts must pass');
  });

  it('records compact ReturnContract into scope node', () => {
    const diff = '--- a/foo.ts\n+++ b/foo.ts';
    tree.recordResult(tree.root.id, {
      scopeId: tree.root.id,
      status: 'solved',
      diff,
      diffHash: computeDiffHash(diff),
      facts: [],
    });

    expect(tree.root.result?.status).toBe('solved');
    expect(tree.root.result?.diff).toBe(diff);
  });
});
