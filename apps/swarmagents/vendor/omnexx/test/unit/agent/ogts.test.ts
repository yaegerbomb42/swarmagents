/**
 * OGTS (Phase 7, Steps 7.1–7.4) tests.
 *
 * The differential verifier and the candidate generator are injected stubs:
 * the verifier maps patch-diff markers to matrix verdicts, and the generator
 * returns scripted diff queues. No real model calls and no real test runs
 * happen here — the production verifier (`createDifferentialVerifier`) is
 * exercised by the Step 5.5 suite instead.
 */
import { describe, expect, it } from 'vitest';
import {
  SearchTree,
  MAX_BRANCHING,
  MAX_DEPTH,
  MAX_NODES,
  type SearchNode,
} from '../../../src/agent/ogts/tree.js';
import {
  countDiffLines,
  countSyntaxErrors,
  oracleResultFromMatrix,
  scoreBreakdown,
  scoreCandidate,
  type OracleResult,
} from '../../../src/agent/ogts/value.js';
import {
  isPruningVerdict,
  rolloutStep,
  type CandidateGenerator,
  type DifferentialVerifier,
} from '../../../src/agent/ogts/rollout.js';
import { beamSearch } from '../../../src/agent/ogts/search.js';
import type {
  DifferentialMatrixResult,
  DifferentialVerdict,
} from '../../../src/verify/differential-tdr.js';
import type { Failure } from '../../../src/verify/parsers/types.js';

/** Narrow `T | null | undefined` to `T`, failing the test with a message when absent. */
function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be defined`);
  }
  return value;
}

function childWithDiff(lines: number): SearchNode {
  const tree = makeTree();
  return must(tree.addChild(tree.root.id, makeDiff(lines), 1), 'child');
}

function makeTree(): SearchTree {
  return new SearchTree({ label: 'root', steps: 0 });
}

/** Unified diff with `added` added lines, `removed` removed lines, plus one marker line. */
function makeDiff(added: number, removed = 0, marker = ''): string {
  const lines: string[] = ['--- a/file.ts', '+++ b/file.ts', '@@ -1,1 +1,1 @@'];
  if (marker !== '') {
    lines.push(`+${marker}`);
  }
  for (let i = 0; i < added; i++) {
    lines.push(`+added line ${String(i)}`);
  }
  for (let i = 0; i < removed; i++) {
    lines.push(`-removed line ${String(i)}`);
  }
  return lines.join('\n');
}

function matrixResult(
  verdict: DifferentialVerdict,
  runs: DifferentialMatrixResult['runs'] = {},
  regressions: DifferentialMatrixResult['regressions'] = [],
): DifferentialMatrixResult {
  return {
    verdict,
    baseSha: 'abc123',
    reproTestPath: 'test/repro.test.ts',
    runs,
    regressions,
    flaky: [],
  };
}

function oracle(
  verdict: DifferentialVerdict,
  failures: readonly Failure[] = [],
  patchDidNotApply = false,
  regressions: OracleResult['regressions'] = [],
): OracleResult {
  return { verdict, regressions, failures, patchDidNotApply };
}

/** Verifier stub: the verdict is chosen by a marker substring in the diff. */
function verdictFor(diff: string): DifferentialVerdict {
  if (diff.includes('BAD-REPRO')) {
    return { status: 'reject_repro', reason: 'passed-on-baseline' };
  }
  if (diff.includes('BAD-FIX')) {
    return { status: 'reject_fix', reason: 'failed-after-patch' };
  }
  if (diff.includes('BAD-REG')) {
    return { status: 'reject_regression' };
  }
  return { status: 'pass' };
}

function markerVerifier(): DifferentialVerifier {
  return {
    verify: (diff: string): Promise<DifferentialMatrixResult> =>
      Promise.resolve(matrixResult(verdictFor(diff))),
  };
}

/** Generator stub: each `generate` call returns the next scripted queue. */
function scriptedGenerator(queues: string[][]): CandidateGenerator {
  let call = 0;
  return {
    generate: (_node: SearchNode, count: number): Promise<string[]> => {
      const queue = queues[call] ?? [];
      call += 1;
      return Promise.resolve(queue.slice(0, count));
    },
  };
}

describe('SearchTree', () => {
  it('creates a root with the briefed node state', () => {
    const tree = makeTree();
    expect(tree.root.id).toBe('n0');
    expect(tree.root.parentId).toBeNull();
    expect(tree.root.depth).toBe(0);
    expect(tree.root.state).toEqual({ label: 'root', steps: 0 });
    expect(tree.root.patchDiff).toBe('');
    expect(tree.root.cumulativeCost).toBe(0);
    expect(tree.root.visits).toBe(0);
    expect(tree.root.valueScore).toBe(0);
    expect(tree.nodeCount).toBe(1);
  });

  it('addChild links parent, depth, and cumulative cost', () => {
    const tree = makeTree();
    const child = must(tree.addChild(tree.root.id, makeDiff(2), 5), 'child');
    expect(child.parentId).toBe('n0');
    expect(child.depth).toBe(1);
    expect(child.cumulativeCost).toBe(5);
    expect(child.state.steps).toBe(1);
    expect(tree.getNode(child.id)).toBe(child);
    expect(tree.childrenOf(tree.root.id)).toEqual([child]);
    expect(tree.nodeCount).toBe(2);
  });

  it('refuses a fourth child (max branching factor 3)', () => {
    const tree = makeTree();
    for (let i = 0; i < MAX_BRANCHING; i++) {
      expect(tree.addChild(tree.root.id, makeDiff(1), 1)).not.toBeNull();
    }
    expect(tree.addChild(tree.root.id, makeDiff(1), 1)).toBeNull();
    expect(tree.nodeCount).toBe(1 + MAX_BRANCHING);
  });

  it('refuses expansion below max depth 4', () => {
    const tree = makeTree();
    let parent = tree.root;
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      parent = must(tree.addChild(parent.id, makeDiff(1), 1), 'child');
    }
    expect(parent.depth).toBe(MAX_DEPTH);
    expect(tree.addChild(parent.id, makeDiff(1), 1)).toBeNull();
  });

  it('refuses expansion once the tree holds 12 nodes', () => {
    const tree = makeTree();
    const queue: SearchNode[] = [tree.root];
    while (queue.length > 0 && tree.nodeCount < MAX_NODES) {
      const parent = must(queue.shift(), 'parent');
      for (let i = 0; i < MAX_BRANCHING && tree.nodeCount < MAX_NODES; i++) {
        const child = tree.addChild(parent.id, makeDiff(1), 1);
        if (child === null) {
          break;
        }
        queue.push(child);
      }
    }
    expect(tree.nodeCount).toBe(MAX_NODES);
    const leaf = must(tree.leafNodes().at(0), 'leaf');
    expect(leaf.depth).toBeLessThan(MAX_DEPTH);
    expect(tree.childrenOf(leaf.id)).toEqual([]);
    expect(tree.addChild(leaf.id, makeDiff(1), 1)).toBeNull();
  });

  it('bestPath picks the highest total value, ties broken by lowest cost', () => {
    const tree = makeTree();
    const a = must(tree.addChild(tree.root.id, makeDiff(1), 1), 'A');
    const b = must(tree.addChild(tree.root.id, makeDiff(1), 1), 'B');
    const a1 = must(tree.addChild(a.id, makeDiff(1), 1), 'A1');
    must(tree.addChild(b.id, makeDiff(1), 1), 'B1');
    tree.setScore(a.id, 0.5);
    tree.setScore(b.id, 0.9);
    tree.setScore(a1.id, 0.9);
    tree.setScore(must(tree.childrenOf(b.id).at(0), 'B1').id, 0.2);
    const path = must(tree.bestPath(), 'best path');
    expect(path.nodes.map((node) => node.id)).toEqual([tree.root.id, a.id, a1.id]);
    expect(path.totalValue).toBeCloseTo(1.4);
    expect(path.totalCost).toBe(2);
  });

  it('visit counts visits and setScore sets the score', () => {
    const tree = makeTree();
    tree.visit(tree.root.id);
    tree.visit(tree.root.id);
    expect(tree.root.visits).toBe(2);
    tree.setScore(tree.root.id, 0.75);
    expect(tree.root.valueScore).toBe(0.75);
  });
});

describe('scoreCandidate', () => {
  it('scores a clean pass at 1.0 (0.3 + 0.4 + 0.3)', () => {
    const tree = makeTree();
    expect(scoreCandidate(tree.root, oracle({ status: 'pass' }))).toBe(1);
  });

  it('scores reject_repro at 0 (no reward applies)', () => {
    const tree = makeTree();
    expect(
      scoreCandidate(tree.root, oracle({ status: 'reject_repro', reason: 'passed-on-baseline' })),
    ).toBe(0);
  });

  it('scores reject_fix at 0.3 (repro failed on baseline, fix did not land)', () => {
    const tree = makeTree();
    expect(
      scoreCandidate(tree.root, oracle({ status: 'reject_fix', reason: 'failed-after-patch' })),
    ).toBe(0.3);
  });

  it('scores reject_regression at 0.7 (repro pass, but new failures)', () => {
    const tree = makeTree();
    expect(scoreCandidate(tree.root, oracle({ status: 'reject_regression' }))).toBe(0.7);
  });

  it('penalises diff churn over 100 lines at 0.1 per 100 lines', () => {
    expect(scoreCandidate(childWithDiff(250), oracle({ status: 'pass' }))).toBeCloseTo(0.9);
    expect(scoreCandidate(childWithDiff(350), oracle({ status: 'pass' }))).toBeCloseTo(0.8);
    // Exactly at the threshold, and just under the next step, no penalty.
    expect(scoreCandidate(childWithDiff(100), oracle({ status: 'pass' }))).toBe(1);
    expect(scoreCandidate(childWithDiff(199), oracle({ status: 'pass' }))).toBe(1);
  });

  it('caps the churn penalty at 0.3', () => {
    const child = childWithDiff(650);
    expect(scoreCandidate(child, oracle({ status: 'pass' }))).toBeCloseTo(0.7);
    expect(scoreBreakdown(oracle({ status: 'pass' }), child.patchDiff).churnPenalty).toBe(0.3);
  });

  it('penalises each syntax error at 0.1', () => {
    const tree = makeTree();
    const failures: Failure[] = [
      { id: 'src/a.ts:TS1005:msg', message: "';' expected" },
      { id: 'src/b.ts', message: 'SyntaxError: unexpected token' },
    ];
    expect(scoreCandidate(tree.root, oracle({ status: 'pass' }, failures))).toBeCloseTo(0.8);
    // Non-syntax failures do not count.
    const plain: Failure[] = [{ id: 'test/x.test.ts', message: 'expected 1 to equal 2' }];
    expect(scoreCandidate(tree.root, oracle({ status: 'pass' }, plain))).toBe(1);
  });

  it('counts a patch that did not apply as one syntax error', () => {
    const tree = makeTree();
    expect(
      scoreCandidate(
        tree.root,
        oracle({ status: 'reject_fix', reason: 'patch-did-not-apply' }, [], true),
      ),
    ).toBeCloseTo(0.2);
  });

  it('caps the syntax-error penalty at 0.3 and clamps the score at 0', () => {
    const tree = makeTree();
    const failures: Failure[] = Array.from({ length: 5 }, (_, i) => ({
      id: `src/f${String(i)}.ts:TS1128:msg`,
      message: 'Declaration or statement expected',
    }));
    expect(countSyntaxErrors(failures)).toBe(5);
    expect(scoreCandidate(tree.root, oracle({ status: 'pass' }, failures))).toBeCloseTo(0.7);
    expect(
      scoreCandidate(
        tree.root,
        oracle({ status: 'reject_repro', reason: 'timed-out-on-baseline' }, failures),
      ),
    ).toBe(0);
  });

  it('counts diff lines excluding headers and no-newline markers', () => {
    expect(
      countDiffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n'),
    ).toBe(2);
    expect(countDiffLines('')).toBe(0);
  });
});

describe('oracleResultFromMatrix', () => {
  it('maps a pass result to a full-reward oracle', () => {
    const result = matrixResult({ status: 'pass' });
    const mapped = oracleResultFromMatrix(result);
    expect(mapped.verdict).toEqual({ status: 'pass' });
    expect(mapped.regressions).toEqual([]);
    expect(mapped.failures).toEqual([]);
    expect(mapped.patchDidNotApply).toBe(false);
  });

  it('merges and deduplicates failures across the post-patch runs', () => {
    const shared: Failure = { id: 'src/a.ts:TS1005:msg', message: "';' expected" };
    const result = matrixResult(
      { status: 'reject_fix', reason: 'failed-after-patch' },
      {
        postPatch: {
          label: 'patched',
          exitCode: 1,
          timedOut: false,
          durationMs: 10,
          failures: [shared, { id: 'test/t.test.ts', message: 'boom' }],
        },
        regressionPatched: {
          label: 'regression-patched',
          exitCode: 1,
          timedOut: false,
          durationMs: 10,
          failures: [shared],
        },
      },
    );
    const mapped = oracleResultFromMatrix(result);
    expect(mapped.failures).toHaveLength(2);
    expect(mapped.failures.map((f) => f.id)).toContain('src/a.ts:TS1005:msg');
  });

  it('flags a patch that did not apply', () => {
    const result = matrixResult({ status: 'reject_fix', reason: 'patch-did-not-apply' });
    expect(oracleResultFromMatrix(result).patchDidNotApply).toBe(true);
  });
});

describe('isPruningVerdict', () => {
  it('prunes all three reject verdicts and keeps pass', () => {
    expect(isPruningVerdict({ status: 'pass' })).toBe(false);
    expect(isPruningVerdict({ status: 'reject_repro', reason: 'passed-on-baseline' })).toBe(true);
    expect(isPruningVerdict({ status: 'reject_fix', reason: 'failed-after-patch' })).toBe(true);
    expect(isPruningVerdict({ status: 'reject_regression' })).toBe(true);
  });
});

describe('rolloutStep', () => {
  it('prunes reject_repro and reject_fix branches and keeps the passing one', async () => {
    const tree = makeTree();
    const generator = scriptedGenerator([
      [makeDiff(1, 0, 'GOOD-1'), makeDiff(1, 0, 'BAD-REPRO'), makeDiff(1, 0, 'BAD-FIX')],
    ]);
    const ranked = await rolloutStep(tree, tree.root, { generator, verifier: markerVerifier() });
    expect(ranked).toHaveLength(3);
    const [best, ...rest] = ranked;
    expect(must(best, 'best').pruned).toBe(false);
    expect(must(best, 'best').score).toBe(1);
    expect(must(best, 'best').node).not.toBeNull();
    expect(rest.every((candidate) => candidate.pruned && candidate.node === null)).toBe(true);
    expect(tree.nodeCount).toBe(2);
  });

  it('respects the requested beam width', async () => {
    const tree = makeTree();
    const generator = scriptedGenerator([
      [makeDiff(1, 0, 'GOOD-1'), makeDiff(1, 0, 'GOOD-2'), makeDiff(1, 0, 'GOOD-3')],
    ]);
    const ranked = await rolloutStep(tree, tree.root, {
      generator,
      verifier: markerVerifier(),
      beamWidth: 2,
    });
    expect(ranked).toHaveLength(2);
    expect(tree.nodeCount).toBe(3);
  });

  it('does not call the generator at max depth', async () => {
    const tree = makeTree();
    let parent = tree.root;
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      parent = must(tree.addChild(parent.id, makeDiff(1), 1), 'child');
    }
    let calls = 0;
    const generator: CandidateGenerator = {
      generate: (): Promise<string[]> => {
        calls += 1;
        return Promise.resolve([makeDiff(1)]);
      },
    };
    const ranked = await rolloutStep(tree, parent, { generator, verifier: markerVerifier() });
    expect(ranked).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('beamSearch', () => {
  it('expands the highest-scoring path and prunes the failed branches', async () => {
    const tree = makeTree();
    const generator = scriptedGenerator([
      [makeDiff(249, 0, 'CHURN-GOOD'), makeDiff(1, 0, 'GOOD'), makeDiff(1, 0, 'BAD-REPRO')],
      [makeDiff(1, 0, 'GOOD-2')],
      [],
    ]);
    const result = await beamSearch(tree, { generator, verifier: markerVerifier() });
    expect(result.prunedCount).toBe(1);
    expect(result.nodesExplored).toBe(4);
    const path = must(result.bestPath, 'best path');
    expect(path.nodes).toHaveLength(3);
    expect(path.totalValue).toBeCloseTo(2);
    expect(path.nodes.map((node) => node.patchDiff.includes('GOOD-2'))).toEqual([
      false,
      false,
      true,
    ]);
    expect(tree.root.visits).toBe(1);
  });

  it('stops when every candidate is pruned, best path is the root alone', async () => {
    const tree = makeTree();
    const generator = scriptedGenerator([[makeDiff(1, 0, 'BAD-REPRO'), makeDiff(1, 0, 'BAD-FIX')]]);
    const result = await beamSearch(tree, { generator, verifier: markerVerifier() });
    expect(result.prunedCount).toBe(2);
    expect(result.nodesExplored).toBe(2);
    expect(tree.nodeCount).toBe(1);
    const path = must(result.bestPath, 'best path');
    expect(path.nodes).toHaveLength(1);
    expect(path.totalValue).toBe(0);
  });

  it('respects the 12-node budget and terminates', async () => {
    const tree = makeTree();
    const generator: CandidateGenerator = {
      generate: (_node: SearchNode, count: number): Promise<string[]> => {
        const diffs: string[] = [];
        for (let i = 0; i < count; i++) {
          diffs.push(makeDiff(1, 0, 'GOOD'));
        }
        return Promise.resolve(diffs);
      },
    };
    const result = await beamSearch(tree, { generator, verifier: markerVerifier() });
    expect(tree.nodeCount).toBe(MAX_NODES);
    expect(result.nodesExplored).toBe(MAX_NODES - 1);
    expect(result.bestPath).not.toBeNull();
    expect(must(result.bestPath, 'best path').nodes).toHaveLength(MAX_DEPTH + 1);
  });
});
