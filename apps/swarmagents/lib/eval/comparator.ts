// Aggregation, bootstrap confidence intervals, and the Pareto gate.
//
// Statistics are task-level: each task contributes one observation (its
// pass rate across trials), so a config that fixes one more task moves the
// solve rate by 1/15. Bootstrap resampling is seeded, so the same report
// pair always yields the same intervals — CI runs are reproducible.

import { mulberry32 } from "./driver";
import type {
  EvalBucket,
  EvalReport,
  EvalTaskAggregate,
  EvalTrialResult,
  HarnessConfig,
  ParetoComparison,
} from "./types";
import { PARETO_SOLVE_RATE_DROP_MAX, PARETO_TOKEN_RISE_MAX } from "./types";

const BOOTSTRAP_RESAMPLES = 1000;
const DEFAULT_SEED = 20261122;

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1)
  );
  return sortedAsc[idx];
}

/**
 * Bootstrap 95% CI for the mean of `values`, resampling with replacement.
 * Seeded, so identical inputs give identical intervals.
 */
export function bootstrapMeanCi95(
  values: number[],
  seed: number = DEFAULT_SEED,
  resamples: number = BOOTSTRAP_RESAMPLES
): [number, number] {
  if (values.length === 0) return [0, 0];
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      sum += values[Math.floor(rand() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [
    percentile(means, 2.5),
    percentile(means, 97.5),
  ];
}

/** Bootstrap 95% CI for (candidate - baseline) on paired task observations. */
export function bootstrapDiffCi95(
  baseline: number[],
  candidate: number[],
  seed: number = DEFAULT_SEED,
  resamples: number = BOOTSTRAP_RESAMPLES
): [number, number] {
  if (baseline.length === 0 || baseline.length !== candidate.length) return [0, 0];
  const rand = mulberry32(seed);
  const diffs: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let bSum = 0;
    let cSum = 0;
    for (let j = 0; j < baseline.length; j++) {
      const idx = Math.floor(rand() * baseline.length);
      bSum += baseline[idx];
      cSum += candidate[idx];
    }
    diffs.push((cSum - bSum) / baseline.length);
  }
  diffs.sort((a, b) => a - b);
  return [percentile(diffs, 2.5), percentile(diffs, 97.5)];
}

const BUCKETS: EvalBucket[] = ["surgical", "feature", "long-horizon"];

function aggregateTask(
  taskId: string,
  bucket: EvalBucket,
  trials: EvalTrialResult[]
): EvalTaskAggregate {
  const m = trials.map((t) => t.metrics);
  const turns = m.map((x) => x.totalTurns).sort((a, b) => a - b);
  return {
    taskId,
    bucket,
    trials: trials.length,
    passRate: mean(m.map((x) => (x.resolved ? 1 : 0))),
    meanTotalTokens: mean(m.map((x) => x.totalInputTokens + x.totalOutputTokens)),
    meanInputTokens: mean(m.map((x) => x.totalInputTokens)),
    meanOutputTokens: mean(m.map((x) => x.totalOutputTokens)),
    meanCostUsd: mean(m.map((x) => x.estimatedUsdCost)),
    meanTurns: mean(m.map((x) => x.totalTurns)),
    p50Turns: percentile(turns, 50),
    p95Turns: percentile(turns, 95),
    meanCacheHitRate: mean(m.map((x) => x.cacheHitRate)),
    meanToolErrorRate: mean(m.map((x) => x.toolErrorRate)),
  };
}

export function aggregateReport(
  results: EvalTrialResult[],
  config: HarnessConfig,
  trialsPerTask: number,
  seed: number = DEFAULT_SEED
): EvalReport {
  const byTask = new Map<string, EvalTrialResult[]>();
  for (const r of results) {
    const list = byTask.get(r.taskId) ?? [];
    list.push(r);
    byTask.set(r.taskId, list);
  }
  const perTask: EvalTaskAggregate[] = [...byTask.entries()].map(([taskId, trials]) =>
    aggregateTask(taskId, trials[0].bucket, trials)
  );
  perTask.sort((a, b) => a.taskId.localeCompare(b.taskId));

  const solveRate = mean(perTask.map((t) => t.passRate));
  const byBucket = {} as EvalReport["byBucket"];
  for (const bucket of BUCKETS) {
    const inBucket = perTask.filter((t) => t.bucket === bucket);
    byBucket[bucket] = {
      tasks: inBucket.length,
      solveRate: mean(inBucket.map((t) => t.passRate)),
      meanTotalTokens: mean(inBucket.map((t) => t.meanTotalTokens)),
      meanTurns: mean(inBucket.map((t) => t.meanTurns)),
    };
  }

  return {
    configName: config.name,
    profile: config.profile,
    modelTier: config.modelTier,
    trialsPerTask,
    tasksRun: perTask.length,
    solveRate,
    meanTotalTokens: mean(perTask.map((t) => t.meanTotalTokens)),
    meanCostUsd: mean(perTask.map((t) => t.meanCostUsd)),
    meanTurns: mean(perTask.map((t) => t.meanTurns)),
    byBucket,
    perTask,
    solveRateCi95: bootstrapMeanCi95(
      perTask.map((t) => t.passRate),
      seed
    ),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The Pareto gate. A candidate regresses when the solve rate drops by more
 * than 2% OR token burn rises by more than 15% without a statistically
 * significant solve-rate gain (bootstrap 95% CI on the solve-rate
 * difference excludes 0 on the positive side).
 */
export function compareReports(
  baseline: EvalReport,
  candidate: EvalReport,
  seed: number = DEFAULT_SEED
): ParetoComparison {
  const baselineByTask = new Map(baseline.perTask.map((t) => [t.taskId, t]));
  const pairedBaseline: number[] = [];
  const pairedCandidate: number[] = [];
  for (const ct of candidate.perTask) {
    const bt = baselineByTask.get(ct.taskId);
    if (!bt) continue;
    pairedBaseline.push(bt.passRate);
    pairedCandidate.push(ct.passRate);
  }
  const solveRateDiffCi95 = bootstrapDiffCi95(pairedBaseline, pairedCandidate, seed);
  const significantSolveGain = solveRateDiffCi95[0] > 0;

  const solveRateDelta = candidate.solveRate - baseline.solveRate;
  const solveRateDrop = baseline.solveRate - candidate.solveRate;
  const tokenDeltaFrac =
    baseline.meanTotalTokens === 0
      ? 0
      : (candidate.meanTotalTokens - baseline.meanTotalTokens) / baseline.meanTotalTokens;

  const reasons: string[] = [];
  if (solveRateDrop > PARETO_SOLVE_RATE_DROP_MAX) {
    reasons.push(
      `solve rate fell ${(solveRateDrop * 100).toFixed(1)}% (>${(PARETO_SOLVE_RATE_DROP_MAX * 100).toFixed(0)}% allowed)`
    );
  }
  if (tokenDeltaFrac > PARETO_TOKEN_RISE_MAX && !significantSolveGain) {
    reasons.push(
      `token burn rose ${(tokenDeltaFrac * 100).toFixed(1)}% (>${(PARETO_TOKEN_RISE_MAX * 100).toFixed(0)}% allowed) with no significant solve-rate gain`
    );
  }

  const perBucket = BUCKETS.map((bucket) => ({
    bucket,
    solveRateDelta:
      candidate.byBucket[bucket].solveRate - baseline.byBucket[bucket].solveRate,
    tokenDeltaFrac:
      baseline.byBucket[bucket].meanTotalTokens === 0
        ? 0
        : (candidate.byBucket[bucket].meanTotalTokens -
            baseline.byBucket[bucket].meanTotalTokens) /
          baseline.byBucket[bucket].meanTotalTokens,
  }));

  return {
    baseline: baseline.configName,
    candidate: candidate.configName,
    solveRateDelta,
    solveRateDrop,
    tokenDeltaFrac,
    solveRateDiffCi95,
    significantSolveGain,
    regression: reasons.length > 0,
    reasons,
    perBucket,
  };
}
