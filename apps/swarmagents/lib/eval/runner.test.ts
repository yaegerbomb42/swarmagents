import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import os from "node:os";
import { EVAL_SUITE } from "./suite";
import { HarnessEvalRunner, LocalTempIsolation, type IsolationDriver } from "./runner";
import { aggregateReport } from "./comparator";

const baseline = { name: "baseline", profile: "baseline" as const, modelTier: "strong" as const };

async function leakedRunDirs(): Promise<string[]> {
  const entries = await readdir(os.tmpdir());
  return entries.filter((e) => e.startsWith("swarm-eval-"));
}

test("runSuite executes all 15 tasks and every baseline trial resolves", async () => {
  const runner = new HarnessEvalRunner();
  const before = await leakedRunDirs();
  const results = await runner.runSuite(baseline, { trialsPerTask: 1 });
  assert.equal(results.length, 15);
  assert.equal(new Set(results.map((r) => r.taskId)).size, 15);
  for (const result of results) {
    assert.equal(result.metrics.resolved, true, `${result.taskId} should resolve under baseline`);
    assert.equal(result.grading.failed, 0);
  }
  const report = aggregateReport(results, baseline, 1);
  assert.equal(report.solveRate, 1);
  assert.equal(report.tasksRun, 15);
  assert.equal(report.byBucket.surgical.tasks, 5);
  assert.equal(report.byBucket.feature.tasks, 5);
  assert.equal(report.byBucket["long-horizon"].tasks, 5);
  const after = await leakedRunDirs();
  assert.deepEqual(after, before, "no run directory may leak");
});

test("trial metrics are deterministic except wall clock", async () => {
  const runner = new HarnessEvalRunner();
  const task = EVAL_SUITE[0];
  const first = await runner.runTask(task, baseline, 1);
  const second = await runner.runTask(task, baseline, 1);
  const { wallClockMs: _w1, ...m1 } = first.result.metrics;
  const { wallClockMs: _w2, ...m2 } = second.result.metrics;
  assert.deepEqual(m1, m2);
});

test("a broken config resolves nothing", async () => {
  const runner = new HarnessEvalRunner();
  const results = await runner.runSuite(
    { name: "broken", profile: "broken", modelTier: "strong" },
    { trialsPerTask: 1 }
  );
  const report = aggregateReport(results, { name: "broken", profile: "broken", modelTier: "strong" }, 1);
  assert.equal(report.solveRate, 0);
});

test("teardown failure is a hard error, not a silent leak", async () => {
  const leaky: IsolationDriver = {
    create: (taskId, trial) => new LocalTempIsolation().create(taskId, trial),
    destroy: async () => {
      // Deliberately do nothing: the directory survives.
    },
  };
  const runner = new HarnessEvalRunner({ isolation: leaky });
  await assert.rejects(
    runner.runTask(EVAL_SUITE[0], baseline, 1),
    /teardown failed/
  );
  // Clean up the leaked directory the test just created.
  for (const dir of await leakedRunDirs()) {
    const { rm } = await import("node:fs/promises");
    await rm(`${os.tmpdir()}/${dir}`, { recursive: true, force: true });
  }
});
