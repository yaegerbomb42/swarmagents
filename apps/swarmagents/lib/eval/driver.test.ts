import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EVAL_SUITE } from "./suite";
import {
  MockReplayDriver,
  estimateCostUsd,
  hashSeed,
  mulberry32,
  parseTap,
  transcriptFor,
} from "./driver";

const surgical = EVAL_SUITE.find((t) => t.bucket === "surgical")!;
const longTask = EVAL_SUITE.find((t) => t.bucket === "long-horizon")!;

test("hashSeed and mulberry32 are deterministic", () => {
  assert.equal(hashSeed("abc"), hashSeed("abc"));
  assert.notEqual(hashSeed("abc"), hashSeed("abd"));
  const a = mulberry32(42);
  const b = mulberry32(42);
  assert.equal(a(), b());
  assert.equal(a(), b());
});

test("parseTap counts only top-level ok/not ok lines", () => {
  const tap = [
    "TAP version 13",
    "ok 1 - first",
    "not ok 2 - second",
    "    ok 1 - subtest (indented, not counted)",
    "# pass 1",
    "# fail 1",
  ].join("\n");
  assert.deepEqual(parseTap(tap), { passed: 1, failed: 1, total: 2 });
  assert.deepEqual(parseTap(""), { passed: 0, failed: 0, total: 0 });
});

test("transcriptFor is deterministic per task + profile", () => {
  const a = transcriptFor(surgical, "baseline");
  const b = transcriptFor(surgical, "baseline");
  assert.deepEqual(a, b);
  assert.notEqual(
    transcriptFor(surgical, "baseline").inputTokens,
    transcriptFor(longTask, "baseline").inputTokens
  );
});

test("wasteful profile burns more tokens with a worse cache hit rate than baseline", () => {
  const base = transcriptFor(surgical, "baseline");
  const wasteful = transcriptFor(surgical, "wasteful");
  assert.ok(wasteful.turns > base.turns);
  assert.ok(wasteful.inputTokens > base.inputTokens * 1.5);
  assert.ok(
    wasteful.cachedInputTokens / wasteful.inputTokens <
      base.cachedInputTokens / base.inputTokens
  );
  assert.equal(base.apply, "solution");
  assert.equal(wasteful.apply, "solution");
  assert.equal(transcriptFor(surgical, "broken").apply, "broken");
});

test("turn targets respect bucket budgets", () => {
  for (const task of EVAL_SUITE) {
    const t = transcriptFor(task, "baseline");
    assert.ok(t.turns <= task.targetTurns, `${task.id}: ${t.turns} turns`);
    assert.ok(t.turns >= 4, `${task.id}: ${t.turns} turns`);
  }
});

test("estimateCostUsd prices strong above cheap", () => {
  const strong = estimateCostUsd(1_000_000, 1_000_000, "strong");
  const cheap = estimateCostUsd(1_000_000, 1_000_000, "cheap");
  assert.equal(strong, 18);
  assert.equal(cheap, 2);
  assert.ok(strong > cheap);
});

test("mock driver resolves a baseline run and fails a broken run", async (t) => {
  const driver = new MockReplayDriver();
  const config = { name: "baseline", profile: "baseline" as const, modelTier: "strong" as const };

  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-driver-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { metrics, grading } = await driver.run(surgical, config, dir);
  assert.equal(metrics.resolved, true);
  assert.equal(metrics.partialScore, 1);
  assert.equal(grading.failed, 0);
  assert.ok(grading.passed > 0);
  assert.ok(metrics.totalTurns > 0);
  assert.ok(metrics.totalInputTokens > 0);
  assert.ok(metrics.cacheHitRate > 0.4);
  assert.ok(metrics.wallClockMs >= 0);
  assert.ok(metrics.estimatedUsdCost > 0);

  const dir2 = await mkdtemp(path.join(os.tmpdir(), "eval-driver-"));
  t.after(() => rm(dir2, { recursive: true, force: true }));
  const broken = await driver.run(
    surgical,
    { name: "broken", profile: "broken", modelTier: "strong" },
    dir2
  );
  assert.equal(broken.metrics.resolved, false);
  assert.ok(broken.metrics.partialScore < 1);
  assert.ok(broken.grading.failed > 0);
});

test("mock driver records observed tool errors in toolErrorRate", async (t) => {
  const driver = new MockReplayDriver();
  // Find a task whose baseline transcript has at least one tool error.
  const task = EVAL_SUITE.find(
    (candidate) => transcriptFor(candidate, "baseline").toolErrors > 0
  );
  if (!task) {
    t.skip("no task with scripted baseline tool errors");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-driver-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { metrics } = await driver.run(
    task,
    { name: "baseline", profile: "baseline", modelTier: "strong" },
    dir
  );
  assert.ok(metrics.toolErrorRate > 0);
  assert.ok(metrics.toolErrorRate < 1);
});
