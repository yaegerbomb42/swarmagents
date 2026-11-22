/**
 * Tests for chat-path provider-reported cost wiring (xAI
 * `usage.cost_in_usd_ticks`, 1 USD = 10^10 ticks — docs.x.ai/developers/
 * cost-tracking): the direct parseResponse openai-chat branch and the
 * streaming chunk stamper. The parser itself (parseReportedCostUsd) is
 * covered in responses-usage-cost.test.ts; these tests pin that the chat
 * paths call it and stay byte-identical when no cost is reported.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseResponse } from "./adapters";
import { costWasReported, estimateCostUsd } from "./pricing";
import type { ProviderConfig } from "./types";
import { chatChunkWithReportedCost } from "./wire-shims";

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: "xai", kind: "openai", apiStyle: "openai-chat", models: {}, keys: [], ...overrides };
}

function chatBody(usage: Record<string, unknown>) {
  return {
    choices: [{ message: { content: "hi" } }],
    model: "grok-4",
    usage,
  };
}

test("parseResponse (chat) converts cost_in_usd_ticks to costUsd", () => {
  // The xAI docs' example: 158,500 ticks = $0.00001585.
  const parsed = parseResponse(
    cfg(),
    chatBody({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost_in_usd_ticks: 158_500 }),
    "grok-4",
  );
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 4, costUsd: 0.00001585 });

  // A reported $0 is a real cost, not "unknown".
  const zero = parseResponse(
    cfg(),
    chatBody({ prompt_tokens: 10, completion_tokens: 4, cost_in_usd_ticks: 0 }),
    "grok-4",
  );
  assert.deepEqual(zero.usage, { inputTokens: 10, outputTokens: 4, costUsd: 0 });
});

test("parseResponse (chat) without a cost field is unchanged", () => {
  const parsed = parseResponse(cfg(), chatBody({ prompt_tokens: 10, completion_tokens: 4 }), "grok-4");
  // No costUsd key at all — byte-identical to the pre-wiring shape.
  assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 4 });
});

test("parseResponse (chat) ignores malformed or negative ticks (fail-open)", () => {
  for (const bad of [-5, "158500", Number.NaN, Number.POSITIVE_INFINITY, null]) {
    const parsed = parseResponse(
      cfg(),
      chatBody({ prompt_tokens: 10, completion_tokens: 4, cost_in_usd_ticks: bad }),
      "grok-4",
    );
    assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 4 }, `ticks=${String(bad)}`);
  }
});

test("parseResponse (chat) is shape-based: any chat provider's reported cost is recorded", () => {
  // The parser keys on the usage shape, not the provider id — a ticks (or
  // cost-object) field from any OpenAI-wire chat provider is honored, and
  // providers that send neither (OpenAI, Groq, …) are untouched.
  const openaiNoCost = parseResponse(
    cfg({ id: "openai" }),
    chatBody({ prompt_tokens: 10, completion_tokens: 4 }),
    "gpt-5",
  );
  assert.deepEqual(openaiNoCost.usage, { inputTokens: 10, outputTokens: 4 });

  const costObject = parseResponse(
    cfg(),
    chatBody({ prompt_tokens: 10, completion_tokens: 4, cost: { currency: "USD", total_cost: 0.25 } }),
    "grok-4",
  );
  assert.deepEqual(costObject.usage, { inputTokens: 10, outputTokens: 4, costUsd: 0.25 });
});

test("chatChunkWithReportedCost stamps cost_usd on the final usage chunk", () => {
  // xAI REST streaming: cost rides the final chunk (empty choices) when
  // stream_options.include_usage is set, which the bridge always sends.
  const finalChunk = {
    model: "grok-4",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost_in_usd_ticks: 158_500 },
  };
  const stamped = chatChunkWithReportedCost(finalChunk);
  assert.deepEqual(stamped.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    cost_in_usd_ticks: 158_500,
    cost_usd: 0.00001585,
  });
  // The input chunk is not mutated.
  assert.deepEqual(finalChunk.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    cost_in_usd_ticks: 158_500,
  });
});

test("chatChunkWithReportedCost returns chunks unchanged when no cost parses", () => {
  const noUsage = { model: "grok-4", choices: [{ index: 0, delta: { content: "hi" } }] };
  assert.equal(chatChunkWithReportedCost(noUsage), noUsage);

  const usageNoCost = { model: "gpt-5", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } };
  assert.equal(chatChunkWithReportedCost(usageNoCost), usageNoCost);

  const badTicks = { model: "grok-4", choices: [], usage: { prompt_tokens: 3, cost_in_usd_ticks: -1 } };
  assert.equal(chatChunkWithReportedCost(badTicks), badTicks);

  // Non-record chunks pass through untouched.
  assert.equal(chatChunkWithReportedCost("nope") as unknown, "nope");
  assert.equal(chatChunkWithReportedCost(null) as unknown, null);
});

test("estimateCostUsd prefers the chat-reported cost for xAI configs", () => {
  const parsed = parseResponse(
    cfg(),
    chatBody({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, cost_in_usd_ticks: 158_500 }),
    "grok-4",
  );
  assert.equal(estimateCostUsd(cfg(), "grok-4", parsed.usage), 0.00001585);
  assert.equal(costWasReported(cfg(), parsed.usage), true);
  assert.equal(costWasReported(cfg(), { inputTokens: 1, outputTokens: 1 }), false);
});
