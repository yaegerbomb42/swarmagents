/**
 * Step 7.2 — Oracle-Guided Tree Search: candidate value scoring.
 *
 * Roadmap mapping: the brief's Step 7.2 is the simplified form of roadmap
 * Step 7.2 (Search Engine Dispatcher, `src/agent/search/engine.ts`), which
 * scores states with a Best-First priority (`V(s) + λ·novelty(s) − μ·cost(s)`)
 * and PUCT. This file implements the brief's additive oracle score instead:
 * rewards from the differential matrix verdict plus penalties for diff churn
 * and repeated syntax errors. No novelty term, no PUCT — those are follow-ups.
 *
 * Score range: 0–1 (clamped). Additive breakdown, before clamping:
 *
 *   +0.3  pre-patch repro failure   (the repro test fails on baseline, as required)
 *   +0.4  post-patch repro pass     (the repro test passes after the patch)
 *   +0.3  zero baseline regression delta (no new failures on the patched tree)
 *   −0.1  per 100 lines of diff churn over 100 lines, capped at −0.3
 *   −0.1  per syntax error (including a patch that did not apply), capped at −0.3
 *
 * The oracle input is derived from the real differential matrix
 * (`src/verify/differential-tdr.ts`), not invented:
 *
 *   - "pre-patch repro failure"  = verdict is anything other than `reject_repro`
 *     (Run 1 failed on baseline, so the symptom reproduces).
 *   - "post-patch repro pass"    = verdict is `pass` or `reject_regression`
 *     (Run 2 ran and passed; the regression gate is only reached after Run 2 passes).
 *   - "zero regression delta"    = verdict is `pass` (which implies
 *     `regressions.length === 0`).
 *   - "syntax errors"            = failures on the post-patch / regression runs
 *     whose id or message matches a syntax-error pattern (see below), plus one
 *     for a patch that did not apply (`reject_fix` / `patch-did-not-apply`).
 *     The matrix reports failures as `{ id, message }` pairs; it has no
 *     dedicated syntax-error field, so detection is textual and documented.
 */

import type {
  DifferentialMatrixResult,
  DifferentialVerdict,
  RegressionFailure,
} from '../../verify/differential-tdr.js';
import type { Failure } from '../../verify/parsers/types.js';
import type { SearchNode } from './tree.js';

/** Reward when the repro test fails on the baseline (symptom reproduces). */
export const REPRO_FAILURE_REWARD = 0.3;
/** Reward when the repro test passes after the patch. */
export const REPRO_PASS_REWARD = 0.4;
/** Reward when the patched tree introduces no new failures. */
export const NO_REGRESSION_REWARD = 0.3;
/** Diff lines above this threshold start attracting the churn penalty. */
export const CHURN_THRESHOLD_LINES = 100;
/** Churn penalty per full 100 lines over the threshold. */
export const CHURN_PENALTY_PER_100_LINES = 0.1;
/** Maximum churn penalty. */
export const CHURN_PENALTY_CAP = 0.3;
/** Penalty per syntax error. */
export const SYNTAX_ERROR_PENALTY = 0.1;
/** Maximum syntax-error penalty. */
export const SYNTAX_ERROR_PENALTY_CAP = 0.3;

/**
 * What the differential matrix actually reports, reduced to the signals the
 * scorer needs. Build it from a real matrix result with
 * {@link oracleResultFromMatrix}; tests may construct it literally.
 */
export interface OracleResult {
  /** The 4-way gate verdict from `runDifferentialMatrix`. */
  verdict: DifferentialVerdict;
  /** New failures on the patched tree (empty when the regression delta is zero). */
  regressions: readonly RegressionFailure[];
  /**
   * Failures observed on the post-patch repro / regression runs, deduplicated
   * by id. Used only for syntax-error counting.
   */
  failures: readonly Failure[];
  /** True when the candidate patch failed to apply to the worktree. */
  patchDidNotApply: boolean;
}

/** Additive breakdown of a score (see the file header). */
export interface ScoreBreakdown {
  reproFailure: number;
  reproPass: number;
  noRegression: number;
  churnPenalty: number;
  syntaxPenalty: number;
  /** Final score, clamped to 0–1. */
  total: number;
}

/**
 * Map a real differential-matrix result to the scorer's oracle input.
 * Failures from the post-patch repro run and the patched regression run are
 * merged and deduplicated by id (the same failure can appear in both runs).
 */
export function oracleResultFromMatrix(result: DifferentialMatrixResult): OracleResult {
  const byId = new Map<string, Failure>();
  const postPatchFailures = result.runs.postPatch?.failures ?? [];
  const regressionFailures = result.runs.regressionPatched?.failures ?? [];
  for (const failure of [...postPatchFailures, ...regressionFailures]) {
    if (!byId.has(failure.id)) {
      byId.set(failure.id, failure);
    }
  }
  return {
    verdict: result.verdict,
    regressions: result.regressions,
    failures: [...byId.values()],
    patchDidNotApply:
      result.verdict.status === 'reject_fix' && result.verdict.reason === 'patch-did-not-apply',
  };
}

/**
 * Count added + removed lines in a unified diff. Header lines (`+++`/`---`)
 * and `\ No newline at end of file` markers are not counted.
 */
export function countDiffLines(patchDiff: string): number {
  let lines = 0;
  for (const line of patchDiff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      lines += 1;
    }
  }
  return lines;
}

/**
 * A failure counts as a syntax error when its id or message names one.
 * TypeScript syntax diagnostics are `TS1xxx` codes, which appear in failure
 * ids as `file:TS1234:msg`; the message patterns cover parser reports from
 * other toolchains (`SyntaxError`, `parse error`, `unexpected token`).
 */
const SYNTAX_ERROR_PATTERN = /syntax\s*error|parse\s*error|unexpected\s+token|TS1\d{3}/i;

export function isSyntaxError(failure: Failure): boolean {
  return SYNTAX_ERROR_PATTERN.test(failure.id) || SYNTAX_ERROR_PATTERN.test(failure.message);
}

/** Number of syntax errors among `failures`. */
export function countSyntaxErrors(failures: readonly Failure[]): number {
  let count = 0;
  for (const failure of failures) {
    if (isSyntaxError(failure)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Score a candidate from its oracle result and patch diff. Equivalent to
 * `scoreCandidate(node, oracle)` with the diff taken from the node.
 */
export function scoreOracle(oracle: OracleResult, patchDiff: string): number {
  return scoreBreakdown(oracle, patchDiff).total;
}

/** Additive breakdown of a candidate's score (see the file header). */
export function scoreBreakdown(oracle: OracleResult, patchDiff: string): ScoreBreakdown {
  const reproFailure = oracle.verdict.status !== 'reject_repro' ? REPRO_FAILURE_REWARD : 0;
  const reproPass =
    oracle.verdict.status === 'pass' || oracle.verdict.status === 'reject_regression'
      ? REPRO_PASS_REWARD
      : 0;
  const noRegression = oracle.verdict.status === 'pass' ? NO_REGRESSION_REWARD : 0;

  const churn = countDiffLines(patchDiff);
  const over = Math.max(0, churn - CHURN_THRESHOLD_LINES);
  const churnPenalty = Math.min(
    CHURN_PENALTY_CAP,
    Math.floor(over / 100) * CHURN_PENALTY_PER_100_LINES,
  );

  const syntaxCount = countSyntaxErrors(oracle.failures) + (oracle.patchDidNotApply ? 1 : 0);
  const syntaxPenalty = Math.min(SYNTAX_ERROR_PENALTY_CAP, syntaxCount * SYNTAX_ERROR_PENALTY);

  const total = Math.min(
    1,
    Math.max(0, reproFailure + reproPass + noRegression - churnPenalty - syntaxPenalty),
  );
  return { reproFailure, reproPass, noRegression, churnPenalty, syntaxPenalty, total };
}

/**
 * Score the candidate at `node` from its oracle result. The node's
 * `patchDiff` supplies the diff-churn penalty; everything else comes from the
 * oracle. Returns a number in 0–1.
 */
export function scoreCandidate(node: SearchNode, oracle: OracleResult): number {
  return scoreOracle(oracle, node.patchDiff);
}
