/**
 * Unit tests for LLM cost estimation (lib/providers/pricing.ts):
 * free providers cost $0, configured prices override the built-in table,
 * unknown pairs estimate to undefined (shown as "unknown" in the UI).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredPrice,
  estimateCostUsd,
  isFreeProvider,
  priceForModel,
} from "./pricing";
import type { ProviderConfig } from "./types";

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: "anthropic", kind: "anthropic", models: {}, keys: [], ...overrides };
}

test("isFreeProvider flags only explicit free providers", () => {
  assert.equal(isFreeProvider({ isFree: true }), true);
  assert.equal(isFreeProvider({ isFree: false }), false);
  assert.equal(isFreeProvider({}), false);
});

test("priceForModel resolves known table entries and returns undefined for unknown pairs", () => {
  assert.deepEqual(priceForModel("anthropic", "claude-sonnet-4-5"), {
    inputPer1m: 3,
    outputPer1m: 15,
  });
  assert.deepEqual(priceForModel("openai", "gpt-4o-mini"), {
    inputPer1m: 0.15,
    outputPer1m: 0.6,
  });
  assert.equal(priceForModel("nope", "x"), undefined);
  assert.equal(priceForModel("anthropic", "mystery-model"), undefined);
});

test("configuredPrice requires both price fields", () => {
  assert.deepEqual(
    configuredPrice({ inputPricePer1mTokens: 2, outputPricePer1mTokens: 8 }),
    { inputPer1m: 2, outputPer1m: 8 },
  );
  assert.equal(configuredPrice({ inputPricePer1mTokens: 2 }), undefined);
  assert.equal(configuredPrice({ outputPricePer1mTokens: 8 }), undefined);
  assert.equal(configuredPrice({}), undefined);
});

test("estimateCostUsd computes token-based cost from table prices", () => {
  const cost = estimateCostUsd(
    cfg(),
    "claude-sonnet-4-5",
    { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  );
  assert.equal(cost, 18); // $3/1M in + $15/1M out
});

test("estimateCostUsd: configured prices override the table", () => {
  const cost = estimateCostUsd(
    cfg({ inputPricePer1mTokens: 10, outputPricePer1mTokens: 20 }),
    "claude-sonnet-4-5",
    { inputTokens: 1_000, outputTokens: 500 },
  );
  assert.equal(cost, 0.02); // 0.01 + 0.01
});

test("estimateCostUsd: free providers always cost $0", () => {
  const cost = estimateCostUsd(
    cfg({ isFree: true }),
    "claude-sonnet-4-5",
    { inputTokens: 100_000_000, outputTokens: 100_000_000 },
  );
  assert.equal(cost, 0);
});

test("estimateCostUsd: unknown price -> undefined; malformed tokens treated as zero", () => {
  assert.equal(
    estimateCostUsd(cfg(), "mystery-model", { inputTokens: 100, outputTokens: 50 }),
    undefined,
  );
  assert.equal(estimateCostUsd(cfg(), "mystery-model", { inputTokens: -5, outputTokens: Number.NaN }), undefined);
});
