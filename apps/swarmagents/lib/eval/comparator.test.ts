import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateReport,
  bootstrapDiffCi95,
  bootstrapMeanCi95,
  compareReports,
  mean,
  percentile,
} from "./comparator";
import type { EvalReport, EvalTrialResult, HarnessConfig } from "./types";

const baselineConfig: HarnessConfig = { name: "baseline", profile: "baseline", modelTier: "strong" };

function trial(taskId: string, resolved: boolean, totalTokens = 2000): EvalTrialResult {
  return {
    taskId,
    bucket: "surgical",
    configName: "baseline",
    trial: 1,
    metrics: {
      resolved,
      partialScore: resolved ? 1 : 0,
      totalTurns: 8,
      totalInputTokens: Math.round(totalTokens * 0.8),
      cachedInputTokens: Math.round(totalTokens * 0.8 * 0.56),
      totalOutputTokens: Math.round(totalTokens * 0.2),
      estimatedUsdCost: 0.01,
      wallClockMs: 100,
      rewindsTriggered: 0,
      cacheHitRate: 0.56,
      toolErrorRate: 0,
    },
    grading: { passed: resolved ? 2 : 0, failed: resolved ? 0 : 2, total: 2 },
  };
}

function fakeReport(
  solveRates: number[],
  meanTokens = 2000,
  name = "baseline"
): EvalReport {
  const results = solveRates.map((rate, i) =>
    trial(`task-${i}`, rate >= 1, meanTokens)
  );
  // trial() only encodes 0/1; rebuild pass rates directly through aggregates.
  const report = aggregateReport(results, { ...baselineConfig, name }, 1);
  // Override the aggregated solve rate to the requested per-task rates.
  const perTask = report.perTask.map((t, i) => ({ ...t, passRate: solveRates[i] }));
  return {
    ...report,
    configName: name,
    solveRate: mean(solveRates),
    perTask,
    byBucket: {
      surgical: {
        tasks: solveRates.length,
        solveRate: mean(solveRates),
        meanTotalTokens: meanTokens,
        meanTurns: 8,
      },
      feature: { tasks: 0, solveRate: 0, meanTotalTokens: 0, meanTurns: 0 },
      "long-horizon": { tasks: 0, solveRate: 0, meanTotalTokens: 0, meanTurns: 0 },
    },
  };
}

test("mean and percentile", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([], 50), 0);
});

test("bootstrap CIs are deterministic for the same seed", () => {
  const values = [1, 0, 1, 1, 0, 1, 0, 1, 1, 1];
  assert.deepEqual(bootstrapMeanCi95(values, 7), bootstrapMeanCi95(values, 7));
  assert.deepEqual(bootstrapDiffCi95(values, values, 7), bootstrapDiffCi95(values, values, 7));
});

test("bootstrap CI on identical distributions includes zero", () => {
  const values = [1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1];
  const [lo, hi] = bootstrapDiffCi95(values, values);
  assert.ok(lo <= 0 && hi >= 0, `CI [${lo}, ${hi}] must include 0`);
});

test("bootstrap CI on clearly better distributions excludes zero", () => {
  const bad = new Array(15).fill(0);
  const good = new Array(15).fill(1);
  const [lo] = bootstrapDiffCi95(bad, good);
  assert.ok(lo > 0, `CI lower bound ${lo} must be > 0`);
});

test("identical reports are not a regression", () => {
  const a = fakeReport([1, 1, 1, 0, 1]);
  const b = fakeReport([1, 1, 1, 0, 1], 2000, "candidate");
  const cmp = compareReports(a, b);
  assert.equal(cmp.regression, false);
  assert.deepEqual(cmp.reasons, []);
});

test("a solve-rate drop over 2% is a regression", () => {
  const a = fakeReport(new Array(15).fill(1));
  const b = fakeReport(
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    2000,
    "candidate"
  );
  const cmp = compareReports(a, b);
  assert.equal(cmp.regression, true);
  assert.ok(cmp.reasons.some((r) => r.includes("solve rate")));
});

test("a token rise over 15% with no solve gain is a regression", () => {
  const a = fakeReport(new Array(15).fill(1));
  const b = fakeReport(new Array(15).fill(1), 2400, "candidate");
  const cmp = compareReports(a, b);
  assert.equal(cmp.regression, true);
  assert.ok(cmp.reasons.some((r) => r.includes("token burn")));
});

test("a token rise under 15% is not a regression", () => {
  const a = fakeReport(new Array(15).fill(1));
  const b = fakeReport(new Array(15).fill(1), 2200, "candidate");
  const cmp = compareReports(a, b);
  assert.equal(cmp.regression, false);
});

test("a token rise over 15% with a significant solve gain is not a regression", () => {
  const a = fakeReport(new Array(15).fill(0));
  const b = fakeReport(new Array(15).fill(1), 2400, "candidate");
  const cmp = compareReports(a, b);
  assert.equal(cmp.significantSolveGain, true);
  assert.equal(cmp.regression, false);
});

test("aggregateReport computes pass@1, means and p50/p95", () => {
  const results = [
    trial("task-a", true),
    trial("task-a", false),
    trial("task-b", true),
  ];
  const report = aggregateReport(results, baselineConfig, 2);
  assert.equal(report.tasksRun, 2);
  assert.equal(report.solveRate, 0.75);
  const taskA = report.perTask.find((t) => t.taskId === "task-a")!;
  assert.equal(taskA.passRate, 0.5);
  assert.equal(taskA.trials, 2);
  assert.equal(taskA.meanTotalTokens, 2000);
});
