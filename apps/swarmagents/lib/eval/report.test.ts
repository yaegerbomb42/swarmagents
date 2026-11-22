import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { aggregateReport, compareReports } from "./comparator";
import { renderMarkdownReport, writeParetoReport } from "./report";
import type { EvalTrialResult, HarnessConfig } from "./types";

const config: HarnessConfig = { name: "baseline", profile: "baseline", modelTier: "strong" };

function trial(taskId: string, resolved: boolean): EvalTrialResult {
  return {
    taskId,
    bucket: "surgical",
    configName: "baseline",
    trial: 1,
    metrics: {
      resolved,
      partialScore: resolved ? 1 : 0,
      totalTurns: 8,
      totalInputTokens: 1600,
      cachedInputTokens: 900,
      totalOutputTokens: 400,
      estimatedUsdCost: 0.01,
      wallClockMs: 100,
      rewindsTriggered: 0,
      cacheHitRate: 0.56,
      toolErrorRate: 0,
    },
    grading: { passed: resolved ? 2 : 0, failed: resolved ? 0 : 2, total: 2 },
  };
}

test("markdown report contains the summary, buckets and per-task rows", () => {
  const report = aggregateReport(
    [trial("task-a", true), trial("task-b", false)],
    config,
    1
  );
  const md = renderMarkdownReport(report);
  assert.match(md, /Harness Eval Report — baseline/);
  assert.match(md, /Solve rate \(pass@1\)/);
  assert.match(md, /task-a/);
  assert.match(md, /task-b/);
  assert.match(md, /## By bucket/);
  assert.match(md, /## Per task/);
});

test("markdown report with a comparison shows the verdict", () => {
  const a = aggregateReport([trial("task-a", true)], config, 1);
  const b = aggregateReport(
    [trial("task-a", false)],
    { ...config, name: "candidate", profile: "broken" },
    1
  );
  const cmp = compareReports(a, b);
  const md = renderMarkdownReport(b, cmp);
  assert.match(md, /REGRESSION/);
  assert.match(md, /solve rate fell/);
});

test("writeParetoReport writes JSON and markdown that round-trip", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = aggregateReport([trial("task-a", true)], config, 1);
  const b = aggregateReport(
    [trial("task-a", true)],
    { ...config, name: "candidate" },
    1
  );
  const cmp = compareReports(a, b);
  const { jsonPath, markdownPath } = await writeParetoReport(dir, a, b, cmp);
  const parsed = JSON.parse(await readFile(jsonPath, "utf8"));
  assert.equal(parsed.baseline.configName, "baseline");
  assert.equal(parsed.candidate.configName, "candidate");
  assert.equal(parsed.comparison.regression, false);
  const md = await readFile(markdownPath, "utf8");
  assert.match(md, /Harness Eval Report — baseline/);
  assert.match(md, /Harness Eval Report — candidate/);
});
