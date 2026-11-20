/**
 * cost-latency.test.ts — the cost dashboard's aggregation, exercised against a
 * *recorded* event log.
 *
 * Every test writes events through the TelemetryBus into a temporary runs
 * directory and reads them back with readRunEvents, so the aggregation is
 * proven against the same durable log the API and the browser read — not
 * against hand-built objects that could drift from what the runtime writes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus, type SequencedEvent, type TelemetryEvent } from "./bus";
import { configureRunsDir } from "./paths";
import { readRunEvents } from "./run-log";
import {
  aggregateRunCostLatency,
  expectedNextCallUsd,
  projectRunBudget,
  BUDGET_WARN_FRACTION,
} from "./cost-latency";

/** A temp runs dir wired into the telemetry bus, so events are persisted. */
function recordedLog(): { bus: TelemetryBus; dir: string; events: (runId: string) => SequencedEvent[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-cost-log-"));
  configureRunsDir(dir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
  return {
    bus,
    dir,
    events: (runId: string) => readRunEvents(runId, dir),
  };
}

/** Gateway telemetry: the payload lives in the event's `data` field. */
function llmCall(
  bus: TelemetryBus,
  runId: string,
  payload: Record<string, unknown>,
): void {
  bus.publish(runId, { type: "llm.call", data: payload } satisfies TelemetryEvent);
}

test("aggregation reads a recorded log: cost per run and per provider", () => {
  const log = recordedLog();
  const runId = "run_cost_1";
  log.bus.publish(runId, { type: "run.created", data: { userId: "alice", prompt: "hi" } });
  log.bus.publish(runId, { type: "run.started", model: "claude-sonnet", provider: "openrouter" } as TelemetryEvent);
  llmCall(log.bus, runId, {
    provider: "openrouter",
    model: "claude-sonnet",
    attempt: 1,
    outcome: "ok",
    latencyMs: 900,
    queuedMs: 40,
    ttftMs: 220,
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.0042,
  });
  llmCall(log.bus, runId, {
    provider: "openrouter",
    model: "claude-sonnet",
    attempt: 2,
    outcome: "ok",
    latencyMs: 700,
    queuedMs: 10,
    ttftMs: 180,
    inputTokens: 900,
    outputTokens: 120,
    costUsd: 0.0018,
  });
  log.bus.publish(runId, {
    type: "usage",
    inputTokens: 2100,
    outputTokens: 420,
    cachedTokens: 100,
  } as TelemetryEvent);
  log.bus.publish(runId, { type: "run.finished", costUsd: 0.006, durationMs: 3200, numTurns: 2 } as TelemetryEvent);

  const report = aggregateRunCostLatency(runId, log.events(runId));

  assert.equal(report.runId, runId);
  assert.equal(report.userId, "alice");
  assert.equal(report.model, "claude-sonnet");
  assert.equal(report.provider, "openrouter");
  // The priced provider calls win over the harness total.
  assert.equal(report.costSource, "llm_calls");
  assert.equal(report.costUsd, 0.006);
  assert.equal(report.pricedCalls, 2);
  assert.equal(report.tokensIn, 2100);
  assert.equal(report.tokensOut, 420);
  assert.equal(report.tokensCached, 100);
  assert.equal(report.durationMs, 3200);
  assert.equal(report.numTurns, 2);
  assert.equal(report.calls.length, 2);
  assert.equal(report.byProvider.length, 1);
  assert.equal(report.byProvider[0]!.provider, "openrouter");
  assert.equal(report.byProvider[0]!.costUsd, 0.006);
  assert.equal(report.byProvider[0]!.okCalls, 2);
  assert.equal(report.byProvider[0]!.tokensIn, 2100);
  assert.equal(report.byProvider[0]!.tokensOut, 420);
  assert.equal(report.byProvider[0]!.avgLatencyMs, 800);
  assert.equal(report.byProvider[0]!.avgTtftMs, 200);
  assert.equal(report.totalLatencyMs, 1600);
  assert.equal(report.avgLatencyMs, 800);
});

test("aggregation reads a recorded log: the latency waterfall per attempt", () => {
  const log = recordedLog();
  const runId = "run_cost_2";
  llmCall(log.bus, runId, {
    provider: "a",
    model: "m1",
    attempt: 1,
    outcome: "ok",
    latencyMs: 50,
    queuedMs: 5,
    ttftMs: 30,
    inputTokens: 5,
    outputTokens: 5,
    costUsd: 0.0005,
  });
  llmCall(log.bus, runId, {
    provider: "b",
    model: "m2",
    attempt: 2,
    outcome: "429",
    latencyMs: 20,
    queuedMs: 3,
    costUsd: null,
  });
  llmCall(log.bus, runId, {
    provider: "c",
    model: "m3",
    attempt: 3,
    outcome: "ok",
    latencyMs: 1500,
    queuedMs: 120,
    ttftMs: 640,
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.002,
  });

  const report = aggregateRunCostLatency(runId, log.events(runId));
  const first = report.calls[0]!;
  const failed = report.calls[1]!;
  const last = report.calls[2]!;

  assert.equal(report.calls.length, 3);
  assert.equal(first.outcome, "ok");
  assert.equal(first.queuedMs, 5);
  assert.equal(first.ttftMs, 30);
  assert.equal(failed.outcome, "429");
  // A failed attempt costs nothing.
  assert.equal(failed.costUsd, null);
  assert.equal(report.costUsd, 0.0025);
  assert.equal(report.costSource, "llm_calls");
  assert.equal(last.provider, "c");
  assert.equal(last.queuedMs, 120);
  assert.equal(last.ttftMs, 640);
  assert.equal(last.latencyMs, 1500);
  // The serving provider changed between successful calls: a model switch.
  assert.equal(report.modelSwitches.length, 1);
  assert.equal(report.modelSwitches[0]!.fromProvider, "a");
  assert.equal(report.modelSwitches[0]!.toProvider, "c");
  assert.equal(report.modelSwitches[0]!.toModel, "m3");
  // Only the last successful attempt moved the serving provider.
  assert.equal(report.provider, "c");
  assert.equal(report.byProvider.length, 3);
  assert.equal(report.byProvider[0]!.provider, "c");
  assert.equal(report.byProvider[0]!.costUsd, 0.002);
  assert.equal(report.byProvider[1]!.provider, "a");
  assert.equal(report.byProvider[1]!.costUsd, 0.0005);
  assert.equal(report.byProvider[2]!.provider, "b");
  assert.equal(report.byProvider[2]!.costUsd, 0);
  assert.equal(report.totalLatencyMs, 1570);
});

test("aggregation falls back to the run's reported cost when no provider priced a call", () => {
  const log = recordedLog();
  const runId = "run_cost_3";
  log.bus.publish(runId, { type: "run.started", model: "claude-sonnet", provider: "fake-local" } as TelemetryEvent);
  log.bus.publish(runId, { type: "usage", inputTokens: 72, outputTokens: 24, cachedTokens: 0 } as TelemetryEvent);
  log.bus.publish(runId, { type: "run.finished", costUsd: 0.001, durationMs: 1200, numTurns: 1 } as TelemetryEvent);

  const report = aggregateRunCostLatency(runId, log.events(runId));

  assert.equal(report.costSource, "run_finished");
  assert.equal(report.costUsd, 0.001);
  assert.equal(report.pricedCalls, 0);
  assert.equal(report.tokensIn, 72);
  assert.equal(report.tokensOut, 24);
  // The reported total is attributed to the provider that served the run.
  assert.equal(report.byProvider.length, 1);
  assert.equal(report.byProvider[0]!.provider, "fake-local");
  assert.equal(report.byProvider[0]!.costUsd, 0.001);
});

test("expectedNextCallUsd is the mean cost of the run's priced calls", () => {
  const log = recordedLog();
  const runId = "run_cost_4";
  llmCall(log.bus, runId, {
    provider: "p",
    model: "m",
    attempt: 1,
    outcome: "ok",
    latencyMs: 10,
    costUsd: 0.002,
  });
  llmCall(log.bus, runId, {
    provider: "p",
    model: "m",
    attempt: 2,
    outcome: "ok",
    latencyMs: 10,
    costUsd: 0.004,
  });
  llmCall(log.bus, runId, {
    provider: "p",
    model: "m",
    attempt: 3,
    outcome: "500",
    latencyMs: 10,
    costUsd: null,
  });

  const report = aggregateRunCostLatency(runId, log.events(runId));
  assert.equal(expectedNextCallUsd(report), 0.003);

  const empty = aggregateRunCostLatency("run_empty", []);
  assert.equal(expectedNextCallUsd(empty), 0);
});

test("projectRunBudget warns at 80% of the cap and stops at 100%", () => {
  assert.equal(projectRunBudget({ spentUsd: 0.1, limitUsd: 1 }).status, "ok");
  assert.equal(projectRunBudget({ spentUsd: 0.1, limitUsd: 1 }).fraction, 0.1);

  const warn = projectRunBudget({ spentUsd: 0.8, limitUsd: 1 });
  assert.equal(warn.status, "warn");
  assert.equal(warn.fraction, BUDGET_WARN_FRACTION);

  // The projection adds the expected cost of the next call.
  const projected = projectRunBudget({ spentUsd: 0.75, limitUsd: 1, expectedNextCallUsd: 0.1 });
  assert.equal(projected.projectedUsd, 0.85);
  assert.equal(projected.status, "warn");

  const over = projectRunBudget({ spentUsd: 0.9, limitUsd: 1, expectedNextCallUsd: 0.2 });
  assert.equal(over.status, "exceeded");
  assert.equal(over.projectedUsd, 1.1);
  assert.equal(over.fraction, 1.1);

  // No cap: nothing to warn about.
  const uncapped = projectRunBudget({ spentUsd: 5, limitUsd: null });
  assert.equal(uncapped.status, "uncapped");
  assert.equal(uncapped.fraction, null);

  // A cap of zero means "no paid spend at all": any spend is over budget.
  assert.equal(projectRunBudget({ spentUsd: 0, limitUsd: 0 }).status, "ok");
  assert.equal(projectRunBudget({ spentUsd: 0.001, limitUsd: 0 }).status, "exceeded");
});

test("a recorded log with no events aggregates to an empty report", () => {
  const report = aggregateRunCostLatency("run_nothing", []);
  assert.equal(report.costUsd, 0);
  assert.equal(report.costSource, "none");
  assert.equal(report.calls.length, 0);
  assert.equal(report.byProvider.length, 0);
  assert.equal(report.modelSwitches.length, 0);
  assert.equal(report.provider, "unknown");
  assert.deepEqual(report.calls, []);
});
