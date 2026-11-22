/**
 * Tests for provider-reported cost capture (Responses `usage.cost`):
 * the wire parser (parseReportedCostUsd), the Responses shims, the direct
 * parseResponse path, and pricing's preference for reported over estimated
 * cost. Shapes per docs.perplexity.ai/api-reference/agent-post (Perplexity
 * Agent API) and docs.x.ai/developers/cost-tracking (xAI ticks).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseResponse } from "./adapters";
import { costWasReported, estimateCostUsd, providerReportedCostUsd } from "./pricing";
import type { ProviderConfig } from "./types";
import {
  newResponsesStreamState,
  parseReportedCostUsd,
  responsesEventToChunks,
  responsesToOpenAIResponse,
} from "./wire-shims";

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: "perplexity", kind: "openai", apiStyle: "openai-responses", models: {}, keys: [], ...overrides };
}

/** Perplexity Agent API usage object, per the official response schema. */
const perplexityUsage = {
  input_tokens: 2000,
  output_tokens: 1000,
  total_tokens: 3000,
  cost: {
    currency: "USD",
    input_cost: 0.004,
    output_cost: 0.002,
    total_cost: 0.00675,
    cache_creation_cost: 0,
    cache_read_cost: 0,
    tool_calls_cost: 0.00075,
    tool_calls_cost_details: {},
  },
  input_tokens_details: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  tool_calls_details: {},
};

test("parseReportedCostUsd reads the Perplexity cost object", () => {
  assert.equal(parseReportedCostUsd(perplexityUsage), 0.00675);
  // Currency absent or lowercase usd is still USD.
  assert.equal(parseReportedCostUsd({ cost: { total_cost: 1.5 } }), 1.5);
  assert.equal(parseReportedCostUsd({ cost: { currency: "usd", total_cost: 1.5 } }), 1.5);
  // A reported $0 is a real cost, not "unknown".
  assert.equal(parseReportedCostUsd({ cost: { currency: "USD", total_cost: 0 } }), 0);
});

test("parseReportedCostUsd rejects non-USD, malformed and negative costs (fail-open)", () => {
  assert.equal(parseReportedCostUsd({ cost: { currency: "EUR", total_cost: 1.5 } }), undefined);
  assert.equal(parseReportedCostUsd({ cost: { currency: "USD", total_cost: -1 } }), undefined);
  assert.equal(parseReportedCostUsd({ cost: { currency: "USD", total_cost: "0.01" } }), undefined);
  assert.equal(parseReportedCostUsd({ cost: { currency: "USD" } }), undefined);
  assert.equal(parseReportedCostUsd({ cost: Number.NaN }), undefined);
  assert.equal(parseReportedCostUsd({ cost: Number.POSITIVE_INFINITY }), undefined);
  assert.equal(parseReportedCostUsd({}), undefined);
  assert.equal(parseReportedCostUsd(undefined), undefined);
  assert.equal(parseReportedCostUsd("nope"), undefined);
  assert.equal(parseReportedCostUsd(null), undefined);
});

test("parseReportedCostUsd accepts a flattened numeric cost and xAI ticks", () => {
  assert.equal(parseReportedCostUsd({ cost: 0.25 }), 0.25);
  // xAI: 1 USD = 10^10 ticks; the docs' example is 158,500 ticks = $0.00001585.
  assert.equal(parseReportedCostUsd({ cost_in_usd_ticks: 158_500 }), 0.00001585);
  assert.equal(parseReportedCostUsd({ cost_in_usd_ticks: 0 }), 0);
  assert.equal(parseReportedCostUsd({ cost_in_usd_ticks: -5 }), undefined);
  // When both shapes appear, the explicit cost object wins.
  assert.equal(
    parseReportedCostUsd({ cost: { currency: "USD", total_cost: 2 }, cost_in_usd_ticks: 10_000_000_000 }),
    2,
  );
});

test("responsesToOpenAIResponse carries cost_usd only when reported", () => {
  const withCost = responsesToOpenAIResponse(
    {
      id: "resp_1",
      model: "perplexity/sonar",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
      usage: perplexityUsage,
    },
    "fallback",
  );
  assert.deepEqual(withCost.usage, { prompt_tokens: 2000, completion_tokens: 1000, cost_usd: 0.00675 });

  const withoutCost = responsesToOpenAIResponse(
    {
      id: "resp_1",
      model: "gpt-5",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    "fallback",
  );
  // Byte-identical to the pre-cost shim output.
  assert.deepEqual(withoutCost.usage, { prompt_tokens: 10, completion_tokens: 4 });
});

test("responsesEventToChunks puts cost_usd on the terminal chunk only when reported", () => {
  const state = newResponsesStreamState("perplexity/sonar");
  const done = responsesEventToChunks(
    { type: "response.completed", response: { usage: perplexityUsage } },
    state,
  );
  assert.deepEqual(done[0]?.usage, { prompt_tokens: 2000, completion_tokens: 1000, cost_usd: 0.00675 });

  const plain = newResponsesStreamState("gpt-5");
  const plainDone = responsesEventToChunks(
    { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2 } } },
    plain,
  );
  assert.deepEqual(plainDone[0]?.usage, { prompt_tokens: 3, completion_tokens: 2 });
});

test("parseResponse (Responses) records the reported cost on TokenUsage", () => {
  const parsed = parseResponse(
    cfg(),
    { output_text: "hi", model: "perplexity/sonar", usage: perplexityUsage },
    "perplexity/sonar",
  );
  assert.deepEqual(parsed.usage, { inputTokens: 2000, outputTokens: 1000, costUsd: 0.00675 });

  const noCost = parseResponse(
    cfg(),
    { output_text: "hi", model: "gpt-5", usage: { input_tokens: 10, output_tokens: 4 } },
    "gpt-5",
  );
  assert.deepEqual(noCost.usage, { inputTokens: 10, outputTokens: 4 });
});

test("parseResponse leaves anthropic style untouched", () => {
  // The openai-chat half of this test moved to chat-usage-cost.test.ts when
  // chat-path cost wiring landed (xAI cost_in_usd_ticks); anthropic usage
  // carries no cost field in either documented shape and stays untouched.
  const anthropic = parseResponse(
    cfg({ id: "anthropic", kind: "anthropic", apiStyle: "anthropic" }),
    {
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 10, output_tokens: 4, cost: { currency: "USD", total_cost: 9 } },
    },
    "claude-sonnet-4-5",
  );
  assert.deepEqual(anthropic.usage, { inputTokens: 10, outputTokens: 4 });
});

test("estimateCostUsd prefers the provider-reported cost over estimates", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 0.00675 };
  // Perplexity has no price-table entry: without the reported cost this
  // would be undefined ("unknown").
  assert.equal(estimateCostUsd(cfg(), "perplexity/sonar", usage), 0.00675);
  // Reported beats configured prices and the table too.
  assert.equal(
    estimateCostUsd(
      cfg({ id: "anthropic", kind: "anthropic", inputPricePer1mTokens: 10, outputPricePer1mTokens: 20 }),
      "claude-sonnet-4-5",
      usage,
    ),
    0.00675,
  );
  // A reported $0 stays $0 (priced, not unknown).
  assert.equal(estimateCostUsd(cfg(), "perplexity/sonar", { ...usage, costUsd: 0 }), 0);
});

test("estimateCostUsd: free wins over reported; malformed reported falls back", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 5 };
  assert.equal(estimateCostUsd(cfg({ isFree: true }), "perplexity/sonar", usage), 0);
  assert.equal(
    estimateCostUsd(cfg({ id: "anthropic", kind: "anthropic" }), "claude-sonnet-4-5", { ...usage, costUsd: Number.NaN }),
    18,
  );
  assert.equal(
    estimateCostUsd(cfg({ id: "anthropic", kind: "anthropic" }), "claude-sonnet-4-5", { ...usage, costUsd: -1 }),
    18,
  );
  assert.equal(providerReportedCostUsd({ inputTokens: 1, outputTokens: 1 }), undefined);
  assert.equal(costWasReported(cfg(), usage), true);
  assert.equal(costWasReported(cfg({ isFree: true }), usage), false);
  assert.equal(costWasReported(cfg(), { inputTokens: 1, outputTokens: 1 }), false);
});
