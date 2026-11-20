/**
 * LLM gateway <-> budget gate (lib/runtime/budget-gate.ts): a paid call that
 * would push the run over its per-run budget (perRunBudgetUsd) holds the
 * request instead of spending the money, publishes the 80% warning once per
 * run, and resumes or stops on the owner's answer. Stubbed fetch only.
 *
 * The router's own per-run cap check is deliberately bypassed by the
 * "continue" answer: the gate lifts the cap for the run in the router too.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardLlmNonStreaming } from "./llm-gateway";
import {
  FileRouterStore,
  resetLlmRoutingForTests,
  sharedRouter,
} from "./llm-routing";
import { SwarmRouter, type Clock } from "../router";
import { configureProviderStorePaths } from "../providers/store";
import { writeUserSettings } from "../providers/settings";
import { BudgetGate, setBudgetGateForTesting, getBudgetGate } from "./budget-gate";
import type { ProviderConfig } from "../providers/types";
import type { TelemetryBus } from "../telemetry";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class FakeClock implements Clock {
  t = Date.parse("2026-11-12T10:00:00.000Z");
  now() {
    return this.t;
  }
  random() {
    return 0.5;
  }
}

let seq = 0;
let tempDir = "";

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-gw-budget-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  process.env.SWARM_HOME = tempDir;
  resetLlmRoutingForTests(new SwarmRouter({ clock: new FakeClock(), store: new FileRouterStore() }));
  setBudgetGateForTesting(new BudgetGate({ ttlMs: 5_000 }));
});

test.afterEach(() => {
  setBudgetGateForTesting(null);
  resetLlmRoutingForTests();
  delete process.env.SWARM_HOME;
  delete process.env.SWARM_LLM_ROUTER;
  rmSync(tempDir, { recursive: true, force: true });
});

function owner(): string {
  return `user-gw-budget-${++seq}`;
}

function key(): string {
  return `sk-budget-test-${++seq}-secret`;
}

const REQ = {
  model: "claude-x",
  max_tokens: 4_096,
  messages: [{ role: "user", content: "budget test prompt" }],
};

// $10.00 per call: 5000 in + 5000 out at $1000 per 1M tokens.
const OK = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5000, completion_tokens: 5000 },
};

function provider(id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    kind: "openai",
    baseUrl: `https://${id}.example/v1`,
    models: { balanced: `${id}-model` },
    keys: [key()],
    rank: 0,
    // $1000/1M tokens: 5 in / 1 out costs $0.006 per call.
    inputPricePer1mTokens: 1000,
    outputPricePer1mTokens: 1000,
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function stubFetch(calls: Array<{ host: string }>) {
  const fetchImpl = async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    calls.push({ host: url.hostname.replace(/\.example$/, "") });
    return json(OK);
  };
  return fetchImpl as unknown as typeof fetch;
}

function memoryBus() {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    bus: { publish: (_runId: string, e: { type: string; data?: unknown }) => events.push({ type: e.type, data: e.data as Record<string, unknown> }) } as unknown as TelemetryBus,
    events,
    of(type: string) {
      return events.filter((e) => e.type === type).map((e) => e.data);
    },
  };
}

test("crossing 80% of the per-run budget publishes a warning once", async () => {
  const u = owner();
  writeUserSettings(u, { preferFreeProviders: true, perRunBudgetUsd: 5 });
  const calls: Array<{ host: string }> = [];
  const bus = memoryBus();
  const fetchImpl = stubFetch(calls);

  const result = await forwardLlmNonStreaming({
    owner: u,
    providers: [provider("paid")],
    body: REQ,
    fetchImpl,
    runId: "gw-budget-warn",
    bus: bus.bus,
  });
  assert.equal(result.attempts[0]!.provider, "paid");
  // The call itself estimated at $4.10 of the $5 budget: 82%, past the 80%
  // warning threshold, so the call goes out but the warning is published.
  assert.equal(getBudgetGate().spendFor("gw-budget-warn"), 10);
  const warnings = bus.of("run.budget.warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.limitUsd, 5);
  assert.equal(warnings[0]!.spentUsd, 0);
  assert.ok(Number(warnings[0]!.projectedUsd) >= 5 * 0.8);
  assert.equal(bus.of("run.budget.paused").length, 0);
});

test("at 100% of the per-run budget the call holds until the owner continues", async () => {
  const u = owner();
  writeUserSettings(u, { preferFreeProviders: true, perRunBudgetUsd: 5 });
  const calls: Array<{ host: string }> = [];
  const t = memoryBus();
  const fetchImpl = stubFetch(calls);
  const gate = getBudgetGate();
  const args = {
    owner: u,
    providers: [provider("paid")],
    body: REQ,
    fetchImpl,
    runId: "gw-budget-continue",
    bus: t.bus,
  };

  // First call: estimated at $4.10 of the $5 cap, so it goes out and spends $10.
  const first = await forwardLlmNonStreaming(args);
  assert.equal(first.attempts[0]!.provider, "paid");
  assert.equal(calls.length, 1);
  assert.equal(gate.spendFor("gw-budget-continue"), 10);

  // Second call: the run already spent $10 of the $5 cap, so it holds.
  const held = forwardLlmNonStreaming(args);
  const settle = held.then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));
  await sleep(50);
  assert.equal(calls.length, 1, "no paid call went out while the run is paused");
  const pending = gate.pendingFor("gw-budget-continue");
  assert.ok(pending, "a pending decision exists while the run is paused");
  assert.equal(pending.status, "pending");
  assert.equal(pending.spentUsd, 10);
  assert.equal(pending.limitUsd, 5);
  assert.equal(t.of("run.budget.paused").length, 1);

  assert.equal(gate.resolve("gw-budget-continue", "continue"), true);
  const settled = await settle;
  assert.equal(settled.ok, true);
  if (settled.ok) assert.equal(settled.r.attempts[0]!.provider, "paid");
  assert.equal(calls.length, 2, "the held call goes out after the owner continues");
  assert.ok(gate.isExempt("gw-budget-continue"));
  // The router stopped excluding paid providers for this run.
  assert.equal(sharedRouter().getUserUsage(u).runBudgetExempt["gw-budget-continue"], true);
  assert.equal(t.of("run.budget.resumed").length, 1);
  assert.equal(t.of("run.budget.resumed")[0]!.decision, "continue");

  // The rest of the run is no longer held.
  await forwardLlmNonStreaming(args);
  assert.equal(calls.length, 3);
});

test("at 100% of the per-run budget the run stops when the owner refuses", async () => {
  const u = owner();
  writeUserSettings(u, { preferFreeProviders: true, perRunBudgetUsd: 5 });
  const calls: Array<{ host: string }> = [];
  const t = memoryBus();
  const fetchImpl = stubFetch(calls);
  const gate = getBudgetGate();
  const args = {
    owner: u,
    providers: [provider("paid")],
    body: REQ,
    fetchImpl,
    runId: "gw-budget-stop",
    bus: t.bus,
  };

  await forwardLlmNonStreaming(args);
  assert.equal(calls.length, 1);

  const held = forwardLlmNonStreaming(args);
  const settle = held.then(
    () => ({ ok: true as const }),
    (e: unknown) => ({ ok: false as const, e: e as { status: number; body: string } }),
  );
  await sleep(50);
  assert.equal(calls.length, 1);
  assert.equal(gate.resolve("gw-budget-stop", "stop"), true);
  const settled = await settle;
  assert.equal(settled.ok, false);
  if (!settled.ok) {
    assert.equal(settled.e.status, 402);
    assert.match(settled.e.body, /perRunBudgetUsd|budget/i);
  }
  assert.equal(calls.length, 1, "no paid call went out after the owner stopped the run");
  assert.equal(gate.isExempt("gw-budget-stop"), false);
});

test("a free provider is never held, whatever the budget", async () => {
  const u = owner();
  writeUserSettings(u, { preferFreeProviders: true, perRunBudgetUsd: 0 });
  const calls: Array<{ host: string }> = [];
  const fetchImpl = stubFetch(calls);

  const result = await forwardLlmNonStreaming({
    owner: u,
    providers: [provider("free-provider", { isFree: true })],
    body: REQ,
    fetchImpl,
    runId: "gw-budget-free",
    bus: memoryBus().bus,
  });
  assert.equal(result.attempts[0]!.provider, "free-provider");
  assert.equal(calls.length, 1);
  assert.equal(getBudgetGate().pendingFor("gw-budget-free"), undefined);
});
