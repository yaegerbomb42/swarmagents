/**
 * Tests for the provider health strip: dot-tone mapping, payload parsing,
 * the fetch round (stubbed), and the static render of every strip state.
 * Static renders (see testing/harness.ts) never run effects, so the polling
 * container is checked in its initial state and the dots are checked per
 * state via the pure ProviderHealthDots component.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installBrowserStubs } from "../testing/harness";
import type { ProviderHealthEntry } from "./ProviderHealthStrip";

const h = React.createElement;
const noop = () => {};

/** Components are imported after the browser stubs are in place. */
async function load() {
  installBrowserStubs();
  return import("./ProviderHealthStrip");
}

function entry(overrides: Partial<ProviderHealthEntry> = {}): ProviderHealthEntry {
  return {
    id: "openai",
    ok: true,
    latencyMs: 142,
    checkedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("dot tone: healthy, slow at the threshold, down, unconfigured, checking", async () => {
  const { providerDotTone } = await load();
  assert.equal(providerDotTone(entry()), "ok", "fast + ok is green");
  assert.equal(providerDotTone(entry({ latencyMs: 4_999 })), "ok", "just under the threshold is still green");
  assert.equal(providerDotTone(entry({ latencyMs: 5_000 })), "slow", "at the threshold reads slow");
  assert.equal(providerDotTone(entry({ latencyMs: 12_000 })), "slow", "slow + ok is amber");
  assert.equal(providerDotTone(entry({ latencyMs: null })), "ok", "no latency still counts as healthy");
  assert.equal(providerDotTone(entry({ ok: false, error: "HTTP 401" })), "down", "a failed check is red");
  assert.equal(
    providerDotTone(entry({ ok: false, error: "No keys configured" })),
    "unknown",
    "no keys configured is grey, not red",
  );
  assert.equal(providerDotTone(entry({ checking: true })), "unknown", "a check in progress is grey");
});

test("dot title names the provider, its status, latency, and last check", async () => {
  const { providerDotTitle } = await load();
  const healthy = providerDotTitle(entry());
  assert.ok(healthy.includes("openai"), "title names the provider");
  assert.ok(healthy.includes("healthy"), "title says healthy");
  assert.ok(healthy.includes("142 ms"), "title shows the latency");
  assert.ok(healthy.includes("checked"), "title shows the last check time");
  const slow = providerDotTitle(entry({ latencyMs: 9_400 }));
  assert.ok(slow.includes("slow"), "slow title says slow");
  assert.ok(slow.includes("9,400 ms") || slow.includes("9400 ms"), "slow title shows the latency");
  const down = providerDotTitle(entry({ ok: false, error: "HTTP 429 (Rate limited)" }));
  assert.ok(down.includes("down"), "down title says down");
  assert.ok(down.includes("HTTP 429"), "down title carries the failure reason");
  const unconfigured = providerDotTitle(entry({ ok: false, error: "No keys configured" }));
  assert.ok(unconfigured.includes("not configured"), "unconfigured title says so");
  const checking = providerDotTitle(entry({ checking: true }));
  assert.ok(checking.includes("checking"), "checking title says so");
});

test("payload parsing accepts the real shape and rejects anything else", async () => {
  const { parseHealthResponse } = await load();
  const good = parseHealthResponse({
    providers: [
      { id: "openai", ok: true, latencyMs: 142, checkedAt: 1_700_000_000_000 },
      { id: "anthropic", ok: false, latencyMs: 88, checkedAt: 1_700_000_000_000, error: "No keys configured" },
      { id: "ollama", ok: false, latencyMs: null, checkedAt: 1_700_000_000_000, checking: true },
    ],
  });
  assert.equal(good?.length, 3, "all three entries parse");
  assert.equal(good?.[1].error, "No keys configured", "error survives");
  assert.equal(good?.[2].checking, true, "checking survives");
  assert.equal(parseHealthResponse(null), null, "null body is not a payload");
  assert.equal(parseHealthResponse({}), null, "missing providers is not a payload");
  assert.equal(parseHealthResponse({ providers: "openai" }), null, "non-array providers is not a payload");
  assert.equal(
    parseHealthResponse({ providers: [{ id: "openai", ok: true }] }),
    null,
    "an entry missing checkedAt is not a payload",
  );
  assert.equal(
    parseHealthResponse({ providers: [{ id: "openai", ok: true, latencyMs: "fast", checkedAt: 1 }] }),
    null,
    "a non-numeric latency is not a payload",
  );
});

test("fetch round: success returns entries, any failure returns null without throwing", async () => {
  const { fetchProviderHealth } = await load();
  const originalFetch = globalThis.fetch;
  try {
    const okFetch = (async () => ({
      ok: true,
      json: async () => ({
        providers: [{ id: "openai", ok: true, latencyMs: 142, checkedAt: 1_700_000_000_000 }],
      }),
    })) as unknown as typeof fetch;
    const ok = await fetchProviderHealth(okFetch);
    assert.equal(ok?.length, 1, "a good response parses");
    assert.equal(ok?.[0].id, "openai", "the entry survives the round trip");

    const httpErrorFetch = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    assert.equal(await fetchProviderHealth(httpErrorFetch), null, "an HTTP error is a failed poll");

    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    assert.equal(await fetchProviderHealth(throwingFetch), null, "a thrown fetch is a failed poll");

    const malformedFetch = (async () => ({
      ok: true,
      json: async () => ({ nope: true }),
    })) as unknown as typeof fetch;
    assert.equal(await fetchProviderHealth(malformedFetch), null, "a malformed payload is a failed poll");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dots render one per provider with the right tone and latency in the title", async () => {
  const { ProviderHealthDots } = await load();
  const markup = renderToStaticMarkup(
    h(ProviderHealthDots, {
      providers: [
        entry(),
        entry({ id: "anthropic", latencyMs: 8_200 }),
        entry({ id: "ollama", ok: false, error: "HTTP 500" }),
        entry({ id: "gemini", ok: false, error: "No keys configured" }),
      ],
      failed: false,
      onOpenProviders: noop,
    }),
  );
  assert.ok(markup.includes('data-testid="provider-health-strip"'), "strip renders");
  assert.ok(markup.includes('data-tone="ok"'), "healthy dot is green");
  assert.ok(markup.includes('data-tone="slow"'), "slow dot is amber");
  assert.ok(markup.includes('data-tone="down"'), "down dot is red");
  assert.ok(markup.includes('data-tone="unknown"'), "unconfigured dot is grey");
  assert.ok(markup.includes("142 ms"), "healthy latency is in the markup");
  assert.ok(markup.includes("8,200 ms") || markup.includes("8200 ms"), "slow latency is in the markup");
  assert.ok(
    markup.includes('aria-label="Provider health — open Providers settings"'),
    "the strip is a labelled button to Settings",
  );
});

test("a failed poll renders every known dot grey", async () => {
  const { ProviderHealthDots } = await load();
  const markup = renderToStaticMarkup(
    h(ProviderHealthDots, {
      providers: [entry(), entry({ id: "anthropic", latencyMs: 8_200 })],
      failed: true,
      onOpenProviders: noop,
    }),
  );
  assert.ok(!markup.includes('data-tone="ok"'), "no green dot survives a failed poll");
  assert.ok(!markup.includes('data-tone="slow"'), "no amber dot survives a failed poll");
  assert.ok(markup.includes('data-tone="unknown"'), "known providers degrade to grey");
  assert.ok(markup.includes("health unavailable"), "grey dots say the health is unavailable");
});

test("no data yet shows one grey checking dot; a failed first poll shows one grey unavailable dot", async () => {
  const { ProviderHealthDots } = await load();
  const checking = renderToStaticMarkup(
    h(ProviderHealthDots, { providers: null, failed: false, onOpenProviders: noop }),
  );
  assert.ok(checking.includes('data-tone="unknown"'), "checking state is grey");
  assert.ok(checking.includes("Checking provider health"), "checking state says so");
  const unavailable = renderToStaticMarkup(
    h(ProviderHealthDots, { providers: null, failed: true, onOpenProviders: noop }),
  );
  assert.ok(unavailable.includes('data-tone="unknown"'), "failed first poll is grey");
  assert.ok(unavailable.includes("Provider health unavailable"), "failed first poll says so");
});

test("a successful poll with zero providers renders nothing", async () => {
  const { ProviderHealthDots } = await load();
  const markup = renderToStaticMarkup(
    h(ProviderHealthDots, { providers: [], failed: false, onOpenProviders: noop }),
  );
  assert.equal(markup, "", "no providers means no strip");
});

test("more than ten providers collapse the rest into a +N label", async () => {
  const { ProviderHealthDots } = await load();
  const providers = Array.from({ length: 12 }, (_, i) => entry({ id: `provider-${i}` }));
  const markup = renderToStaticMarkup(
    h(ProviderHealthDots, { providers, failed: false, onOpenProviders: noop }),
  );
  assert.equal(markup.split('data-testid="provider-health-dot"').length - 1, 10, "ten dots render");
  assert.ok(markup.includes("+2"), "the overflow is labelled");
});

test("the polling container renders in its initial checking state without crashing", async () => {
  const { ProviderHealthStrip } = await load();
  const markup = renderToStaticMarkup(h(ProviderHealthStrip, { onOpenProviders: noop }));
  assert.ok(markup.includes('data-testid="provider-health-strip"'), "strip renders before any poll");
  assert.ok(markup.includes("Checking provider health"), "it starts in the checking state");
});
