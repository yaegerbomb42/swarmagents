/**
 * Tests for per-run token accounting (lib/telemetry/run-token-accounting.ts):
 * per-provider/model aggregation from llm.call telemetry, unknown-price
 * handling, provider-reported cost counting, lens exclusion, and the
 * harness usage fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SequencedEvent } from "./bus";
import { aggregateRunTokenAccounting } from "./run-token-accounting";

function seq(overrides: Record<string, unknown>): SequencedEvent {
  return { runId: "run_1", seq: 1, ts: 1_000, ...overrides } as unknown as SequencedEvent;
}

function llmCall(data: Record<string, unknown>): SequencedEvent {
  return seq({ type: "llm.call", data });
}

test("aggregates llm.call events per provider/model with totals", () => {
  const accounting = aggregateRunTokenAccounting([
    llmCall({ provider: "anthropic", model: "claude-sonnet-4-5", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 1000, outputTokens: 200, costUsd: 0.006 }),
    llmCall({ provider: "anthropic", model: "claude-sonnet-4-5", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 500, outputTokens: 100, costUsd: 0.003 }),
    llmCall({ provider: "groq", model: "llama-3.1-8b-instant", attempt: 1, outcome: "429", latencyMs: 5, costUsd: null }),
    llmCall({ provider: "groq", model: "llama-3.1-8b-instant", attempt: 2, outcome: "ok", latencyMs: 8, inputTokens: 300, outputTokens: 50, costUsd: 0.0001 }),
  ]);
  assert.ok(accounting);
  assert.equal(accounting.byModel.length, 2);
  // Busiest first.
  const [sonnet, groq] = accounting.byModel;
  assert.equal(sonnet.provider, "anthropic");
  assert.equal(sonnet.calls, 2);
  assert.equal(sonnet.okCalls, 2);
  assert.equal(sonnet.inputTokens, 1500);
  assert.equal(sonnet.outputTokens, 300);
  assert.ok(Math.abs((sonnet.costUsd ?? 0) - 0.009) < 1e-9);
  assert.equal(sonnet.unknownCostCalls, 0);
  assert.equal(groq.calls, 2);
  assert.equal(groq.okCalls, 1);
  assert.equal(groq.inputTokens, 300);
  assert.equal(groq.unknownCostCalls, 1);
  assert.equal(accounting.totals.calls, 4);
  assert.equal(accounting.totals.okCalls, 3);
  assert.equal(accounting.totals.inputTokens, 1800);
  assert.equal(accounting.totals.outputTokens, 350);
  assert.ok(Math.abs((accounting.totals.costUsd ?? 0) - 0.0091) < 1e-9);
  assert.equal(accounting.totals.unknownCostCalls, 1);
  assert.equal(accounting.harness, undefined);
});

test("unknown pricing stays unknown — never an invented number", () => {
  const accounting = aggregateRunTokenAccounting([
    llmCall({ provider: "inception", model: "mercury-3", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 100, outputTokens: 10, costUsd: null }),
    llmCall({ provider: "inception", model: "mercury-3", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 100, outputTokens: 10, costUsd: null }),
  ]);
  assert.ok(accounting);
  assert.equal(accounting.byModel[0].costUsd, undefined);
  assert.equal(accounting.byModel[0].unknownCostCalls, 2);
  assert.equal(accounting.totals.costUsd, undefined);
  assert.equal(accounting.totals.unknownCostCalls, 2);
});

test("free providers report a real $0, distinct from unknown", () => {
  const accounting = aggregateRunTokenAccounting([
    llmCall({ provider: "ollama", model: "llama3", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 10, outputTokens: 5, costUsd: 0 }),
  ]);
  assert.ok(accounting);
  assert.equal(accounting.byModel[0].costUsd, 0);
  assert.equal(accounting.totals.costUsd, 0);
});

test("lens calls are excluded from the run's own accounting", () => {
  const accounting = aggregateRunTokenAccounting([
    llmCall({ provider: "anthropic", model: "claude-haiku-4-5", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 10, outputTokens: 5, costUsd: 0.001, source: "lens" }),
    llmCall({ provider: "anthropic", model: "claude-sonnet-4-5", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 100, outputTokens: 20, costUsd: 0.002 }),
  ]);
  assert.ok(accounting);
  assert.equal(accounting.byModel.length, 1);
  assert.equal(accounting.byModel[0].model, "claude-sonnet-4-5");
  assert.equal(accounting.totals.calls, 1);
});

test("harness usage events are summed apart from gateway calls", () => {
  const accounting = aggregateRunTokenAccounting([
    seq({ type: "usage", inputTokens: 100, outputTokens: 20, cachedTokens: 50 }),
    seq({ type: "usage", inputTokens: 200, outputTokens: 30 }),
    llmCall({ provider: "openai", model: "gpt-4o-mini", attempt: 1, outcome: "ok", latencyMs: 5, inputTokens: 300, outputTokens: 50, costUsd: 0.001 }),
  ]);
  assert.ok(accounting);
  assert.deepEqual(accounting.harness, { inputTokens: 300, outputTokens: 50, cachedTokens: 50 });
  assert.equal(accounting.totals.inputTokens, 300);
});

test("usage-only runs still produce accounting (harness fallback)", () => {
  const accounting = aggregateRunTokenAccounting([
    seq({ type: "usage", inputTokens: 42, outputTokens: 7, cachedTokens: 3 }),
  ]);
  assert.ok(accounting);
  assert.deepEqual(accounting.byModel, []);
  assert.equal(accounting.totals.calls, 0);
  assert.deepEqual(accounting.harness, { inputTokens: 42, outputTokens: 7, cachedTokens: 3 });
});

test("no usage telemetry at all → undefined, so old reports stay clean", () => {
  assert.equal(aggregateRunTokenAccounting([]), undefined);
  assert.equal(
    aggregateRunTokenAccounting([
      seq({ type: "run.started", model: "m", provider: "p" }),
      seq({ type: "assistant.text", text: "hi" }),
      seq({ type: "run.finished", exitCode: 0, sessionId: "s" }),
    ]),
    undefined,
  );
});

test("malformed llm.call payloads degrade to unknown provider/model, never throw", () => {
  const accounting = aggregateRunTokenAccounting([
    llmCall({ outcome: "ok" }),
    seq({ type: "llm.call" }),
    seq({ type: "llm.call", data: "nope" }),
  ]);
  assert.ok(accounting);
  assert.equal(accounting.totals.calls, 3);
  assert.equal(accounting.byModel[0].provider, "unknown");
  assert.equal(accounting.byModel[0].model, "unknown");
  assert.equal(accounting.byModel[0].unknownCostCalls, 3);
});

test("provider-reported costs are counted apart from estimates", () => {
  const accounting = aggregateRunTokenAccounting([
    // Perplexity Agent API: costUsd is the reported amount (usage.cost).
    llmCall({ provider: "perplexity", model: "perplexity/sonar", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 2000, outputTokens: 1000, costUsd: 0.00675, costReported: true }),
    llmCall({ provider: "perplexity", model: "perplexity/sonar", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 100, outputTokens: 50, costUsd: 0.001, costReported: true }),
    // Anthropic: costUsd is a price-table estimate.
    llmCall({ provider: "anthropic", model: "claude-sonnet-4-5", attempt: 1, outcome: "ok", latencyMs: 10, inputTokens: 1000, outputTokens: 200, costUsd: 0.006 }),
  ]);
  assert.ok(accounting);
  const perplexity = accounting.byModel.find((m) => m.provider === "perplexity");
  assert.ok(perplexity);
  assert.ok(Math.abs((perplexity.costUsd ?? 0) - 0.00775) < 1e-9);
  assert.equal(perplexity.reportedCostCalls, 2);
  const anthropic = accounting.byModel.find((m) => m.provider === "anthropic");
  assert.ok(anthropic);
  assert.equal(anthropic.reportedCostCalls, 0);
  assert.equal(accounting.totals.reportedCostCalls, 2);
});

test("costReported on an unpriced call does not count as reported", () => {
  const accounting = aggregateRunTokenAccounting([
    llmCall({ provider: "perplexity", model: "perplexity/sonar", attempt: 1, outcome: "error", latencyMs: 5, costUsd: null, costReported: true }),
  ]);
  assert.ok(accounting);
  assert.equal(accounting.byModel[0].reportedCostCalls, 0);
  assert.equal(accounting.byModel[0].unknownCostCalls, 1);
  assert.equal(accounting.totals.reportedCostCalls, 0);
});
