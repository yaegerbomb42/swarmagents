/**
 * Tests for token accounting in the assembled run report
 * (lib/runtime/run-report.ts + lib/telemetry/run-token-accounting.ts):
 * the report carries the per-model breakdown and the card meta carries
 * the run's token totals — and, since reportcard-meta-cost-provenance,
 * the card's cost figure + provenance (gateway total when the run
 * crossed the gateway, else the harness CLI's estimate).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SequencedEvent } from "../telemetry/bus";
import { assembleReport } from "./run-report";

function seq(overrides: Record<string, unknown>): SequencedEvent {
  return { runId: "run_1", seq: 1, ts: 1_000, ...overrides } as unknown as SequencedEvent;
}

function assemble(events: SequencedEvent[]) {
  return assembleReport({
    runId: "run_1",
    userId: "alice",
    events,
    createdAt: 1_000,
    finishedAt: 6_000,
    artifacts: [],
    shots: [],
  });
}

const BASE: SequencedEvent[] = [
  seq({ type: "run.created", seq: 1, data: { prompt: "build it", userId: "alice" } }),
  seq({ type: "run.started", seq: 2, model: "claude-sonnet-4-5", provider: "anthropic" }),
  seq({ type: "run.finished", seq: 9, exitCode: 0, sessionId: "s1", costUsd: 0.01, durationMs: 5000, numTurns: 2 }),
];

test("report carries per-model accounting and card token totals from llm.call events", () => {
  const report = assemble([
    ...BASE,
    seq({
      type: "llm.call",
      seq: 3,
      data: { provider: "anthropic", model: "claude-sonnet-4-5", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 2000, outputTokens: 300, costUsd: 0.0105 },
    }),
    seq({
      type: "llm.call",
      seq: 4,
      data: { provider: "groq", model: "llama-3.1-8b-instant", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 100, outputTokens: 20, costUsd: null },
    }),
  ]);
  assert.ok(report.tokenAccounting);
  assert.equal(report.tokenAccounting.byModel.length, 2);
  assert.equal(report.tokenAccounting.totals.inputTokens, 2100);
  assert.equal(report.tokenAccounting.totals.outputTokens, 320);
  assert.equal(report.tokenAccounting.totals.costUsd, 0.0105);
  assert.equal(report.tokenAccounting.totals.unknownCostCalls, 1);
  assert.equal(report.meta.tokensIn, 2100);
  assert.equal(report.meta.tokensOut, 320);
  // The card cost is the gateway total (the accounting of record), not
  // the run.finished figure (the harness CLI's own estimate) — and its
  // provenance says so: the one priced call carried no reported amount.
  assert.equal(report.meta.costUsd, 0.0105);
  assert.equal(report.meta.costProvenance, "estimated");
});

test("meta cost provenance is reported when every priced gateway call reported its amount", () => {
  const report = assemble([
    ...BASE,
    seq({
      type: "llm.call",
      seq: 3,
      data: { provider: "perplexity", model: "perplexity/sonar", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 2000, outputTokens: 1000, costUsd: 0.00675, costReported: true },
    }),
    seq({
      type: "llm.call",
      seq: 4,
      data: { provider: "perplexity", model: "perplexity/sonar", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 100, outputTokens: 50, costUsd: 0.001, costReported: true },
    }),
  ]);
  assert.ok(report.tokenAccounting);
  assert.ok(Math.abs((report.tokenAccounting.totals.costUsd ?? 0) - 0.00775) < 1e-9);
  // The card figure is the reported total — the run.finished estimate
  // (0.01) does not describe what the provider charged.
  assert.ok(Math.abs((report.meta.costUsd ?? 0) - 0.00775) < 1e-9);
  assert.equal(report.meta.costProvenance, "reported");
});

test("meta cost provenance is mixed when reported and estimated calls share a run", () => {
  const report = assemble([
    ...BASE,
    seq({
      type: "llm.call",
      seq: 3,
      data: { provider: "perplexity", model: "perplexity/sonar", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 1000, outputTokens: 100, costUsd: 0.004, costReported: true },
    }),
    seq({
      type: "llm.call",
      seq: 4,
      data: { provider: "anthropic", model: "claude-sonnet-4-5", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 1000, outputTokens: 100, costUsd: 0.006 },
    }),
    seq({
      type: "llm.call",
      seq: 5,
      data: { provider: "groq", model: "llama-3.1-8b-instant", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 100, outputTokens: 20, costUsd: null },
    }),
  ]);
  assert.ok(report.tokenAccounting);
  assert.ok(Math.abs((report.meta.costUsd ?? 0) - 0.01) < 1e-9);
  assert.equal(report.meta.costProvenance, "mixed");
});

test("free gateway runs carry a $0 meta cost with no provenance (figure stands bare)", () => {
  const report = assemble([
    ...BASE,
    seq({
      type: "llm.call",
      seq: 3,
      data: { provider: "inception", model: "mercury-3", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 900, outputTokens: 120, costUsd: 0 },
    }),
  ]);
  assert.ok(report.tokenAccounting);
  // The gateway total ($0 actual) wins over the CLI's priced estimate.
  assert.equal(report.meta.costUsd, 0);
  assert.equal(report.meta.costProvenance, undefined);
});

test("unpriced gateway runs fall back to the run.finished figure, labeled estimated", () => {
  const report = assemble([
    ...BASE,
    seq({
      type: "llm.call",
      seq: 3,
      data: { provider: "inception", model: "mercury-3", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 900, outputTokens: 120, costUsd: null },
    }),
  ]);
  assert.ok(report.tokenAccounting);
  assert.equal(report.tokenAccounting.totals.costUsd, undefined);
  // No gateway figure exists, so the CLI's estimate is the card figure.
  assert.equal(report.meta.costUsd, 0.01);
  assert.equal(report.meta.costProvenance, "estimated");
});

test("card token totals fall back to harness usage when no gateway calls exist", () => {
  const report = assemble([
    ...BASE,
    seq({ type: "usage", seq: 3, inputTokens: 500, outputTokens: 60, cachedTokens: 100 }),
    seq({ type: "usage", seq: 4, inputTokens: 250, outputTokens: 40 }),
  ]);
  assert.ok(report.tokenAccounting);
  assert.deepEqual(report.tokenAccounting.byModel, []);
  assert.deepEqual(report.tokenAccounting.harness, {
    inputTokens: 750,
    outputTokens: 100,
    cachedTokens: 100,
  });
  assert.equal(report.meta.tokensIn, 750);
  assert.equal(report.meta.tokensOut, 100);
  // No gateway figure: the card cost is the harness CLI's estimate.
  assert.equal(report.meta.costUsd, 0.01);
  assert.equal(report.meta.costProvenance, "estimated");
});

test("runs without usage telemetry get no accounting fields (old reports unchanged)", () => {
  const report = assemble(BASE);
  assert.equal(report.tokenAccounting, undefined);
  assert.equal(report.meta.tokensIn, undefined);
  assert.equal(report.meta.tokensOut, undefined);
  // The run.finished figure still lands, now honestly labeled.
  assert.equal(report.meta.costUsd, 0.01);
  assert.equal(report.meta.costProvenance, "estimated");
});
