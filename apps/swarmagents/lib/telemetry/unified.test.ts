/**
 * Cross-module telemetry consistency tests:
 *  - billing and latency agree on the same recorded events;
 *  - the SequencedEvent → RunEvent adapter feeds the pure diagnostics;
 *  - index.ts exports the unified telemetry surface.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SequencedEvent } from "./bus";
import { aggregateRunUsage } from "./usage";
import { aggregateRunCostLatency } from "./cost-latency";
import { efficiency } from "./efficiency";
import { diagnoseRun } from "./run-diagnosis";
import { adaptSequencedEventsToRunEvents } from "./adapter";
import * as telemetry from "./index";

const T0 = Date.parse("2026-11-10T10:00:00Z");
const ev = (seq: number, type: string, data: Record<string, unknown>, offset: number): SequencedEvent => ({
  seq,
  runId: "run-shared",
  type,
  ts: T0 + offset,
  data,
});

function sharedFixture(): SequencedEvent[] {
  return [
    ev(1, "run.created", { userId: "alice", model: "m0" }, 0),
    ev(2, "run.started", { provider: "p1", model: "m1" }, 10),
    ev(3, "usage", { inputTokens: 100, outputTokens: 20, cachedTokens: 40 }, 20),
    // A failed attempt that still reported a price: it must not count as spend.
    ev(4, "llm.call", { provider: "p1", model: "m1", attempt: 1, outcome: "429", latencyMs: 30, costUsd: 0.003 }, 30),
    ev(5, "llm.call", { provider: "p2", model: "m2", attempt: 2, outcome: "ok", latencyMs: 50, costUsd: 0.005 }, 60),
    // A lens call shares the bus but is billed separately from the agent.
    ev(6, "llm.call", { provider: "lens", model: "cheap", attempt: 1, outcome: "ok", latencyMs: 10, costUsd: 0.001, source: "lens" }, 70),
    ev(7, "run.paused", { reason: "budget" }, 80),
  ];
}

test("usage and cost-latency agree on lens, failed-call and run.paused fixtures", () => {
  const events = sharedFixture();
  const usage = aggregateRunUsage("run-shared", events);
  const latency = aggregateRunCostLatency("run-shared", events);

  // Both count only the successful agent call's cost; the failed attempt's
  // price and the lens price are excluded from the run's own spend.
  assert.equal(usage.callCostUsd, 0.005);
  assert.equal(usage.lensCostUsd, 0.001);
  assert.equal(latency.costUsd, 0.005);
  assert.equal(latency.costSource, "llm_calls");
  // Lens calls are not provider attempts in the latency waterfall.
  assert.equal(latency.calls.length, 2);
  assert.ok(latency.calls.every((c) => c.outcome !== "lens" && c.provider !== "lens"));

  // Token totals come from the same shared reader.
  assert.deepEqual(
    [usage.tokensIn, usage.tokensOut, usage.tokensCached],
    [latency.tokensIn, latency.tokensOut, latency.tokensCached],
  );
  assert.deepEqual([usage.tokensIn, usage.tokensOut, usage.tokensCached], [100, 20, 40]);

  // Both agree on the serving provider; the lens provider never takes over.
  assert.equal(usage.provider, "p2");
  assert.equal(latency.provider, "p2");

  // run.paused is not a finish in either aggregator.
  assert.equal(usage.status, "running");
  assert.equal(usage.finishedAt, undefined);
  assert.equal(latency.durationMs, undefined);

  // A later finish keeps the two cost figures consistent.
  const finished = [...events, ev(8, "run.finished", { costUsd: 0.9, durationMs: 120, numTurns: 2 }, 100)];
  const usage2 = aggregateRunUsage("run-shared", finished);
  const latency2 = aggregateRunCostLatency("run-shared", finished);
  assert.equal(usage2.status, "finished");
  assert.equal(latency2.durationMs, 120);
  assert.equal((usage2.callCostUsd ?? 0) + (usage2.lensCostUsd ?? 0), latency2.costUsd + 0.001);
});

test("adaptSequencedEventsToRunEvents maps persisted events for efficiency/diagnosis", () => {
  const events: SequencedEvent[] = [
    ev(1, "usage", { turn: 1, inputTokens: 100, outputTokens: 20, cachedTokens: 40 }, 0),
    ev(2, "tool.call", { tool: "read", input: { path: "src/a.ts", start: 1 }, ms: 5 }, 10),
    ev(3, "loop.gates", { ms: 100 }, 20),
  ];
  const adapted = adaptSequencedEventsToRunEvents(events);

  assert.equal(adapted[0]!.type, "turn");
  assert.equal(adapted[0]!.turn, 1);
  assert.deepEqual(adapted[0]!.tokens, { uncached: 60, cacheRead: 40 });
  assert.equal(adapted[1]!.type, "tool.call");
  assert.equal(adapted[1]!.tool, "read");
  assert.deepEqual((adapted[1]!.input as { path: string }).path, "src/a.ts");
  assert.equal(adapted[2]!.type, "loop.gates");

  // The adapted stream really is consumable by the pure diagnostics.
  const eff = efficiency(adapted);
  assert.ok(eff);
  assert.equal(eff.turns, 1);
  assert.equal(eff.tool_calls, 1);
  assert.equal(eff.gate_ms, 100);
  // The adapted stream really is consumable by the pure diagnostics: the
  // single `read` call and the 100 ms gate are surfaced as findings.
  const findings = diagnoseRun(adapted);
  assert.ok(findings.length > 0);
  assert.ok(findings.some((f) => f.kind === "single-call-explore"));
  assert.ok(findings.some((f) => f.kind === "gate-time"));
});

test("index exports the unified telemetry surface", () => {
  assert.equal(typeof telemetry.aggregateRunUsage, "function");
  assert.equal(typeof telemetry.aggregateRunCostLatency, "function");
  assert.equal(typeof telemetry.efficiency, "function");
  assert.equal(typeof telemetry.diagnoseRun, "function");
  assert.equal(typeof telemetry.readRunEvents, "function");
  assert.equal(typeof telemetry.streamRunEventsFrom, "function");
  assert.equal(typeof telemetry.adaptSequencedEventsToRunEvents, "function");
});
