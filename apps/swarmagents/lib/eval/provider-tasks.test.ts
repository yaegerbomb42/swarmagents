/**
 * Every provider-eval task must be gradeable: its verifier fails the
 * untouched setup (a no-op agent cannot pass) and passes the reference
 * solution (the task is solvable as specified). Hard tasks must also stay
 * hard enough to discriminate, so their verifiers are checked to cover more
 * than one behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderEvalRunner, type ProviderSpec } from "./provider-runner";
import { LocalTempIsolation } from "./runner";
import { HARD_PROVIDER_EVAL_TASKS, PROVIDER_EVAL_TASKS, STANDARD_PROVIDER_EVAL_TASKS } from "./provider-tasks";
import { ScriptedProviderExecutor } from "./provider-executor";
import { selectTasks } from "../../tools/eval-provider/run";

const spec: ProviderSpec = { providerId: "scripted", model: "model-x" };

async function runner(t: { after: (fn: () => Promise<void>) => void }, fail: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-eval-tasks-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new ProviderEvalRunner({
    isolation: new LocalTempIsolation(root),
    executor: new ScriptedProviderExecutor({ fail }),
  });
}

test("task ids are unique and the hard set is part of the suite", () => {
  const ids = PROVIDER_EVAL_TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(HARD_PROVIDER_EVAL_TASKS.length, 4);
  assert.equal(PROVIDER_EVAL_TASKS.length, STANDARD_PROVIDER_EVAL_TASKS.length + HARD_PROVIDER_EVAL_TASKS.length);
  for (const task of HARD_PROVIDER_EVAL_TASKS) assert.equal(task.difficulty, "hard", task.id);
});

for (const task of PROVIDER_EVAL_TASKS) {
  test(`${task.id}: the reference solution passes its verifier`, async (t) => {
    const { trial } = await (await runner(t, false)).runTrial(task, spec, 1);
    assert.equal(trial.resolved, true, JSON.stringify(trial.grading));
  });

  test(`${task.id}: the untouched setup fails its verifier`, async (t) => {
    const { trial } = await (await runner(t, true)).runTrial(task, spec, 1);
    assert.equal(trial.resolved, false);
    assert.ok(trial.grading.failed > 0);
  });
}

test("hard verifiers check several behaviors, not one", () => {
  for (const task of HARD_PROVIDER_EVAL_TASKS) {
    const cases = task.verifier.content.match(/^test\(/gm)?.length ?? 0;
    assert.ok(cases >= 5, `${task.id} has ${cases} test cases`);
  }
});

test("--tasks accepts the set names hard and standard alongside ids", () => {
  assert.deepEqual(
    selectTasks(["hard"]).map((t) => t.id),
    HARD_PROVIDER_EVAL_TASKS.map((t) => t.id),
  );
  assert.equal(selectTasks(["standard"]).length, STANDARD_PROVIDER_EVAL_TASKS.length);
  assert.deepEqual(
    selectTasks(["coding-fix-rate-limiter", "coding-lru-ttl-cache"]).map((t) => t.id),
    ["coding-fix-rate-limiter", "coding-lru-ttl-cache"],
  );
});
