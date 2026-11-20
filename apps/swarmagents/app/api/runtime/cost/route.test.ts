/**
 * Cost and latency panel data.
 *
 *   GET /api/runtime/cost?runId=<id>
 *
 * The panel reads the run's durable telemetry log: $ per run/provider, tokens,
 * the latency waterfall, the budget projection (the 80% warning) and whether
 * the gateway is holding a paid call for the run. It is scoped to the caller —
 * one account never sees another's spend.
 *
 * Uses the fake VM driver: the recorded transcript reports usage and a final
 * `cost_usd`, so the run's reported cost is the fallback source.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { POST as POST_TASK } from "../tasks/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../lib/runtime/manager";
import { VmManager } from "../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../lib/vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../../../../lib/vm/types";
import { configureRunsDir } from "../../../../lib/telemetry/paths";
import { configureProviderStorePaths } from "../../../../lib/providers/store";
import { writeUserSettings } from "../../../../lib/providers/settings";
import { setBudgetGateForTesting, BudgetGate } from "../../../../lib/runtime/budget-gate";
import { resetLlmRoutingForTests } from "../../../../lib/runtime/llm-routing";
import { telemetryBus } from "../../../../lib/telemetry/index";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_cost", model: "claude-sonnet-5-5" }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "m1",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 24, output_tokens: 8 },
    },
  }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_cost", cost_usd: 0.001, duration_ms: 10, num_turns: 1 }),
];

class ScriptedFakeVm extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];

  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, opts: opts ?? {} });
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

function getCost(runId: string, user: string | null = "alice"): Promise<Response> {
  return GET(request(`/api/runtime/cost?runId=${encodeURIComponent(runId)}`, {}, user));
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
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cost-route-home-"));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cost-route-prov-"));
  process.env.SWARM_HOME = tempHome;
  configureRunsDir(path.join(tempHome, "runs"));
  configureProviderStorePaths(path.join(tempDir, "providers.json"));
  setBudgetGateForTesting(new BudgetGate({ ttlMs: 5000 }));
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

test("GET /api/runtime/cost returns the run's report, its budget and the pending decision", async () => {
  installManager();
  const runId = await dispatchAndFinish("alice");

  const res = await getCost(runId);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    runId: string;
    report: { costUsd: number; costSource: string; tokensIn: number; tokensOut: number; provider: string };
    budget: { limitUsd: number | null; status: string; projectedUsd: number; fraction: number | null };
    pending: unknown;
  };
  assert.equal(body.runId, runId);
  assert.equal(body.report.costSource, "run_finished");
  assert.equal(body.report.costUsd, 0.001);
  assert.equal(body.report.tokensIn, 24);
  assert.equal(body.report.tokensOut, 8);
  // No per-run cap configured: the meter is informational.
  assert.equal(body.budget.limitUsd, null);
  assert.equal(body.budget.status, "uncapped");
  assert.equal(body.budget.fraction, null);
  assert.equal(body.budget.projectedUsd, 0.001);
  assert.equal(body.pending, null);
});

test("the budget projection warns at 80% of the caller's per-run cap", async () => {
  installManager();
  writeUserSettings("alice", { preferFreeProviders: true, perRunBudgetUsd: 0.0012 });
  const runId = await dispatchAndFinish("alice");

  const res = await getCost(runId);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    budget: { limitUsd: number | null; status: string; fraction: number | null; spentUsd: number };
  };
  assert.equal(body.budget.limitUsd, 0.0012);
  assert.equal(body.budget.spentUsd, 0.001);
  // 0.001 / 0.0012 = 83.3%: past the 80% warning threshold, not yet at 100%.
  assert.equal(body.budget.status, "warn");
  assert.ok((body.budget.fraction as number) >= 0.8);
  assert.ok((body.budget.fraction as number) < 1);

  // Another account is not warned about this run: it cannot even see it.
  const other = await getCost(runId, "mallory");
  assert.equal(other.status, 404);
});

test("GET /api/runtime/cost is scoped to the caller", async () => {
  installManager();
  const runId = await dispatchAndFinish("alice");

  assert.equal((await getCost(runId, "mallory")).status, 404);
  assert.equal((await getCost(runId, null)).status, 401);
  assert.equal((await getCost("run that does not exist")).status, 400);
  assert.equal((await getCost("run_unknown_0000")).status, 404);
});
