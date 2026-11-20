/**
 * Budget decision endpoint.
 *
 *   POST /api/runtime/budget { runId, decision: "continue" | "stop" }
 *
 * When a run crosses 100% of its per-run budget the gateway pauses the next
 * paid call and asks the owner to decide. The owner's answer goes through this
 * endpoint: "continue" lifts the cap for the rest of the run, "stop" ends it.
 * Only the run's owner may answer, and only while a decision is pending.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { POST as POST_TASK } from "../tasks/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../lib/runtime/manager";
import { VmManager } from "../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../lib/vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../../../../lib/vm/types";
import { configureRunsDir } from "../../../../lib/telemetry/paths";
import { configureProviderStorePaths } from "../../../../lib/providers/store";
import { setBudgetGateForTesting, BudgetGate, getBudgetGate } from "../../../../lib/runtime/budget-gate";
import { resetLlmRoutingForTests, sharedRouter } from "../../../../lib/runtime/llm-routing";
import { telemetryBus } from "../../../../lib/telemetry/index";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_budget", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_budget", cost_usd: 0.001, duration_ms: 10, num_turns: 1 }),
];

class ScriptedFakeVm extends FakeVmDriver {
  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (opts?.signal?.aborted) return { exitCode: 130 };
    if (cmd[0] === "claude") {
      for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
      return { exitCode: 0 };
    }
    return super.exec(h, cmd, opts);
  }
}

function request(path: string, init: RequestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${path}`, { ...init, headers, signal: init.signal ?? undefined });
}

function postBudget(body: unknown, user: string | null = "alice"): Promise<Response> {
  return POST(request("/api/runtime/budget", { method: "POST", body: JSON.stringify(body) }, user));
}

async function dispatchAndFinish(user: string): Promise<string> {
  const res = await POST_TASK(request("/api/runtime/tasks", { method: "POST", body: JSON.stringify({ prompt: "say hi" }) }, user));
  assert.equal(res.status, 201);
  const { runId } = (await res.json()) as { runId: string };
  const start = Date.now();
  const events: Array<{ type: string }> = [];
  const unsubscribe = telemetryBus.subscribe(runId, 0, (e) => events.push(e));
  try {
    while (!events.some((e) => e.type === "run.finished") && !events.some((e) => e.type === "run.error")) {
      if (Date.now() - start > 10_000) throw new Error("timed out waiting for run.finished");
      await sleep(10);
    }
  } finally {
    unsubscribe();
  }
  return runId;
}

let tempHome = "";
let tempDir = "";

test.beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-budget-route-home-"));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-budget-route-prov-"));
  process.env.SWARM_HOME = tempHome;
  configureRunsDir(path.join(tempHome, "runs"));
  configureProviderStorePaths(path.join(tempDir, "providers.json"));
  setBudgetGateForTesting(new BudgetGate({ ttlMs: 10_000 }));
  resetLlmRoutingForTests();
});

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
  setBudgetGateForTesting(null);
  resetLlmRoutingForTests();
  configureRunsDir(null);
  configureProviderStorePaths("");
  delete process.env.SWARM_HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function installManager(): RuntimeManager {
  const vm = new VmManager({ customDriver: new ScriptedFakeVm() as unknown as VmDriver });
  const manager = new RuntimeManager({ vm });
  setRuntimeManagerForTesting(manager);
  return manager;
}

test("continue resolves the paused run's decision and lifts its cap", async () => {
  installManager();
  const runId = await dispatchAndFinish("alice");
  const gate = getBudgetGate();
  const held = gate.hold(runId, "alice", {
    spentUsd: 0.011,
    limitUsd: 0.01,
    projectedUsd: 0.011,
    expectedNextCallUsd: 0.0005,
  });

  const res = await postBudget({ runId, decision: "continue" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, status: "continued" });
  assert.equal(await held, "continue");
  assert.equal(gate.isExempt(runId), true);
  // The router also stops excluding paid providers for this run.
  assert.equal(sharedRouter().getUserUsage("alice").runBudgetExempt[runId], true);

  // A decision that was already answered cannot be answered twice.
  assert.equal((await postBudget({ runId, decision: "stop" })).status, 409);
});

test("stop ends the pause and leaves the run capped", async () => {
  installManager();
  const runId = await dispatchAndFinish("alice");
  const gate = getBudgetGate();
  const held = gate.hold(runId, "alice", {
    spentUsd: 0.011,
    limitUsd: 0.01,
    projectedUsd: 0.011,
    expectedNextCallUsd: 0.0005,
  });

  const res = await postBudget({ runId, decision: "stop" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, status: "stopped" });
  assert.equal(await held, "stop");
  assert.equal(gate.isExempt(runId), false);
  assert.equal(sharedRouter().getUserUsage("alice").runBudgetExempt[runId], undefined);
});

test("the budget endpoint rejects bad input and foreign runs", async () => {
  installManager();
  const runId = await dispatchAndFinish("alice");

  // Unauthenticated.
  assert.equal((await postBudget({ runId, decision: "continue" }, null)).status, 401);
  // Bad body / decision / run id.
  assert.equal((await postBudget("nope")).status, 400);
  assert.equal((await postBudget({ runId, decision: "maybe" })).status, 400);
  assert.equal((await postBudget({ runId: "not a run id!", decision: "continue" })).status, 400);
  // Another user's run: not found, and its pending decision is untouched.
  const gate = getBudgetGate();
  const held = gate.hold(runId, "alice", {
    spentUsd: 0.011,
    limitUsd: 0.01,
    projectedUsd: 0.011,
    expectedNextCallUsd: 0.0005,
  });
  const other = await postBudget({ runId, decision: "stop" }, "mallory");
  assert.equal(other.status, 404);
  assert.equal(gate.pendingFor(runId)?.status, "pending");
  gate.resolve(runId, "stop");
  assert.equal(await held, "stop");

  // Nothing pending for this run now.
  assert.equal((await postBudget({ runId, decision: "continue" })).status, 409);
});
