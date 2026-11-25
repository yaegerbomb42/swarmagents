/**
 * Unit tests for the token-budget aggregator: totals, cache hit rate,
 * context utilization, and estimated cache savings — including every
 * missing/zero/malformed usage shape a provider can report.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { aggregateTokenBudget } from "./tokenBudget";

test("empty input reports no usage and null rates", () => {
  const budget = aggregateTokenBudget([]);
  assert.equal(budget.turns, 0);
  assert.equal(budget.turnsWithUsage, 0);
  assert.equal(budget.hasUsage, false);
  assert.equal(budget.totalInputTokens, 0);
  assert.equal(budget.totalOutputTokens, 0);
  assert.equal(budget.totalCachedTokens, 0);
  assert.equal(budget.cacheHitRatePct, null);
  assert.equal(budget.contextUtilizationPct, null);
  assert.equal(budget.estimatedSavedUsd, null);
  assert.equal(budget.model, undefined);
  assert.equal(budget.contextWindowTokens, undefined);
});

test("a single turn sums its tokens and derives the hit rate", () => {
  const budget = aggregateTokenBudget([
    { inputTokens: 12_400, outputTokens: 800, cachedTokens: 10_000 },
  ]);
  assert.equal(budget.turns, 1);
  assert.equal(budget.turnsWithUsage, 1);
  assert.equal(budget.hasUsage, true);
  assert.equal(budget.totalInputTokens, 12_400);
  assert.equal(budget.totalOutputTokens, 800);
  assert.equal(budget.totalCachedTokens, 10_000);
  assert.equal(budget.cacheHitRatePct, 80.6);
  assert.equal(budget.contextUtilizationPct, null);
  assert.equal(budget.estimatedSavedUsd, null);
});

test("multiple turns accumulate, and the model label needs agreement", () => {
  const budget = aggregateTokenBudget([
    { inputTokens: 10_000, outputTokens: 500, cachedTokens: 8_000, model: "claude-sonnet-4-5" },
    { inputTokens: 5_000, outputTokens: 500, cachedTokens: 4_000, model: "claude-sonnet-4-5" },
    { inputTokens: 2_000, outputTokens: 100, cachedTokens: 0, model: "gpt-4.1" },
  ]);
  assert.equal(budget.turns, 3);
  assert.equal(budget.turnsWithUsage, 3);
  assert.equal(budget.totalInputTokens, 17_000);
  assert.equal(budget.totalOutputTokens, 1_100);
  assert.equal(budget.totalCachedTokens, 12_000);
  assert.equal(budget.cacheHitRatePct, 70.6);
  // Mixed models: no single label.
  assert.equal(budget.model, undefined);
});

test("one agreed model is carried as the label", () => {
  const budget = aggregateTokenBudget([
    { inputTokens: 1_000, outputTokens: 10, cachedTokens: 500, model: "gpt-4.1" },
    { inputTokens: 2_000, outputTokens: 20, cachedTokens: 1_000, model: "gpt-4.1" },
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0, model: "gpt-4.1" },
  ]);
  assert.equal(budget.model, "gpt-4.1");
  assert.equal(budget.turnsWithUsage, 2);
});

test("context utilization is input over the window, and can exceed 100", () => {
  const under = aggregateTokenBudget([{ inputTokens: 50_000 }], { contextWindowTokens: 200_000 });
  assert.equal(under.contextUtilizationPct, 25);
  assert.equal(under.contextWindowTokens, 200_000);
  const over = aggregateTokenBudget([{ inputTokens: 250_000 }], { contextWindowTokens: 200_000 });
  assert.equal(over.contextUtilizationPct, 125);
});

test("zero or missing window leaves utilization unknown", () => {
  assert.equal(aggregateTokenBudget([{ inputTokens: 1_000 }]).contextUtilizationPct, null);
  assert.equal(
    aggregateTokenBudget([{ inputTokens: 1_000 }], { contextWindowTokens: 0 }).contextUtilizationPct,
    null,
  );
  assert.equal(
    aggregateTokenBudget([{ inputTokens: 1_000 }], { contextWindowTokens: null }).contextUtilizationPct,
    null,
  );
  assert.equal(
    aggregateTokenBudget([{ inputTokens: 1_000 }], { contextWindowTokens: -5 }).contextUtilizationPct,
    null,
  );
});

test("missing fields read as zero; a turn with no counts has no usage", () => {
  const budget = aggregateTokenBudget([
    {},
    { inputTokens: undefined, outputTokens: null, cachedTokens: undefined },
    { inputTokens: 4_000 },
  ]);
  assert.equal(budget.turns, 3);
  assert.equal(budget.turnsWithUsage, 1);
  assert.equal(budget.hasUsage, true);
  assert.equal(budget.totalInputTokens, 4_000);
  assert.equal(budget.totalOutputTokens, 0);
  assert.equal(budget.totalCachedTokens, 0);
  assert.equal(budget.cacheHitRatePct, 0);
});

test("output-only usage counts as usage but has no hit rate", () => {
  const budget = aggregateTokenBudget([{ outputTokens: 300 }]);
  assert.equal(budget.hasUsage, true);
  assert.equal(budget.turnsWithUsage, 1);
  assert.equal(budget.totalInputTokens, 0);
  assert.equal(budget.cacheHitRatePct, null);
});

test("negative, NaN, and infinite counts are treated as zero", () => {
  const budget = aggregateTokenBudget([
    { inputTokens: -100, outputTokens: Number.NaN, cachedTokens: Number.POSITIVE_INFINITY },
    { inputTokens: 1_000, outputTokens: 50, cachedTokens: 200 },
  ]);
  assert.equal(budget.totalInputTokens, 1_000);
  assert.equal(budget.totalOutputTokens, 50);
  assert.equal(budget.totalCachedTokens, 200);
  assert.equal(budget.cacheHitRatePct, 20);
});

test("cached tokens above the input total are capped at the input total", () => {
  const budget = aggregateTokenBudget([{ inputTokens: 1_000, cachedTokens: 1_500 }]);
  assert.equal(budget.totalCachedTokens, 1_000);
  assert.equal(budget.cacheHitRatePct, 100);
});

test("estimated savings use the input price minus the cache-read price", () => {
  const budget = aggregateTokenBudget([{ inputTokens: 100_000, cachedTokens: 80_000 }], {
    prices: { inputPerMillionUsd: 3, cachedPerMillionUsd: 0.3 },
  });
  // 80k cached * ($3.00 - $0.30) / 1M = $0.216.
  assert.ok(
    budget.estimatedSavedUsd !== null && Math.abs(budget.estimatedSavedUsd - 0.216) < 1e-9,
    `expected $0.216 saved, got ${budget.estimatedSavedUsd}`,
  );
});

test("omitted cache-read price defaults to 10% of the input price", () => {
  const budget = aggregateTokenBudget([{ inputTokens: 100_000, cachedTokens: 50_000 }], {
    prices: { inputPerMillionUsd: 3 },
  });
  // 50k cached * ($3.00 - $0.30) / 1M = $0.135.
  assert.ok(
    budget.estimatedSavedUsd !== null && Math.abs(budget.estimatedSavedUsd - 0.135) < 1e-9,
    `expected $0.135 saved, got ${budget.estimatedSavedUsd}`,
  );
});

test("no prices means no savings estimate, and a pricier cache never saves negative", () => {
  const noPrices = aggregateTokenBudget([{ inputTokens: 10_000, cachedTokens: 9_000 }]);
  assert.equal(noPrices.estimatedSavedUsd, null);
  const inverted = aggregateTokenBudget([{ inputTokens: 10_000, cachedTokens: 9_000 }], {
    prices: { inputPerMillionUsd: 1, cachedPerMillionUsd: 5 },
  });
  assert.equal(inverted.estimatedSavedUsd, 0);
});

test("zero cached tokens save nothing even with prices", () => {
  const budget = aggregateTokenBudget([{ inputTokens: 10_000, cachedTokens: 0 }], {
    prices: { inputPerMillionUsd: 3, cachedPerMillionUsd: 0.3 },
  });
  assert.equal(budget.estimatedSavedUsd, null);
});

test("invalid prices are ignored", () => {
  const budget = aggregateTokenBudget([{ inputTokens: 10_000, cachedTokens: 9_000 }], {
    prices: { inputPerMillionUsd: -3, cachedPerMillionUsd: 0.3 },
  });
  assert.equal(budget.estimatedSavedUsd, null);
  const nanPrice = aggregateTokenBudget([{ inputTokens: 10_000, cachedTokens: 9_000 }], {
    prices: { inputPerMillionUsd: Number.NaN },
  });
  assert.equal(nanPrice.estimatedSavedUsd, null);
});
