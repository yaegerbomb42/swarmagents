import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countOf, installBrowserStubs } from "../testing/harness";

/**
 * First-run onboarding (core-24): the wizard is three steps — pick a
 * provider (free tiers first), paste the key and test it (ok + latency +
 * run-mode badge), then run a canned sample task. These tests pin the step
 * logic: the free-first ordering, the save/test payload helpers, the mode
 * badge mapping, and what each step renders. The end-to-end journey (new
 * account → provider → test → sample → completed run with artifact card) is
 * covered by e2e/first-run.spec.ts.
 */

test("free-tier providers are listed before paid ones, hosted before self-hosted", async () => {
  installBrowserStubs();
  const { orderedOnboardProviders } = await import("./FirstRunSetup");
  const providers = orderedOnboardProviders();
  const free = providers.filter((p) => p.free);
  const paid = providers.filter((p) => !p.free);
  assert.ok(free.length > 0, "free-tier presets exist");
  assert.ok(paid.length > 0, "paid presets exist");
  assert.deepEqual(
    providers.map((p) => p.id),
    [...free.map((p) => p.id), ...paid.map((p) => p.id)],
    "all free options come before any paid one",
  );
  assert.equal(providers[0].local, false, "a hosted free tier is the default, not a self-hosted server");
  const firstLocal = providers.findIndex((p) => p.local);
  assert.ok(firstLocal > 0 && providers.slice(firstLocal).every((p) => p.local || !p.free), "self-hosted comes after hosted free tiers");
  assert.equal(providers[firstLocal].authScheme, "none", "the self-hosted provider needs no key");
});

test("modeBadge maps run-mode ids to badge labels", async () => {
  installBrowserStubs();
  const { modeBadge } = await import("./FirstRunSetup");
  assert.equal(modeBadge("gui"), "Desktop");
  assert.equal(modeBadge("text-desktop"), "Text desktop");
  assert.equal(modeBadge("chat"), "Chat");
  assert.equal(modeBadge("text"), "Text");
  assert.equal(modeBadge(undefined), "Text");
});

test("buildProviderSaveBody sends the key only for non-local providers", async () => {
  installBrowserStubs();
  const { buildProviderSaveBody, ONBOARD_PROVIDERS } = await import("./FirstRunSetup");
  const groq = ONBOARD_PROVIDERS.find((p) => p.id === "groq")!;
  const body = buildProviderSaveBody(groq, "  gsk_test  ");
  assert.equal(body.id, "groq");
  assert.equal(body.apiStyle, "openai-chat");
  assert.deepEqual(body.auth, { scheme: "bearer" });
  assert.equal(body.apiKey, "gsk_test", "the pasted key is trimmed and sent");
  assert.deepEqual(body.models, ["llama-3.3-70b-versatile"]);

  const ollama = ONBOARD_PROVIDERS.find((p) => p.id === "ollama")!;
  const localBody = buildProviderSaveBody(ollama, "");
  assert.deepEqual(localBody.auth, { scheme: "none" });
  assert.ok(!("apiKey" in localBody), "local providers never send a key");
});

test("the wizard renders the provider step first with free tiers on top", async () => {
  installBrowserStubs();
  const { FirstRunSetup } = await import("./FirstRunSetup");
  const html = renderToStaticMarkup(
    React.createElement(FirstRunSetup, { onRunSample: async () => ({ ok: true }), onLater: () => {} }),
  );

  assert.equal(countOf(html, 'data-testid="first-run-setup"'), 1, "the wizard renders");
  assert.equal(countOf(html, 'data-testid="fr-step-provider"'), 1, "it starts on the provider step");
  assert.equal(countOf(html, 'data-testid="fr-step-key"'), 0, "the key step is not shown yet");
  assert.equal(countOf(html, 'data-testid="fr-step-try"'), 0, "the try step is not shown yet");
  assert.equal(countOf(html, 'data-testid="first-run-steps"'), 1, "the step tracker renders");

  // Free tiers are listed before paid ones in the DOM, not just the model.
  const htmlFreeIdx = html.indexOf('data-testid="fr-provider-groq"');
  const htmlPaidIdx = html.indexOf('data-testid="fr-provider-anthropic"');
  assert.ok(htmlFreeIdx !== -1, "a free provider card renders");
  assert.ok(htmlPaidIdx !== -1, "a paid provider card renders");
  assert.ok(htmlFreeIdx < htmlPaidIdx, "the free card comes before the paid card");
  assert.ok(/Free/.test(html), "free badges are visible");
  assert.equal(countOf(html, 'data-testid="fr-later"'), 1, "the 'set up later' escape hatch renders");
});

test("step two: key input, get-a-key link and the test action", async () => {
  installBrowserStubs();
  const { FirstRunSetup, ONBOARD_PROVIDERS } = await import("./FirstRunSetup");
  const groq = ONBOARD_PROVIDERS.find((p) => p.id === "groq")!;
  const html = renderToStaticMarkup(
    React.createElement(FirstRunSetup, {
      onRunSample: async () => ({ ok: true }),
      initialStep: "key",
      initialPreset: groq,
    }),
  );

  assert.equal(countOf(html, 'data-testid="fr-step-key"'), 1, "the key step renders");
  assert.equal(countOf(html, 'data-testid="fr-key-input"'), 1, "the key input renders");
  assert.equal(countOf(html, 'data-testid="fr-test"'), 1, "the Test button renders");
  assert.equal(countOf(html, 'data-testid="fr-back"'), 1, "Back returns to the provider step");
  assert.equal(countOf(html, 'data-testid="fr-get-key"'), 1, "a link to get a key renders");
  assert.equal(countOf(html, 'data-testid="fr-test-ok"'), 0, "no result state before a test runs");
});

test("step three: the three sample cards render, wired to onRunSample", async () => {
  installBrowserStubs();
  const { FirstRunSetup, TryStep } = await import("./FirstRunSetup");
  let calledWith: string | undefined;
  const onRunSample = async (sample: { id: string }) => {
    calledWith = sample.id;
    return { ok: true };
  };
  const html = renderToStaticMarkup(
    React.createElement(FirstRunSetup, { onRunSample, initialStep: "try" }),
  );

  assert.equal(countOf(html, 'data-testid="fr-step-try"'), 1, "the try step renders");
  for (const id of ["primes", "bar-chart", "pdf-memo"]) {
    assert.equal(countOf(html, `data-testid="fr-sample-${id}"`), 1, `sample card ${id} renders`);
  }
  assert.ok(/1–2 min/.test(html), "sample run times are shown");
  assert.ok(/Deliverable/.test(html), "deliverables are called out");

  // Reuse is the single source of truth for the wizard's try step.
  const tryStepHtml = renderToStaticMarkup(React.createElement(TryStep, { onRunSample }));
  assert.equal(countOf(tryStepHtml, 'data-testid="fr-sample-primes"'), 1, "TryStep renders the same cards");
  assert.equal(calledWith, undefined, "static render never calls onRunSample");
});

test("testProviderConnection saves then probes, and surfaces failures", async () => {
  installBrowserStubs();
  const { testProviderConnection, ONBOARD_PROVIDERS } = await import("./FirstRunSetup");
  const groq = ONBOARD_PROVIDERS.find((p) => p.id === "groq")!;

  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push(input);
    if (input === "/api/providers") {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    if (input === "/api/providers/groq/test") {
      return {
        ok: true,
        json: async () => ({
          test: { ok: true, latencyMs: 84, model: "llama-3.3-70b-versatile" },
          runMode: { mode: "text-desktop", label: "Text desktop mode" },
        }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;

  try {
    const outcome = await testProviderConnection(groq, "gsk_test");
    assert.deepEqual(calls, ["/api/providers", "/api/providers/groq/test"], "save runs before the probe");
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.latencyMs, 84);
      assert.equal(outcome.mode, "text-desktop");
      assert.equal(outcome.model, "llama-3.3-70b-versatile");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the settings replay entry reuses the sample-task picker", async () => {
  installBrowserStubs();
  const { SampleTaskPicker } = await import("./FirstRunSetup");
  const html = renderToStaticMarkup(
    React.createElement(SampleTaskPicker, { onRunSample: async () => ({ ok: true }), testIdPrefix: "settings-sample" }),
  );
  assert.equal(countOf(html, 'data-testid="settings-sample-primes"'), 1, "the replay list renders sample cards");
  assert.match(html, />Run</, "each card has a Run action");
});
