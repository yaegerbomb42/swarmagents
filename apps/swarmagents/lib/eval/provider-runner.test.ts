import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderEvalRunner, VM_EVAL_ROOT, type ProviderSpec } from "./provider-runner";
import { LocalTempIsolation } from "./runner";
import { PROVIDER_EVAL_TASKS } from "./provider-tasks";
import { ScriptedProviderExecutor } from "./provider-executor";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ProviderEvalTask } from "./provider-types";

function providerSpec(providerId: string, model = "model-x"): ProviderSpec {
  return { providerId, model };
}

/** A dedicated isolation root for one test, so leak checks see only this test's dirs. */
async function isolationRoot(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-eval-provider-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function leakedRunDirs(root: string): Promise<string[]> {
  const entries = await readdir(root);
  return entries.filter((e) => e.startsWith("swarm-eval-"));
}

test("runSuite runs every task for each provider and scripted solves resolve", async (t) => {
  const root = await isolationRoot(t);
  const runner = new ProviderEvalRunner({ isolation: new LocalTempIsolation(root) });
  const before = await leakedRunDirs(root);
  const providers: ProviderSpec[] = [providerSpec("anthropic"), providerSpec("openai")];
  const results = await runner.runSuite(providers, { trialsPerTask: 1 });
  assert.equal(results.length, PROVIDER_EVAL_TASKS.length * providers.length);
  // Every task ran for both providers.
  for (const p of providers) {
    const mine = results.filter((r) => r.providerId === p.providerId);
    assert.equal(new Set(mine.map((r) => r.taskId)).size, PROVIDER_EVAL_TASKS.length);
    for (const r of mine) {
      assert.equal(r.resolved, true, `${r.providerId}/${r.taskId} should resolve`);
      assert.equal(r.grading.failed, 0);
    }
  }
  const after = await leakedRunDirs(root);
  assert.deepEqual(after, before, "no run directory may leak");
});

test("summary aggregates completion, turns, tokens and wall-clock per provider", async () => {
  const runner = new ProviderEvalRunner();
  const providers: ProviderSpec[] = [providerSpec("anthropic"), providerSpec("openai")];
  const results = await runner.runSuite(providers);
  const report = runner.summarize(results);
  assert.equal(report.rows.length, 2);
  const anthropic = report.rows.find((r) => r.providerId === "anthropic")!;
  const openai = report.rows.find((r) => r.providerId === "openai")!;
  assert.equal(anthropic.tasksRun, PROVIDER_EVAL_TASKS.length);
  assert.equal(anthropic.completionRate, 1);
  assert.ok(anthropic.meanTurns > 0);
  assert.ok(anthropic.meanInputTokens > 0);
  assert.ok(anthropic.meanOutputTokens > 0);
  assert.ok(anthropic.meanWallClockMs > 0);
  assert.equal(openai.completionRate, 1);
});

test("a failing scripted executor records the task as unresolved", async (t) => {
  const root = await isolationRoot(t);
  const runner = new ProviderEvalRunner({
    isolation: new LocalTempIsolation(root),
    executor: new ScriptedProviderExecutor({ fail: true }),
  });
  const task = PROVIDER_EVAL_TASKS[0];
  const { trial } = await runner.runTrial(task, providerSpec("openai"), 1);
  assert.equal(trial.resolved, false);
  assert.equal(trial.grading.failed, trial.grading.total);
});

test("deleted paths are removed before grading (file organization task)", async (t) => {
  const root = await isolationRoot(t);
  const runner = new ProviderEvalRunner({ isolation: new LocalTempIsolation(root) });
  const fileOrg = PROVIDER_EVAL_TASKS.find((task) => task.id === "fileorg-consolidate-logs")!;
  const { trial } = await runner.runTrial(fileOrg, providerSpec("anthropic"), 1);
  assert.equal(trial.resolved, true);
});

test("empty task list yields an empty report", async () => {
  const runner = new ProviderEvalRunner();
  const results = await runner.runSuite([providerSpec("anthropic")], { tasks: [] });
  assert.equal(results.length, 0);
  const report = runner.summarize(results);
  assert.equal(report.rows.length, 0);
});

test("provisions trials into a FakeVmDriver and verifies the solved state", async (t) => {
  const root = await isolationRoot(t);
  const vm = new FakeVmDriver();
  const runner = new ProviderEvalRunner({
    isolation: new LocalTempIsolation(root),
    vmDriver: vm,
  });
  const gui = PROVIDER_EVAL_TASKS.find((task) => task.id === "gui-tkinter-counter-app") as ProviderEvalTask;
  const { trial } = await runner.runTrial(gui, providerSpec("anthropic"), 1);
  assert.equal(trial.resolved, true);
  // The driver's handle key is `${providerId}-${model}`; verify the solved
  // file landed in the VM under the eval root.
  const handle = await vm.ensure("anthropic-model-x");
  const app = await vm.readFile(handle, `${VM_EVAL_ROOT}/gui-tkinter-counter-app/1/app.py`);
  assert.ok(app.includes("import tkinter"));
});

test("grading runs in isolation for a task whose solution must not shadow the verifier", async (t) => {
  // Ensure the verifier is laid down after the solution by using the GUI
  // task, whose solution file is app.py — the verifier lives in test/.
  const root = await isolationRoot(t);
  const runner = new ProviderEvalRunner({ isolation: new LocalTempIsolation(root) });
  const gui = PROVIDER_EVAL_TASKS.find((task) => task.id === "gui-tkinter-counter-app") as ProviderEvalTask;
  const { trial } = await runner.runTrial(gui, providerSpec("openai"), 1);
  assert.equal(trial.resolved, true);
});
