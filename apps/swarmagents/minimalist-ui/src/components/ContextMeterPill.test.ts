/**
 * Component tests for the context-meter pill: the compact HUD label plus
 * the breakdown popover. Static renders (see testing/harness.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";
import { aggregateTokenBudget, type TokenBudget } from "../../../lib/client/tokenBudget";

const h = React.createElement;

/** Components are imported after the browser stubs are in place. */
async function load() {
  installBrowserStubs();
  return import("./ContextMeterPill");
}

function budget(overrides: Partial<TokenBudget> & { totalInputTokens: number }): TokenBudget {
  return {
    turns: 1,
    turnsWithUsage: 1,
    hasUsage: true,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    cacheHitRatePct: null,
    contextUtilizationPct: null,
    estimatedSavedUsd: null,
    ...overrides,
  };
}

test("no usage renders nothing", async () => {
  const { ContextMeterPill } = await load();
  const markup = renderToStaticMarkup(h(ContextMeterPill, { budget: null }));
  assert.equal(markup, "");
  const empty = renderToStaticMarkup(
    h(ContextMeterPill, { budget: aggregateTokenBudget([{}]) }),
  );
  assert.equal(empty, "");
});

test("the pill shows context tokens and the cache hit rate", async () => {
  const { ContextMeterPill } = await load();
  const markup = renderToStaticMarkup(
    h(ContextMeterPill, {
      budget: budget({
        totalInputTokens: 12_400,
        totalOutputTokens: 800,
        totalCachedTokens: 10_000,
        cacheHitRatePct: 80.6,
      }),
    }),
  );
  assert.ok(markup.includes('data-testid="context-meter-pill"'), "pill renders");
  assert.ok(markup.includes("12k ctx"), "pill shows compact input tokens");
  assert.ok(markup.includes("80.6% cached"), "pill shows the hit rate");
  assert.ok(!markup.includes('data-testid="context-meter-popover"'), "popover starts closed");
});

test("a zero hit rate still shows, and a missing rate is omitted", async () => {
  const { ContextMeterPill } = await load();
  const zero = renderToStaticMarkup(
    h(ContextMeterPill, {
      budget: budget({ totalInputTokens: 4_000, cacheHitRatePct: 0 }),
    }),
  );
  assert.ok(zero.includes("0% cached"), "zero hit rate is shown, not hidden");
  const missing = renderToStaticMarkup(
    h(ContextMeterPill, {
      budget: budget({ totalInputTokens: 300, totalOutputTokens: 300, cacheHitRatePct: null }),
    }),
  );
  assert.ok(missing.includes("300 ctx"), "output-only usage still shows context");
  assert.ok(!missing.includes("cached"), "no hit rate means no cached claim");
});

test("the open popover breaks down tokens, rates, and savings", async () => {
  const { ContextMeterPill } = await load();
  const markup = renderToStaticMarkup(
    h(ContextMeterPill, {
      budget: budget({
        totalInputTokens: 100_000,
        totalOutputTokens: 2_000,
        totalCachedTokens: 80_000,
        cacheHitRatePct: 80,
        contextUtilizationPct: 50,
        contextWindowTokens: 200_000,
        estimatedSavedUsd: 0.216,
        model: "claude-sonnet-4-5",
      }),
      defaultOpen: true,
    }),
  );
  assert.ok(markup.includes('data-testid="context-meter-popover"'), "popover renders");
  assert.ok(markup.includes("claude-sonnet-4-5"), "popover names the model");
  assert.ok(markup.includes("100k"), "popover shows input tokens");
  assert.ok(markup.includes("80k"), "popover shows cached tokens");
  assert.ok(markup.includes("$0.22"), "popover shows estimated savings");
  assert.ok(markup.includes("of 200k"), "popover names the context window");
  assert.ok(markup.includes('aria-label="Cache hit rate"'), "hit-rate meter is labelled");
  assert.ok(markup.includes('aria-label="Context window utilization"'), "utilization meter is labelled");
});

test("unknown utilization explains itself instead of inventing a number", async () => {
  const { ContextMeterPill } = await load();
  const markup = renderToStaticMarkup(
    h(ContextMeterPill, {
      budget: budget({ totalInputTokens: 5_000, cacheHitRatePct: 40 }),
      defaultOpen: true,
    }),
  );
  assert.ok(markup.includes("No context window known"), "unknown window is explained");
  assert.ok(!markup.includes("Est. cache savings"), "no prices means no savings row");
});
