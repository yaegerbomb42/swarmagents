import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EVAL_SUITE } from "./suite";
import { HarnessEvalRunner, LocalTempIsolation, type IsolationDriver } from "./runner";
import { aggregateReport } from "./comparator";

const baseline = { name: "baseline", profile: "baseline" as const, modelTier: "strong" as const };

/** A dedicated isolation root for one test: the leak check must see only this test's directories, never another concurrent eval run's in-flight directories in the shared tmpdir. */
async function isolationRoot(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-eval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function leakedRunDirs(root: string): Promise<string[]> {
  const entries = await readdir(root);
  return entries.filter((e) => e.startsWith("swarm-eval-"));
}

test("runSuite executes all 15 tasks and every baseline trial resolves", async (t) => {
  const root = await isolationRoot(t);
  const runner = new HarnessEvalRunner({ isolation: new LocalTempIsolation(root) });
  const before = await leakedRunDirs(root);
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
  const after = await leakedRunDirs(root);
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

test("teardown failure is a hard error, not a silent leak", async (t) => {
  const root = await isolationRoot(t);
  const leaky: IsolationDriver = {
    create: (taskId, trial) => new LocalTempIsolation(root).create(taskId, trial),
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
  for (const dir of await leakedRunDirs(root)) {
    await rm(path.join(root, dir), { recursive: true, force: true });
  }
});
