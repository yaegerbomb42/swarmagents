import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequest, perplexityEffortFor } from "./adapters";
import { parseProvidersData, ConfigValidationError } from "./config-file";
import { parseEffortMutation } from "./mutations";
import { providerRow } from "./rows";
import {
  configureProviderStorePaths,
  ProviderMutationError,
  readConfiguredProviders,
  saveProvider,
  setProviderEffort,
  updateProviderSettings,
} from "./store";
import {
  isPerplexityEffort,
  PERPLEXITY_EFFORTS,
  type CompleteRequest,
  type PerplexityEffort,
  type ProviderConfig,
} from "./types";
import { anthropicToResponses } from "./wire-shims";

/**
 * Perplexity Agent API effort setting: a per-provider `effort` level
 * (fast/low/medium/high/xhigh) threaded into the Responses request body as
 * the documented top-level `effort` field. Unset = model-only request,
 * byte-identical to before. https://docs.perplexity.ai/api-reference/agent-post
 */

const perplexityConfig = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "perplexity",
  kind: "openai",
  apiStyle: "openai-responses",
  baseUrl: "https://api.perplexity.ai",
  keys: ["sk-test"],
  ...overrides,
});

const request: CompleteRequest = {
  messages: [{ role: "user", content: "What changed in the repo?" }],
};

function bodyOf(config: ProviderConfig): Record<string, unknown> {
  const { init } = buildRequest(config, "sk-test", "perplexity/sonar", request);
  return JSON.parse(init.body ?? "{}") as Record<string, unknown>;
}

test("isPerplexityEffort accepts exactly the documented enum", () => {
  assert.deepEqual([...PERPLEXITY_EFFORTS], ["fast", "low", "medium", "high", "xhigh"]);
  for (const level of PERPLEXITY_EFFORTS) {
    assert.equal(isPerplexityEffort(level), true, level);
  }
  for (const bad of ["turbo", "", "FAST", "Fast", "fast@2026-09-29.0", 3, null, undefined, {}]) {
    assert.equal(isPerplexityEffort(bad), false, JSON.stringify(bad));
  }
});

test("perplexityEffortFor gates on provider id and validates the value", () => {
  assert.equal(perplexityEffortFor(perplexityConfig({ effort: "low" })), "low");
  assert.equal(perplexityEffortFor(perplexityConfig()), undefined);
  assert.equal(
    perplexityEffortFor({ id: "openai", effort: "low" }),
    undefined,
    "other providers never send effort",
  );
  assert.equal(
    perplexityEffortFor(perplexityConfig({ effort: "turbo" as PerplexityEffort })),
    undefined,
    "a hand-edited invalid value is dropped, not sent",
  );
});

test("buildRequest carries the documented top-level effort field for Perplexity", () => {
  const body = bodyOf(perplexityConfig({ effort: "high" }));
  assert.equal(body.effort, "high");
  assert.equal(body.model, "perplexity/sonar");
});

test("buildRequest without effort is identical to the pre-setting body", () => {
  const withEffort = bodyOf(perplexityConfig({ effort: "fast" }));
  const without = bodyOf(perplexityConfig());
  assert.equal("effort" in without, false);
  const { effort: _dropped, ...rest } = withEffort;
  assert.deepEqual(without, rest, "unset effort changes nothing else in the body");
});

test("buildRequest never sends effort for other Responses providers", () => {
  const body = bodyOf(
    perplexityConfig({ id: "openai", baseUrl: "https://api.openai.com", effort: "low" }),
  );
  assert.equal("effort" in body, false);
});

test("anthropicToResponses adds effort only when the caller passes one", () => {
  const anthropicBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 256,
    messages: [{ role: "user", content: "hello" }],
  };
  const withEffort = anthropicToResponses(anthropicBody, "perplexity/sonar", {}, "medium");
  assert.equal(withEffort.effort, "medium");
  const without = anthropicToResponses(anthropicBody, "perplexity/sonar", {});
  assert.equal("effort" in without, false);
  const { effort: _dropped, ...rest } = withEffort;
  assert.deepEqual(without, rest, "unset effort changes nothing else in the body");
});

// --- Save-time validation + persistence (store) ----------------------------

const U = "local_tester@example.com";
let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-perplexity-effort-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function savedEffort(): PerplexityEffort | undefined {
  return readConfiguredProviders(U).find((c) => c.id === "perplexity")?.effort;
}

test("saveProvider persists a valid effort and preserves it on edit", () => {
  saveProvider(U, { id: "perplexity", apiKey: "sk-pplx", effort: "low" });
  assert.equal(savedEffort(), "low");
  // Re-save without the field (e.g. from a form that doesn't know it).
  saveProvider(U, { id: "perplexity", apiKey: "sk-pplx" });
  assert.equal(savedEffort(), "low", "omitted effort is preserved on edit");
  // Explicit null clears back to the server default.
  saveProvider(U, { id: "perplexity", apiKey: "sk-pplx", effort: null });
  assert.equal(savedEffort(), undefined, "null clears the saved effort");
});

test("saveProvider rejects an effort outside the documented enum", () => {
  assert.throws(
    () =>
      saveProvider(U, {
        id: "perplexity",
        apiKey: "sk-pplx",
        effort: "turbo" as PerplexityEffort,
      }),
    (err: unknown) => err instanceof ProviderMutationError && err.status === 400,
  );
  assert.equal(savedEffort(), undefined, "nothing was persisted");
});

test("saveProvider rejects effort for non-Perplexity providers", () => {
  assert.throws(
    () => saveProvider(U, { id: "openai", apiKey: "sk-openai", effort: "low" }),
    (err: unknown) => err instanceof ProviderMutationError && err.status === 400,
  );
});

test("updateProviderSettings sets and clears effort", () => {
  saveProvider(U, { id: "perplexity", apiKey: "sk-pplx" });
  updateProviderSettings(U, "perplexity", { effort: "xhigh" });
  assert.equal(savedEffort(), "xhigh");
  updateProviderSettings(U, "perplexity", { effort: null });
  assert.equal(savedEffort(), undefined);
  assert.throws(
    () => updateProviderSettings(U, "perplexity", { effort: "nope" as PerplexityEffort }),
    (err: unknown) => err instanceof ProviderMutationError && err.status === 400,
  );
});

test("setProviderEffort sets, clears, and stays Perplexity-only", () => {
  saveProvider(U, { id: "perplexity", apiKey: "sk-pplx" });
  setProviderEffort(U, "perplexity", "medium");
  assert.equal(savedEffort(), "medium");
  setProviderEffort(U, "perplexity", null);
  assert.equal(savedEffort(), undefined);
  assert.throws(
    () => setProviderEffort(U, "openai", "low"),
    (err: unknown) => err instanceof ProviderMutationError && err.status === 400,
  );
  assert.throws(
    () => setProviderEffort(U, "perplexity", "warp" as PerplexityEffort),
    (err: unknown) => err instanceof ProviderMutationError && err.status === 400,
  );
});

// --- Mutation payload parsing ----------------------------------------------

test("parseEffortMutation accepts the action form, the shorthand, and null", () => {
  assert.deepEqual(parseEffortMutation({ action: "set-effort", effort: "low" }), { effort: "low" });
  assert.deepEqual(parseEffortMutation({ effort: "high" }), { effort: "high" });
  assert.deepEqual(parseEffortMutation({ action: "set-effort", effort: null }), { effort: null });
  assert.deepEqual(parseEffortMutation({ effort: null }), { effort: null });
});

test("parseEffortMutation rejects invalid payloads", () => {
  for (const bad of [
    { action: "set-effort", effort: "turbo" },
    { action: "set-effort" },
    { action: "set-effort", effort: 3 },
    { action: "delete-effort", effort: "low" },
    {},
    "low",
    null,
  ]) {
    assert.throws(
      () => parseEffortMutation(bad),
      (err: unknown) => err instanceof ProviderMutationError && err.status === 400,
      JSON.stringify(bad),
    );
  }
});

// --- Config file parsing -----------------------------------------------------

test("parseProvidersData keeps a valid effort and rejects an invalid one", () => {
  const [parsed] = parseProvidersData({
    providers: [
      { id: "perplexity", kind: "openai", apiStyle: "openai-responses", effort: "high" },
    ],
  });
  assert.equal(parsed.effort, "high");
  assert.throws(
    () =>
      parseProvidersData({
        providers: [{ id: "perplexity", kind: "openai", effort: "turbo" }],
      }),
    (err: unknown) => err instanceof ConfigValidationError,
  );
});

// --- Client row --------------------------------------------------------------

test("providerRow exposes the effort that will be sent, and only for Perplexity", () => {
  const row = providerRow(perplexityConfig({ effort: "fast" }), { saved: true });
  assert.equal(row.effort, "fast");
  const unset = providerRow(perplexityConfig(), { saved: true });
  assert.equal("effort" in unset, false);
  const other = providerRow(
    perplexityConfig({ id: "openai", baseUrl: "https://api.openai.com", effort: "low" }),
    { saved: true },
  );
  assert.equal("effort" in other, false, "a stray effort on another provider stays hidden");
});
