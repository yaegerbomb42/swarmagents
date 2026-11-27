import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FRONTIER_HARNESSES, PROVIDERS, type ProviderConfig } from "../data";
import { FrontierHarnesses, resolveFrontierHarnessAction } from "./Settings";
import { callProvider } from "../engine";

// Frontier harnesses (morning-01 follow-up): the three frontier agent
// stacks from the morning target — Grok, Muse, Arena — each one-click
// configurable from the Settings Providers tab via its provider preset.
// There is no DOM test setup in this repo (node:test, no jsdom), so the
// click routing is covered by the pure resolver below plus a static-markup
// test of the rendered section; the wiring is verified by typecheck.

function configured(presetId: string): ProviderConfig {
  const p = PROVIDERS.find((x) => x.id === presetId)!;
  return {
    uid: `uid-${presetId}`,
    presetId,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: "test-key",
    format: p.format,
    color: p.color,
    enabled: true,
  };
}

test("frontier harnesses cover Grok, Muse and Arena, each with a one-click preset", () => {
  assert.deepEqual(
    FRONTIER_HARNESSES.map((h) => h.id),
    ["grok", "muse", "arena"],
    "exactly the three named harnesses",
  );
  for (const h of FRONTIER_HARNESSES) {
    const preset = PROVIDERS.find((p) => p.id === h.presetId);
    assert.ok(preset, `${h.id}: preset ${h.presetId} exists in PROVIDERS`);
    assert.ok(h.blurb.length > 0, `${h.id}: blurb present`);
    assert.ok(h.harnessNote.length > 0, `${h.id}: harness note present`);
  }
});

test("harness presets point at the right endpoints and wire formats", () => {
  const xai = PROVIDERS.find((p) => p.id === "xai")!;
  assert.equal(xai.baseUrl, "https://api.x.ai/v1");
  assert.equal(xai.model, "grok-4", "stale grok-beta retired — the preset tracks the catalog default");
  assert.equal(xai.format, "openai");

  const meta = PROVIDERS.find((p) => p.id === "meta")!;
  assert.equal(meta.name, "Meta Muse");
  assert.equal(meta.baseUrl, "https://api.meta.ai/v1");
  assert.equal(meta.model, "muse-spark-1.3", "current agentic model per Meta Model API docs");
  assert.equal(meta.format, "openai", "Meta Model API is OpenAI-compatible chat completions");

  const arena = PROVIDERS.find((p) => p.id === "arena")!;
  assert.equal(arena.baseUrl, "https://api.arena.ai/v1");
  assert.equal(arena.model, "coding-router-preview", "Arena's default router model");
  assert.equal(arena.format, "responses", "Arena speaks the OpenAI Responses API, not chat completions");
});

test("clicking an unconfigured harness adds its preset (opens the provider flow)", () => {
  const muse = FRONTIER_HARNESSES.find((h) => h.id === "muse")!;
  const action = resolveFrontierHarnessAction(muse, []);
  assert.deepEqual(action, { kind: "add", presetId: "meta" });
  // The section's Configure button calls onConfigure with exactly this
  // preset id — the parent's add() appends the provider and expands its
  // key entry, i.e. the click opens the provider flow.
  const seen: string[] = [];
  if (action.kind === "add") seen.push(action.presetId);
  assert.deepEqual(seen, ["meta"]);
});

test("clicking an already-configured harness jumps to its provider card", () => {
  const grok = FRONTIER_HARNESSES.find((h) => h.id === "grok")!;
  const action = resolveFrontierHarnessAction(grok, [configured("xai")]);
  assert.deepEqual(action, { kind: "expand", uid: "uid-xai" });
});

test("FrontierHarnesses renders the three entries with Configure buttons", () => {
  const html = renderToStaticMarkup(
    React.createElement(FrontierHarnesses, {
      providers: [],
      onConfigure: () => {},
      onExpand: () => {},
    }),
  );
  for (const name of ["Grok", "Muse", "Arena"]) {
    assert.ok(html.includes(name), `${name} renders`);
  }
  assert.ok(html.includes("Frontier harnesses"), "section heading renders");
  assert.equal((html.match(/>Configure</g) ?? []).length, 3, "one Configure button per harness");
  assert.ok(!html.includes(">Configured<"), "nothing shows as configured yet");
});

test("FrontierHarnesses shows Configured for a harness whose preset is added", () => {
  const html = renderToStaticMarkup(
    React.createElement(FrontierHarnesses, {
      providers: [configured("xai")],
      onConfigure: () => {},
      onExpand: () => {},
    }),
  );
  assert.ok(html.includes(">Configured<"), "Grok shows Configured once xAI is added");
  assert.equal((html.match(/>Configure</g) ?? []).length, 2, "the other two still offer Configure");
});

// The Arena preset needs the Responses wire format: the client engine must
// POST /v1/responses and read the reply text out of output_text.
test("callProvider posts Responses requests for the responses format", async () => {
  const originalFetch = globalThis.fetch;
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        output_text: "hello from arena",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const arena = configured("arena");
    const res = await callProvider(arena, "Be terse.", "ping", [], new AbortController().signal);
    assert.equal(res.text, "hello from arena");
    assert.equal(res.inTok, 10);
    assert.equal(res.outTok, 4);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.arena.ai/v1/responses");
    const body = JSON.parse(String(seen[0].init.body));
    assert.equal(body.model, "coding-router-preview");
    assert.equal(body.instructions, "Be terse.");
    assert.equal(body.input, "ping");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callProvider reads Responses text from message output items when output_text is absent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        output: [
          { type: "message", content: [{ type: "output_text", text: "part one " }] },
          { type: "message", content: [{ type: "output_text", text: "part two" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const res = await callProvider(configured("arena"), "sys", "hi", [], new AbortController().signal);
    assert.equal(res.text, "part one part two");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callProvider surfaces Responses errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "bad key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => callProvider(configured("arena"), "sys", "hi", [], new AbortController().signal),
      /bad key/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
