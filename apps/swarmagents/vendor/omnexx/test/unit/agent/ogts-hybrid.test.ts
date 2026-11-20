/**
 * OGTS (Phase 7, Steps 7.6–7.7) tests: hybrid verifier cascade + budget tier governor.
 *
 * Everything external is an injected stub: the static/adversarial checks
 * record their calls, the differential verifier maps patch-diff markers to
 * scripted matrix verdicts, and the EF scorer maps markers to plausibility
 * scores. No real model calls and no real test runs happen here.
 */
import { describe, expect, it } from 'vitest';
import {
  CASCADE_TIERS,
  DEFAULT_TOP_N,
  hybridScore,
  rankByHybrid,
  rankFinalists,
  runCascade,
  unavailableAdversarialCheck,
  type ExecutionFreeScorer,
  type ScoredFinalist,
  type StaticCheck,
  type TierCheckResult,
  type TierOutcome,
} from '../../../src/agent/ogts/hybrid-verifier.js';
import {
  BUDGET_TIERS,
  NOISE_GUARD_PRECISION,
  TIER_L_SPEC,
  TIER_M_SPEC,
  TIER_S_SPEC,
  classifyTier,
  governBudget,
  specForTier,
  tierSearchBounds,
} from '../../../src/agent/ogts/budget.js';
import type { DifferentialVerifier } from '../../../src/agent/ogts/rollout.js';
import type {
  DifferentialMatrixResult,
  DifferentialVerdict,
  RegressionFailure,
} from '../../../src/verify/differential-tdr.js';

/** Narrow `T | null | undefined` to `T`, failing the test with a message when absent. */
function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be defined`);
  }
  return value;
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

function makeMatrixResult(
  verdict: DifferentialVerdict,
  regressions: readonly RegressionFailure[] = [],
): DifferentialMatrixResult {
  return {
    verdict,
    baseSha: 'base',
    reproTestPath: 'test/repro.test.ts',
    runs: {},
    regressions,
    flaky: [],
  };
}

const PASS_MATRIX = makeMatrixResult({ status: 'pass' });

/** A tier check that always returns `outcome` and records every diff it sees. */
function stubCheck(outcome: TierOutcome, calls: string[], detail = ''): StaticCheck {
  return {
    check(candidateDiff: string): Promise<TierCheckResult> {
      calls.push(candidateDiff);
      return Promise.resolve(detail === '' ? { outcome } : { outcome, detail });
    },
  };
}

/** A verifier that maps a marker line in the diff to a scripted matrix result. */
function markerVerifier(results: ReadonlyMap<string, DifferentialMatrixResult>): {
  verifier: DifferentialVerifier;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    verifier: {
      verify(candidateDiff: string): Promise<DifferentialMatrixResult> {
        calls.push(candidateDiff);
        // Match the marker line exactly (`+MARKER`): a substring match would
        // false-positive on diff headers (`--- a/file.ts`) and added lines.
        const lines = candidateDiff.split('\n');
        for (const [marker, result] of results) {
          if (lines.includes(`+${marker}`)) {
            return Promise.resolve(result);
          }
        }
        throw new Error(`no stub matrix result for diff: ${candidateDiff.slice(0, 40)}`);
      },
    },
  };
}

/** An EF scorer that maps a marker line in the diff to a scripted score. */
function markerEfScorer(scores: ReadonlyMap<string, number>): ExecutionFreeScorer {
  return {
    score(candidateDiff: string): Promise<number> {
      const lines = candidateDiff.split('\n');
      for (const [marker, score] of scores) {
        if (lines.includes(`+${marker}`)) {
          return Promise.resolve(score);
        }
      }
      throw new Error(`no stub EF score for diff: ${candidateDiff.slice(0, 40)}`);
    },
  };
}

describe('runCascade', () => {
  it('fails at the static tier and stops before the verifier', async () => {
    const staticCalls: string[] = [];
    const adversarialCalls: string[] = [];
    const { verifier, calls: verifierCalls } = markerVerifier(new Map([['x', PASS_MATRIX]]));
    const verdict = await runCascade(makeDiff(2, 0, 'x'), {
      staticCheck: stubCheck('fail', staticCalls, 'parse error'),
      verifier,
      adversarialCheck: stubCheck('pass', adversarialCalls),
    });
    expect(verdict.outcome).toBe('fail');
    expect(verdict.failedTier).toBe('static');
    expect(verdict.reason).toContain('static');
    expect(verdict.tierResults).toHaveLength(1);
    expect(verdict.tierResults[0]?.tier).toBe('static');
    expect(staticCalls).toHaveLength(1);
    expect(verifierCalls).toHaveLength(0);
    expect(adversarialCalls).toHaveLength(0);
  });

  it('continues past an unavailable static tier and reports incomplete', async () => {
    const { verifier, calls: verifierCalls } = markerVerifier(new Map([['x', PASS_MATRIX]]));
    const verdict = await runCascade(makeDiff(2, 0, 'x'), {
      staticCheck: stubCheck('unavailable', []),
      verifier,
    });
    expect(verdict.outcome).toBe('incomplete');
    expect(verdict.failedTier).toBeUndefined();
    expect(verdict.unavailableTiers).toEqual(['static', 'adversarial']);
    expect(verdict.tierResults).toHaveLength(4);
    expect(verifierCalls).toHaveLength(1);
  });

  it('fails at the repro tier on reject_repro and runs the matrix once', async () => {
    const staticCalls: string[] = [];
    const adversarialCalls: string[] = [];
    const { verifier, calls: verifierCalls } = markerVerifier(
      new Map([['x', makeMatrixResult({ status: 'reject_repro', reason: 'passed-on-baseline' })]]),
    );
    const verdict = await runCascade(makeDiff(2, 0, 'x'), {
      staticCheck: stubCheck('pass', staticCalls),
      verifier,
      adversarialCheck: stubCheck('pass', adversarialCalls),
    });
    expect(verdict.outcome).toBe('fail');
    expect(verdict.failedTier).toBe('repro');
    expect(verdict.reason).toContain('reject_repro');
    expect(verdict.tierResults).toHaveLength(2);
    expect(verifierCalls).toHaveLength(1);
    expect(adversarialCalls).toHaveLength(0);
  });

  it('fails at the repro tier on reject_fix', async () => {
    const { verifier } = markerVerifier(
      new Map([['x', makeMatrixResult({ status: 'reject_fix', reason: 'failed-after-patch' })]]),
    );
    const verdict = await runCascade(makeDiff(2, 0, 'x'), {
      staticCheck: stubCheck('pass', []),
      verifier,
    });
    expect(verdict.outcome).toBe('fail');
    expect(verdict.failedTier).toBe('repro');
  });

  it('fails at the regression tier on reject_regression using the same matrix run', async () => {
    const adversarialCalls: string[] = [];
    const { verifier, calls: verifierCalls } = markerVerifier(
      new Map([['x', makeMatrixResult({ status: 'reject_regression' })]]),
    );
    const verdict = await runCascade(makeDiff(2, 0, 'x'), {
      staticCheck: stubCheck('pass', []),
      verifier,
      adversarialCheck: stubCheck('pass', adversarialCalls),
    });
    expect(verdict.outcome).toBe('fail');
    expect(verdict.failedTier).toBe('regression');
    expect(verdict.tierResults).toHaveLength(3);
    expect(verifierCalls).toHaveLength(1);
    expect(adversarialCalls).toHaveLength(0);
  });

  it('fails at the regression tier when the regression list is non-empty', async () => {
    const { verifier } = markerVerifier(
      new Map([
        ['x', makeMatrixResult({ status: 'pass' }, [{ id: 't1', message: 'new failure' }])],
      ]),
    );
    const verdict = await runCascade(makeDiff(2, 0, 'x'), {
      staticCheck: stubCheck('pass', []),
      verifier,
      adversarialCheck: stubCheck('pass', []),
    });
    expect(verdict.outcome).toBe('fail');
    expect(verdict.failedTier).toBe('regression');
    expect(verdict.reason).toContain('1 new failures');
  });

  it('passes all tiers when every check passes', async () => {
    const { verifier } = markerVerifier(new Map([['x', PASS_MATRIX]]));
    const verdict = await runCascade(makeDiff(2, 0, 'x'), {
      staticCheck: stubCheck('pass', []),
      verifier,
      adversarialCheck: stubCheck('pass', []),
    });
    expect(verdict.outcome).toBe('pass');
    expect(verdict.tierResults).toHaveLength(4);
    expect(verdict.tierResults.map((r) => r.tier)).toEqual([
      'static',
      'repro',
      'regression',
      'adversarial',
    ]);
    expect(verdict.tierResults.every((r) => r.outcome === 'pass')).toBe(true);
    expect(verdict.unavailableTiers).toEqual([]);
  });

  it('reports incomplete when only the adversarial tier is unavailable', async () => {
    const { verifier } = markerVerifier(new Map([['x', PASS_MATRIX]]));
    const verdict = await runCascade(makeDiff(2, 0, 'x'), {
      staticCheck: stubCheck('pass', []),
      verifier,
    });
    expect(verdict.outcome).toBe('incomplete');
    expect(verdict.failedTier).toBeUndefined();
    expect(verdict.unavailableTiers).toEqual(['adversarial']);
    expect(verdict.tierResults[3]?.outcome).toBe('unavailable');
  });

  it('fails at the adversarial tier when it decisively fails', async () => {
    const { verifier } = markerVerifier(new Map([['x', PASS_MATRIX]]));
    const verdict = await runCascade(makeDiff(2, 0, 'x'), {
      staticCheck: stubCheck('pass', []),
      verifier,
      adversarialCheck: stubCheck('fail', [], 'edge case crashed'),
    });
    expect(verdict.outcome).toBe('fail');
    expect(verdict.failedTier).toBe('adversarial');
    expect(verdict.reason).toContain('edge case crashed');
  });

  it('exposes the default adversarial check as unavailable, never a fake pass', async () => {
    const result = await unavailableAdversarialCheck.check(makeDiff(2));
    expect(result.outcome).toBe('unavailable');
    expect(result.detail).toContain('AdverMCTS');
  });

  it('evaluates tiers in the documented order', () => {
    expect(CASCADE_TIERS).toEqual(['static', 'repro', 'regression', 'adversarial']);
  });
});

describe('hybridScore and rankByHybrid', () => {
  it('adds EF and EB, clamped to 0–2', () => {
    expect(hybridScore(0.75, 0.5)).toBe(1.25);
    expect(hybridScore(1.5, 0.5)).toBe(1.5);
    expect(hybridScore(-0.5, 0.25)).toBe(0.25);
  });

  it('breaks hybrid ties by higher EB', () => {
    const a: ScoredFinalist = {
      patchDiff: makeDiff(2, 0, 'a'),
      efScore: 0.75,
      ebScore: 0.5,
      hybridScore: 1.25,
    };
    const b: ScoredFinalist = {
      patchDiff: makeDiff(2, 0, 'b'),
      efScore: 0.5,
      ebScore: 0.75,
      hybridScore: 1.25,
    };
    const ranked = rankByHybrid([a, b]);
    expect(ranked[0]).toBe(b);
    expect(ranked[1]).toBe(a);
  });

  it('breaks full ties by lower diff churn and keeps input order otherwise', () => {
    const small: ScoredFinalist = {
      patchDiff: makeDiff(2, 0, 'small'),
      efScore: 0.5,
      ebScore: 0.5,
      hybridScore: 1,
    };
    const big: ScoredFinalist = {
      patchDiff: makeDiff(10, 0, 'big'),
      efScore: 0.5,
      ebScore: 0.5,
      hybridScore: 1,
    };
    const input = [big, small];
    const ranked = rankByHybrid(input);
    expect(ranked[0]).toBe(small);
    expect(ranked[1]).toBe(big);
    // rankByHybrid returns a new array and leaves the input order alone.
    expect(input[0]).toBe(big);
    expect(input[1]).toBe(small);
  });
});

describe('rankFinalists', () => {
  it('computes exact hybrid scores for a small candidate set', async () => {
    const diffs = [makeDiff(2, 0, 'a'), makeDiff(2, 0, 'b'), makeDiff(2, 0, 'c')];
    const { verifier } = markerVerifier(
      new Map([
        ['a', PASS_MATRIX],
        ['b', PASS_MATRIX],
        ['c', PASS_MATRIX],
      ]),
    );
    const ranked = await rankFinalists(diffs, {
      efScorer: markerEfScorer(
        new Map([
          ['a', 0.75],
          ['b', 0.5],
          ['c', 0.25],
        ]),
      ),
      verifier,
    });
    expect(ranked).toHaveLength(3);
    // Every candidate passes the matrix on a 2-line diff, so s_EB = 1.0.
    expect(must(ranked[0], 'first').hybridScore).toBe(1.75);
    expect(must(ranked[0], 'first').ebScore).toBe(1);
    expect(must(ranked[1], 'second').hybridScore).toBe(1.5);
    expect(must(ranked[2], 'third').hybridScore).toBe(1.25);
  });

  it('takes only the top n by EF and verifies only the finalists', async () => {
    const diffs = ['M_A', 'M_B', 'M_C', 'M_D', 'M_E'].map((m) => makeDiff(2, 0, m));
    const { verifier, calls: verifierCalls } = markerVerifier(
      new Map([
        ['M_A', PASS_MATRIX],
        ['M_B', PASS_MATRIX],
        ['M_C', PASS_MATRIX],
        ['M_D', PASS_MATRIX],
        ['M_E', PASS_MATRIX],
      ]),
    );
    const ranked = await rankFinalists(diffs, {
      efScorer: markerEfScorer(
        new Map([
          ['M_A', 0.9],
          ['M_B', 0.5],
          ['M_C', 0.75],
          ['M_D', 0.6],
          ['M_E', 0.8],
        ]),
      ),
      verifier,
      topN: 3,
    });
    expect(ranked).toHaveLength(3);
    // Top 3 by EF: M_A (0.9), M_E (0.8), M_C (0.75) — in hybrid order.
    expect(must(ranked[0], 'first').patchDiff).toContain('+M_A');
    expect(must(ranked[1], 'second').patchDiff).toContain('+M_E');
    expect(must(ranked[2], 'third').patchDiff).toContain('+M_C');
    expect(verifierCalls).toHaveLength(3);
    expect(verifierCalls.some((d) => d.includes('+M_B'))).toBe(false);
    expect(verifierCalls.some((d) => d.includes('+M_D'))).toBe(false);
  });

  it('defaults to the top 3 finalists', async () => {
    expect(DEFAULT_TOP_N).toBe(3);
    const diffs = ['a', 'b', 'c', 'd'].map((m) => makeDiff(2, 0, m));
    const { verifier, calls: verifierCalls } = markerVerifier(
      new Map([
        ['a', PASS_MATRIX],
        ['b', PASS_MATRIX],
        ['c', PASS_MATRIX],
        ['d', PASS_MATRIX],
      ]),
    );
    const ranked = await rankFinalists(diffs, {
      efScorer: markerEfScorer(
        new Map([
          ['a', 0.9],
          ['b', 0.8],
          ['c', 0.7],
          ['d', 0.6],
        ]),
      ),
      verifier,
    });
    expect(ranked).toHaveLength(3);
    expect(verifierCalls).toHaveLength(3);
  });

  it('returns an empty list for no candidates or topN 0', async () => {
    const { verifier, calls: verifierCalls } = markerVerifier(new Map());
    expect(
      await rankFinalists([], {
        efScorer: markerEfScorer(new Map()),
        verifier,
      }),
    ).toEqual([]);
    expect(
      await rankFinalists([makeDiff(2, 0, 'a')], {
        efScorer: markerEfScorer(new Map([['a', 0.5]])),
        verifier,
        topN: 0,
      }),
    ).toEqual([]);
    expect(verifierCalls).toHaveLength(0);
  });
});

describe('budget tiers', () => {
  it('exposes the briefed tier specs', () => {
    expect(TIER_S_SPEC).toEqual({
      tier: 'S',
      candidates: { min: 1, max: 1 },
      nodes: { min: 1, max: 1 },
    });
    expect(TIER_M_SPEC).toEqual({
      tier: 'M',
      candidates: { min: 4, max: 8 },
      nodes: { min: 10, max: 20 },
    });
    expect(TIER_L_SPEC).toEqual({
      tier: 'L',
      candidates: { min: 16, max: 32 },
      nodes: { min: 30, max: 60 },
    });
    expect(BUDGET_TIERS).toHaveLength(3);
    expect(specForTier('S')).toBe(TIER_S_SPEC);
    expect(specForTier('M')).toBe(TIER_M_SPEC);
    expect(specForTier('L')).toBe(TIER_L_SPEC);
  });

  it('classifies S above 0.65', () => {
    expect(classifyTier(0.8, 'low')).toBe('S');
    expect(classifyTier(0.66, 'high')).toBe('S');
    expect(classifyTier(1, 'low')).toBe('S');
  });

  it('classifies M in the middle band and at both boundaries', () => {
    expect(classifyTier(0.5, 'low')).toBe('M');
    expect(classifyTier(0.5, 'high')).toBe('M');
    expect(classifyTier(0.65, 'low')).toBe('M');
    expect(classifyTier(0.65, 'high')).toBe('M');
    expect(classifyTier(0.35, 'low')).toBe('M');
    expect(classifyTier(0.35, 'high')).toBe('M');
  });

  it('classifies L only below 0.35 with high task value', () => {
    expect(classifyTier(0.2, 'high')).toBe('L');
    expect(classifyTier(0.34, 'high')).toBe('L');
    expect(classifyTier(0, 'high')).toBe('L');
    expect(classifyTier(0.2, 'low')).toBe('M');
    expect(classifyTier(0.34, 'low')).toBe('M');
  });

  it('locks to Tier S when verifier precision is below 0.70', () => {
    expect(NOISE_GUARD_PRECISION).toBe(0.7);
    expect(governBudget({ passAt1: 0.2, taskValue: 'high', verifierPrecision: 0.69 }).tier).toBe(
      'S',
    );
    expect(governBudget({ passAt1: 0.2, taskValue: 'high', verifierPrecision: 0 }).tier).toBe('S');
    expect(governBudget({ passAt1: 0.8, taskValue: 'low', verifierPrecision: 0.5 }).tier).toBe('S');
  });

  it('does not lock when precision is at or above 0.70, or unmeasured', () => {
    expect(governBudget({ passAt1: 0.2, taskValue: 'high', verifierPrecision: 0.7 }).tier).toBe(
      'L',
    );
    expect(governBudget({ passAt1: 0.2, taskValue: 'high', verifierPrecision: 0.99 }).tier).toBe(
      'L',
    );
    expect(governBudget({ passAt1: 0.2, taskValue: 'high' }).tier).toBe('L');
    expect(governBudget({ passAt1: 0.5, taskValue: 'low' }).tier).toBe('M');
  });

  it('maps tiers to search bounds, clamped to the engine caps', () => {
    expect(tierSearchBounds('S')).toEqual({
      desired: { maxNodes: 1, maxBranching: 1 },
      effective: { maxNodes: 1, maxBranching: 1 },
    });
    expect(tierSearchBounds('M')).toEqual({
      desired: { maxNodes: 20, maxBranching: 3 },
      effective: { maxNodes: 12, maxBranching: 3 },
    });
    expect(tierSearchBounds('L')).toEqual({
      desired: { maxNodes: 60, maxBranching: 3 },
      effective: { maxNodes: 12, maxBranching: 3 },
    });
  });
});
