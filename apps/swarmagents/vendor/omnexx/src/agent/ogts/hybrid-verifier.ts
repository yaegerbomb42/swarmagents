/**
 * Step 7.6 — Oracle-Guided Tree Search: the 4-tier hybrid verifier cascade.
 *
 * Roadmap mapping: this file covers roadmap Step 7.6 (Hybrid Verifier
 * Cascade, `src/agent/search/oracle.ts` + `ranker.ts`). The brief's paths
 * (`src/agent/ogts/hybrid-verifier.ts`) are used instead; the cascade tiers,
 * the early-termination rule, and the `s_H = Top_n(s_EF) + s_EB` formula are
 * the roadmap's.
 *
 * The cascade, in order:
 *
 *   1. Static parse/compile — is there a real entry point? No: `src/verify`
 *      has no patch-scoped static check. `diagnostics.ts` only normalizes
 *      diagnostics produced elsewhere, and `gates.ts` runs whole-repo
 *      configured shell gates (`runGate` needs a `GateConfig` + logs dir —
 *      the wrong shape for a per-patch tier). So this tier is injected-only
 *      (`StaticCheck`); when no implementation is provided it reports
 *      `unavailable`, never a fake pass.
 *   2. Targeted reproduction — the differential matrix (`DifferentialVerifier`
 *      from `rollout.ts`, production: `createDifferentialVerifier` in
 *      `search.ts`). Fails when the verdict is `reject_repro` (symptom does
 *      not reproduce on baseline) or `reject_fix` (repro still fails after
 *      the patch).
 *   3. P2P regression — the SAME matrix run as tier 2 (one verification per
 *      candidate, not two). Fails when the verdict is `reject_regression`
 *      or the regression list is non-empty.
 *   4. Generated adversarial edge cases (AdverMCTS check) — no such
 *      generator exists in the repo, so the default reports `unavailable`
 *      (never a fake pass). The real AdverMCTS generator is a follow-up.
 *
 * Early termination: the cascade stops at the first tier that decisively
 * fails and reports it (`failedTier` + `reason`). An `unavailable` tier is
 * NOT a failure — the cascade continues past it and records it — but the
 * overall outcome is then `incomplete` rather than `pass`, so an
 * unavailable tier can never be mistaken for a passed one. `tierResults`
 * lists only the tiers actually evaluated, in order.
 *
 * Hybrid score: `s_H = Top_n(s_EF) + s_EB`.
 *
 *   - `s_EF` (Execution-Free) is model plausibility for the patch, 0–1. It
 *     is a model call, so it is an injected `ExecutionFreeScorer`; there is
 *     no default scorer.
 *   - `s_EB` (Execution-Based) is the regression score from the
 *     differential-matrix result, computed by `value.ts` (`scoreOracle` over
 *     `oracleResultFromMatrix`), 0–1.
 *   - `Top_n` selects the n highest-`s_EF` candidates (default n = 3) as
 *     finalists; only finalists are verified for `s_EB`. `s_H = s_EF + s_EB`,
 *     range 0–2. Ranking is by `s_H` descending; ties break by higher
 *     `s_EB`, then by lower diff churn (`countDiffLines`), then by input
 *     order (stable sort).
 *
 * All I/O sits behind the injected interfaces. This module is NOT wired
 * into the agent loop, the beam search, or any CLI — engine plus tests only.
 */

import type { DifferentialMatrixResult } from '../../verify/differential-tdr.js';
import type { DifferentialVerifier } from './rollout.js';
import { countDiffLines, oracleResultFromMatrix, scoreOracle } from './value.js';

/** Default finalist count for `Top_n` in `rankFinalists`. */
export const DEFAULT_TOP_N = 3;

/** Cascade tiers, in evaluation order. */
export type CascadeTierName = 'static' | 'repro' | 'regression' | 'adversarial';

/** The tier order, exported so callers and tests can rely on it. */
export const CASCADE_TIERS: readonly CascadeTierName[] = [
  'static',
  'repro',
  'regression',
  'adversarial',
];

/** A tier's outcome: passed, decisively failed, or could not run. */
export type TierOutcome = 'pass' | 'fail' | 'unavailable';

/** Result of one tier check. `detail` carries the human-readable cause. */
export interface TierCheckResult {
  outcome: TierOutcome;
  detail?: string;
}

/** One evaluated tier in a cascade result. */
export interface TierResult {
  tier: CascadeTierName;
  outcome: TierOutcome;
  detail?: string;
}

/**
 * Static parse/compile check for one candidate patch diff. Injected: no
 * patch-scoped static check exists in `src/verify` (see the file header).
 */
export interface StaticCheck {
  check(candidateDiff: string): Promise<TierCheckResult>;
}

/**
 * Generated adversarial edge-case check (AdverMCTS) for one candidate patch
 * diff. Injected: no such generator exists in the repo yet.
 */
export interface AdversarialCheck {
  check(candidateDiff: string): Promise<TierCheckResult>;
}

/**
 * The default adversarial check: always `unavailable`. A patch must never
 * be credited with passing a check that did not run.
 */
export const unavailableAdversarialCheck: AdversarialCheck = {
  check(): Promise<TierCheckResult> {
    return Promise.resolve({
      outcome: 'unavailable',
      detail: 'AdverMCTS generator not implemented (roadmap 7.6 follow-up)',
    });
  },
};

export interface CascadeDeps {
  /** Tier 1. Absent → the tier reports `unavailable`. */
  staticCheck?: StaticCheck;
  /** Tiers 2–3. Run once per candidate; both tiers read the same result. */
  verifier: DifferentialVerifier;
  /** Tier 4. Defaults to `unavailableAdversarialCheck`. */
  adversarialCheck?: AdversarialCheck;
}

/** Overall cascade outcome. `incomplete` = no tier failed, but at least one tier could not run. */
export type CascadeOutcome = 'pass' | 'fail' | 'incomplete';

/** Result of running the 4-tier cascade on one candidate patch. */
export interface HybridVerdict {
  outcome: CascadeOutcome;
  /** Tiers actually evaluated, in order (a prefix when the cascade stopped early). */
  tierResults: readonly TierResult[];
  /** The tier that decisively failed, when `outcome` is `fail`. */
  failedTier?: CascadeTierName;
  /** Human-readable cause of the failure, when `outcome` is `fail`. */
  reason?: string;
  /** Tiers that could not run (each also appears in `tierResults`). */
  unavailableTiers: readonly CascadeTierName[];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Run the 4-tier cascade on one candidate patch diff. Tiers run in order and
 * the cascade stops at the first decisive failure. The differential matrix
 * is run once (at the repro tier); the regression tier reads the same result.
 */
export async function runCascade(candidateDiff: string, deps: CascadeDeps): Promise<HybridVerdict> {
  const tierResults: TierResult[] = [];
  const unavailableTiers: CascadeTierName[] = [];

  const fail = (failedTier: CascadeTierName, reason: string): HybridVerdict => ({
    outcome: 'fail',
    tierResults,
    failedTier,
    reason,
    unavailableTiers,
  });
  const finish = (): HybridVerdict => ({
    outcome: unavailableTiers.length > 0 ? 'incomplete' : 'pass',
    tierResults,
    unavailableTiers,
  });

  // Tier 1: static parse/compile.
  if (deps.staticCheck !== undefined) {
    const result = await deps.staticCheck.check(candidateDiff);
    tierResults.push({
      tier: 'static',
      outcome: result.outcome,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    });
    if (result.outcome === 'fail') {
      return fail('static', `static check failed: ${result.detail ?? 'no detail'}`);
    }
    if (result.outcome === 'unavailable') {
      unavailableTiers.push('static');
    }
  } else {
    tierResults.push({
      tier: 'static',
      outcome: 'unavailable',
      detail: 'no static check provided (no patch-scoped static entry point in src/verify)',
    });
    unavailableTiers.push('static');
  }

  // Tiers 2–3: one differential-matrix run drives both.
  const matrix: DifferentialMatrixResult = await deps.verifier.verify(candidateDiff);

  // Tier 2: targeted reproduction. `reject_repro` = symptom does not
  // reproduce on baseline; `reject_fix` = repro still fails after the patch.
  const reproFailed =
    matrix.verdict.status === 'reject_repro' || matrix.verdict.status === 'reject_fix';
  tierResults.push({
    tier: 'repro',
    outcome: reproFailed ? 'fail' : 'pass',
    detail: `differential verdict: ${matrix.verdict.status}`,
  });
  if (reproFailed) {
    return fail('repro', `targeted reproduction failed: ${matrix.verdict.status}`);
  }

  // Tier 3: P2P regression. `pass` implies an empty regression list; check
  // the list explicitly so a non-empty list can never slip through.
  const regressionFailed =
    matrix.verdict.status === 'reject_regression' || matrix.regressions.length > 0;
  tierResults.push({
    tier: 'regression',
    outcome: regressionFailed ? 'fail' : 'pass',
    detail: `${String(matrix.regressions.length)} new failures on the patched tree`,
  });
  if (regressionFailed) {
    return fail(
      'regression',
      `P2P regression: ${String(matrix.regressions.length)} new failures on the patched tree`,
    );
  }

  // Tier 4: generated adversarial edge cases.
  const adversarial = deps.adversarialCheck ?? unavailableAdversarialCheck;
  const adversarialResult = await adversarial.check(candidateDiff);
  tierResults.push({
    tier: 'adversarial',
    outcome: adversarialResult.outcome,
    ...(adversarialResult.detail !== undefined ? { detail: adversarialResult.detail } : {}),
  });
  if (adversarialResult.outcome === 'fail') {
    return fail(
      'adversarial',
      `adversarial edge cases failed: ${adversarialResult.detail ?? 'no detail'}`,
    );
  }
  if (adversarialResult.outcome === 'unavailable') {
    unavailableTiers.push('adversarial');
  }

  return finish();
}

/**
 * Execution-Free scorer: model plausibility for a candidate patch diff, 0–1.
 * A model call, so it is injected; there is no default scorer.
 */
export interface ExecutionFreeScorer {
  score(candidateDiff: string): Promise<number>;
}

/** One finalist with both scores and their hybrid sum. */
export interface ScoredFinalist {
  patchDiff: string;
  /** Execution-Free plausibility, 0–1. */
  efScore: number;
  /** Execution-Based regression score from `value.ts`, 0–1. */
  ebScore: number;
  /** `s_H = s_EF + s_EB`, range 0–2. */
  hybridScore: number;
}

export interface RankFinalistsDeps {
  efScorer: ExecutionFreeScorer;
  /** Runs the differential matrix for each finalist to derive `s_EB`. */
  verifier: DifferentialVerifier;
  /** Finalist count; defaults to `DEFAULT_TOP_N` (3). */
  topN?: number;
}

/** Hybrid score: `s_H = s_EF + s_EB`, range 0–2. Inputs are clamped to 0–1 first. */
export function hybridScore(efScore: number, ebScore: number): number {
  return clamp01(efScore) + clamp01(ebScore);
}

/**
 * Rank finalists best-first: `s_H` descending, ties by higher `s_EB`, then
 * by lower diff churn, then by input order (stable sort). Returns a new array.
 */
export function rankByHybrid(finalists: readonly ScoredFinalist[]): ScoredFinalist[] {
  return [...finalists].sort((a, b) => {
    if (b.hybridScore !== a.hybridScore) {
      return b.hybridScore - a.hybridScore;
    }
    if (b.ebScore !== a.ebScore) {
      return b.ebScore - a.ebScore;
    }
    const churnA = countDiffLines(a.patchDiff);
    const churnB = countDiffLines(b.patchDiff);
    return churnA - churnB;
  });
}

/**
 * Rank candidates by the hybrid score. Scores every candidate with the EF
 * scorer, takes the top `n` by `s_EF` as finalists, verifies each finalist
 * once through the differential matrix for `s_EB` (via `value.ts`), and
 * returns the finalists ranked by `s_H`. Non-finalists are never verified.
 */
export async function rankFinalists(
  candidates: readonly string[],
  deps: RankFinalistsDeps,
): Promise<ScoredFinalist[]> {
  const topN = Math.max(0, Math.floor(deps.topN ?? DEFAULT_TOP_N));
  if (candidates.length === 0 || topN === 0) {
    return [];
  }
  const efScored = await Promise.all(
    candidates.map(async (patchDiff) => ({
      patchDiff,
      efScore: clamp01(await deps.efScorer.score(patchDiff)),
    })),
  );
  const finalists = [...efScored].sort((a, b) => b.efScore - a.efScore).slice(0, topN);
  const scored: ScoredFinalist[] = [];
  for (const finalist of finalists) {
    const matrix = await deps.verifier.verify(finalist.patchDiff);
    const ebScore = scoreOracle(oracleResultFromMatrix(matrix), finalist.patchDiff);
    scored.push({
      patchDiff: finalist.patchDiff,
      efScore: finalist.efScore,
      ebScore,
      hybridScore: hybridScore(finalist.efScore, ebScore),
    });
  }
  return rankByHybrid(scored);
}
