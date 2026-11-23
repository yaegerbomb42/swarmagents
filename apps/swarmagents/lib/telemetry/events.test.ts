/**
 * Unit tests for the shared event-normalization module
 * (lib/telemetry/events.ts).
 *
 * Three groups, matching the task:
 *
 *   1. usage.ts and cost-latency.ts agree on shared fixtures — lens calls,
 *      failed calls, negative telemetry, and run.paused. These are the
 *      drifts the shared readers close; several fail on the old code.
 *   2. adaptSequencedEventsToRunEvents() maps persisted SequencedEvent logs
 *      (the real bus vocabulary) to the RunEvent vocabulary efficiency()
 *      and diagnoseRun() consume.
 *   3. lib/telemetry/index.ts exports the full unified surface.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SequencedEvent } from "./bus";
import { aggregateRunCostLatency } from "./cost-latency";
import { efficiency } from "./efficiency";
import {
  adaptSequencedEventsToRunEvents,
  field,
  readLlmCall,
  readTerminalEvent,
  readUsage,
} from "./events";
import * as telemetry from "./index";
import { diagnoseRun } from "./run-diagnosis";
import { aggregateRunUsage, aggregateUsage } from "./usage";

let seq = 0;

function event(
  runId: string,
  type: string,
  extra: Record<string, unknown>,
  ts: number,
): SequencedEvent {
  seq += 1;
  return { type, seq, runId, ts, ...extra } as unknown as SequencedEvent;
}

const T0 = Date.parse("2026-11-10T10:00:00Z");

test("usage and cost-latency agree on lens calls, failed calls, and run.finished fallback", () => {
  const events = [
    event("run_a", "run.created", { data: { userId: "alice" } }, T0),
    event("run_a", "run.started", { provider: "anthropic", model: "m" }, T0 + 10),
    event("run_a", "usage", { inputTokens: 1000, outputTokens: 200, cachedTokens: 400 }, T0 + 20),
    event(
      "run_a",
      "llm.call",
      {
        data: {
          provider: "anthropic",
          model: "m",
          attempt: 1,
          outcome: "ok",
          latencyMs: 120,
          inputTokens: 1000,
          outputTokens: 200,
          costUsd: 0.004,
        },
      },
      T0 + 30,
    ),
    // Failed agent attempt with a cost: the waterfall records the price,
    // but neither meter pays it.
    event(
      "run_a",
      "llm.call",
      {
        data: {
          provider: "openai",
          model: "g",
          attempt: 2,
          outcome: "429",
          latencyMs: 50,
          costUsd: 0.009,
        },
      },
      T0 + 40,
    ),
    // Ok lens call: kept apart, added on top, in both meters.
    event(
      "run_a",
      "llm.call",
      {
        data: {
          provider: "openai",
          model: "g",
          attempt: 1,
          outcome: "ok",
          latencyMs: 90,
          costUsd: 0.0012,
          lens: "eli5",
          source: "lens",
        },
      },
      T0 + 50,
    ),
    // Failed lens call with a cost: neither meter counts it.
    event(
      "run_a",
      "llm.call",
      {
        data: {
          provider: "openai",
          model: "g",
          attempt: 1,
          outcome: "500",
          latencyMs: 30,
          costUsd: 0.003,
          lens: "eli5",
          source: "lens",
        },
      },
      T0 + 60,
    ),
    event("run_a", "run.finished", { costUsd: 0.5, durationMs: 1000, numTurns: 1 }, T0 + 100),
  ];

  const run = aggregateRunUsage("run_a", events);
  assert.equal(run.callCostUsd, 0.004);
  assert.equal(run.lensCostUsd, 0.0012);
  assert.equal(run.tokensIn, 1000);
  assert.equal(aggregateUsage([run]).totals.costUsd, 0.0052);

  const report = aggregateRunCostLatency("run_a", events);
  assert.equal(report.costUsd, 0.0052);
  assert.equal(report.lensCostUsd, 0.0012);
  assert.equal(report.costSource, "llm_calls");
  assert.equal(report.pricedCalls, 1);
  assert.equal(report.tokensIn, 1000);
  // Lens calls never enter the waterfall; the failed attempt's price is
  // recorded but not paid.
  assert.equal(report.calls.length, 2);
  assert.equal(report.calls[1]!.outcome, "429");
  assert.equal(report.calls[1]!.costUsd, 0.009);
});

test("usage and cost-latency agree that negative telemetry is absent, not credit", () => {
  const events = [
    event("run_n", "run.created", { data: { userId: "alice" } }, T0),
    event("run_n", "usage", { inputTokens: -50, outputTokens: 10, cachedTokens: -5 }, T0 + 10),
    event(
      "run_n",
      "llm.call",
      {
        data: {
          provider: "p",
          model: "m",
          attempt: 1,
          outcome: "ok",
          latencyMs: 10,
          inputTokens: -20,
          outputTokens: 5,
          costUsd: -0.5,
        },
      },
      T0 + 20,
    ),
    event("run_n", "run.finished", { costUsd: -1, durationMs: 100, numTurns: 1 }, T0 + 30),
  ];

  const run = aggregateRunUsage("run_n", events);
  assert.equal(run.tokensIn, 0);
  assert.equal(run.tokensOut, 10);
  assert.equal(run.tokensCached, 0);
  assert.equal(run.callCostUsd, undefined);
  assert.equal(run.costUsd, undefined);

  const report = aggregateRunCostLatency("run_n", events);
  assert.equal(report.tokensIn, 0);
  assert.equal(report.tokensOut, 10);
  assert.equal(report.calls[0]!.inputTokens, undefined);
  assert.equal(report.calls[0]!.costUsd, null);
  assert.equal(report.pricedCalls, 0);
  assert.equal(report.costUsd, 0);
  assert.equal(report.costSource, "none");
});

test("run.paused is a status in usage and changes nothing in cost-latency", () => {
  const events = [
    event("run_p", "run.created", { data: { userId: "alice" } }, T0),
    event("run_p", "run.started", { provider: "p", model: "m" }, T0 + 10),
    event("run_p", "usage", { inputTokens: 100, outputTokens: 10 }, T0 + 20),
    event(
      "run_p",
      "llm.call",
      {
        data: {
          provider: "p",
          model: "m",
          attempt: 1,
          outcome: "ok",
          latencyMs: 50,
          costUsd: 0.001,
        },
      },
      T0 + 30,
    ),
    event("run_p", "run.paused", { data: { reason: "offline", message: "computer offline" } }, T0 + 40),
  ];

  const run = aggregateRunUsage("run_p", events);
  assert.equal(run.status, "paused");
  assert.equal(run.tokensIn, 100);
  assert.equal(run.callCostUsd, 0.001);

  const report = aggregateRunCostLatency("run_p", events);
  assert.equal(report.costUsd, 0.001);
  assert.equal(report.tokensIn, 100);
  assert.equal(report.provider, "p");
});

test("readLlmCall normalizes the gateway data payload and the flat fake-provider shape", () => {
  const fromData = readLlmCall(
    event(
      "r",
      "llm.call",
      {
        data: {
          provider: "anthropic",
          model: "m",
          attempt: 2,
          outcome: "ok",
          latencyMs: 100,
          queuedMs: 5,
          ttftMs: 30,
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.002,
          costReported: true,
        },
      },
      T0,
    ),
  );
  assert.equal(fromData.provider, "anthropic");
  assert.equal(fromData.attempt, 2);
  assert.equal(fromData.costUsd, 0.002);
  assert.equal(fromData.costReported, true);

  const flat = readLlmCall(
    event(
      "r",
      "llm.call",
      {
        provider: "openai",
        model: "g",
        attempt: 1,
        outcome: "429",
        latencyMs: 20,
        costUsd: null,
      },
      T0,
    ),
  );
  assert.equal(flat.provider, "openai");
  assert.equal(flat.outcome, "429");
  assert.equal(flat.costUsd, null);
  assert.equal(flat.provider, "openai");

  // Absent provider/model stay absent (consumers apply their own default);
  // a negative cost is unknown, not a priced $0 call.
  const sparse = readLlmCall(
    event("r", "llm.call", { data: { outcome: "ok", costUsd: -0.5 } }, T0),
  );
  assert.equal(sparse.provider, undefined);
  assert.equal(sparse.model, undefined);
  assert.equal(sparse.attempt, 1);
  assert.equal(sparse.costUsd, null);
});

test("field falls back to the data payload when the top level is undefined", () => {
  const e = event("r", "usage", { inputTokens: undefined, data: { inputTokens: 5 } }, T0);
  assert.equal(field(e, "inputTokens"), 5);
  assert.equal(readUsage(e).inputTokens, 5);
});

test("readTerminalEvent classifies terminal events and ignores the rest", () => {
  assert.equal(readTerminalEvent(event("r", "run.finished", { costUsd: 0.02 }, T0))?.kind, "finished");
  assert.equal(
    readTerminalEvent(event("r", "run.finished", { costUsd: -1 }, T0))?.costUsd,
    undefined,
  );
  assert.equal(readTerminalEvent(event("r", "run.error", {}, T0))?.kind, "error");
  assert.equal(readTerminalEvent(event("r", "run.cancelled", {}, T0))?.kind, "cancelled");
  assert.equal(readTerminalEvent(event("r", "run.started", {}, T0)), undefined);
  assert.equal(readTerminalEvent(event("r", "usage", {}, T0)), undefined);
});

test("the adapter maps a real persisted log to turns, tools, and findings", () => {
  const events = [
    event("run_d", "run.created", { data: { userId: "alice" } }, T0),
    event("run_d", "run.started", { provider: "p", model: "m" }, T0 + 10),
    event("run_d", "usage", { inputTokens: 1000, outputTokens: 200, cachedTokens: 400 }, T0 + 1000),
    event(
      "run_d",
      "tool.call",
      { name: "read", input: { files: [{ path: "a.ts", start: 1, end: 10 }] }, id: "c1" },
      T0 + 1100,
    ),
    event("run_d", "tool.result", { id: "c1", ok: true, output: "..." }, T0 + 1200),
    event("run_d", "tool.call", { name: "todo", input: {}, id: "c2" }, T0 + 1300),
    event("run_d", "tool.result", { id: "c2", ok: true, output: "ok" }, T0 + 1400),
    event("run_d", "usage", { inputTokens: 2000, outputTokens: 100, cachedTokens: 1500 }, T0 + 3000),
    event(
      "run_d",
      "tool.call",
      { name: "read", input: { files: [{ path: "a.ts", start: 1, end: 10 }] }, id: "c3" },
      T0 + 3100,
    ),
    event("run_d", "tool.result", { id: "c3", ok: true, output: "..." }, T0 + 3200),
    event("run_d", "run.finished", { costUsd: 0.01 }, T0 + 4000),
  ];

  const adapted = adaptSequencedEventsToRunEvents(events);
  // Lifecycle and result events are not RunEvents; only turns and calls are.
  assert.equal(adapted.length, 5);
  assert.deepEqual(
    adapted.map((e) => e.type),
    ["turn", "tool.call", "tool.call", "turn", "tool.call"],
  );
  assert.equal(adapted[0]!.turn, 1);
  assert.deepEqual(adapted[0]!.tokens, { uncached: 600, cacheRead: 400 });
  assert.equal(adapted[3]!.turn, 2);
  assert.deepEqual(adapted[3]!.tokens, { uncached: 500, cacheRead: 1500 });
  // The bus writes `name`; the diagnostics read `tool`.
  assert.deepEqual(
    adapted.filter((e) => e.type === "tool.call").map((e) => e.tool),
    ["read", "todo", "read"],
  );

  const eff = efficiency(adapted);
  assert.equal(eff?.turns, 2);
  assert.equal(eff?.tool_calls, 3);
  assert.equal(eff?.bookkeeping_share, 0.333);
  assert.equal(eff?.fresh_per_turn, 550);
  assert.equal(eff?.cache_share, 0.633);
  assert.equal(eff?.idle_ms, 0);

  const kinds = diagnoseRun(adapted)
    .map((f) => f.kind)
    .sort();
  assert.deepEqual(kinds, ["bookkeeping", "repeated-read", "single-call-explore"]);
});

test("the adapter turns a blocked call into a denied finding", () => {
  const events = [
    event("run_b", "run.created", { data: { userId: "alice" } }, T0),
    event("run_b", "usage", { inputTokens: 100, outputTokens: 10 }, T0 + 1000),
    event("run_b", "tool.blocked", { name: "bash", reason: "allowlist" }, T0 + 1100),
    event("run_b", "run.finished", { costUsd: 0.001 }, T0 + 2000),
  ];
  const adapted = adaptSequencedEventsToRunEvents(events);
  assert.equal(adapted.length, 2);
  assert.equal(adapted[1]!.type, "tool.denied");
  assert.equal(adapted[1]!.tool, "bash");
  assert.equal(adapted[1]!.reason, "allowlist");
  assert.equal(efficiency(adapted)?.tool_calls, 0);
  const denied = diagnoseRun(adapted).find((f) => f.kind === "denied");
  assert.ok(denied, "expected a denied finding");
  assert.match(denied!.hint, /bash/);
  assert.match(denied!.hint, /allowlist/);
});

test("the adapter turns a failed edit into an edit-miss finding", () => {
  const events = [
    event("run_e", "usage", { inputTokens: 100, outputTokens: 10 }, T0 + 1000),
    event(
      "run_e",
      "tool.call",
      { name: "str_replace", input: { path: "a.ts" }, id: "e1" },
      T0 + 1100,
    ),
    event(
      "run_e",
      "tool.result",
      { id: "e1", ok: false, output: "Error: old_text not found in a.ts" },
      T0 + 1200,
    ),
    event("run_e", "usage", { inputTokens: 200, outputTokens: 10 }, T0 + 2000),
  ];
  const adapted = adaptSequencedEventsToRunEvents(events);
  const call = adapted.find((e) => e.type === "tool.call");
  assert.equal(call?.isError, true);
  assert.match(String(call?.error ?? ""), /not found/);
  const miss = diagnoseRun(adapted).find((f) => f.kind === "edit-miss");
  assert.ok(miss, "expected an edit-miss finding");
});

test("the adapter counts paused time as idle, not as model work", () => {
  const events = [
    event("run_i", "usage", { inputTokens: 100, outputTokens: 10 }, T0),
    event("run_i", "run.paused", { data: { reason: "offline" } }, T0 + 1000),
    event("run_i", "usage", { inputTokens: 200, outputTokens: 10 }, T0 + 601000),
  ];
  const adapted = adaptSequencedEventsToRunEvents(events);
  assert.equal(adapted.length, 2);
  // The turn right after the pause spent the whole gap paused.
  assert.equal(adapted[1]!.ms, 0);
  assert.equal(efficiency(adapted)?.idle_ms, 601000);
  const idle = diagnoseRun(adapted).find((f) => f.kind === "idle");
  assert.ok(idle, "expected an idle finding");
});

test("the adapter covers a long model call instead of calling it idle", () => {
  const events = [
    event("run_m", "usage", { inputTokens: 100, outputTokens: 10 }, T0),
    event("run_m", "usage", { inputTokens: 200, outputTokens: 10 }, T0 + 90000),
  ];
  const adapted = adaptSequencedEventsToRunEvents(events);
  assert.equal(adapted[1]!.ms, 90000);
  assert.equal(efficiency(adapted)?.idle_ms, 0);
  assert.equal(diagnoseRun(adapted).find((f) => f.kind === "idle"), undefined);
});

test("llm.call events are not turns", () => {
  const events = [
    event("run_l", "run.created", { data: { userId: "alice" } }, T0),
    event(
      "run_l",
      "llm.call",
      { data: { provider: "p", model: "m", attempt: 1, outcome: "ok", latencyMs: 50, costUsd: 0.001 } },
      T0 + 100,
    ),
    event(
      "run_l",
      "llm.call",
      { data: { provider: "p", model: "m", attempt: 2, outcome: "ok", latencyMs: 50, costUsd: 0.001 } },
      T0 + 200,
    ),
    event("run_l", "run.finished", { costUsd: 0.002 }, T0 + 300),
  ];
  const adapted = adaptSequencedEventsToRunEvents(events);
  assert.deepEqual(adapted, []);
  assert.equal(efficiency(adapted), undefined);
  assert.deepEqual(diagnoseRun(adapted), []);
});

test("the adapter drops a result for a call outside the log slice", () => {
  const events = [
    event("run_s", "usage", { inputTokens: 100, outputTokens: 10 }, T0 + 1000),
    event("run_s", "tool.result", { id: "missing", ok: false, output: "boom" }, T0 + 1100),
  ];
  const adapted = adaptSequencedEventsToRunEvents(events);
  assert.equal(adapted.length, 1);
  assert.equal(adapted[0]!.type, "turn");
});

test("the index exports the full telemetry surface", () => {
  const functions = [
    "TelemetryBus",
    "encodeSse",
    "sseResponse",
    "isTerminalRunEvent",
    "aggregateRunUsage",
    "computeUsage",
    "aggregateRunCostLatency",
    "expectedNextCallUsd",
    "projectRunBudget",
    "efficiency",
    "coveredMs",
    "diagnoseRun",
    "formatFindings",
    "findingsJson",
    "adaptSequencedEventsToRunEvents",
    "readLlmCall",
    "readUsage",
    "readRunCreated",
    "readRunStarted",
    "readRunFailover",
    "readTerminalEvent",
    "field",
    "num",
    "nonNegative",
    "str",
    "isRecord",
    "readRunEvents",
    "appendRunEvent",
    "runLogFile",
    "listRunLogs",
    "flushRunLogs",
  ];
  for (const name of functions) {
    assert.equal(
      typeof (telemetry as Record<string, unknown>)[name],
      "function",
      `telemetry.${name} should be exported as a function`,
    );
  }
  const values = ["telemetryBus", "BUDGET_WARN_FRACTION", "IDLE_GAP_MS", "MAX_FINDINGS"];
  for (const name of values) {
    assert.notEqual(
      (telemetry as Record<string, unknown>)[name],
      undefined,
      `telemetry.${name} should be exported`,
    );
  }
});
