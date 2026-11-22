/**
 * Catalog connector-pack invariants: the verified free-tier marks, the two
 * new gateway entries (xKiro, Bynara), and the corrected model ids/base
 * URLs. These pin facts checked against each provider's documented
 * OpenAI-compatible endpoint — a failure here means someone edited the
 * catalog away from a verified value.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_CATALOG, catalogEntry } from "./catalog";
import { MORE_HOSTED_PROVIDERS, MORE_LOCAL_PROVIDERS } from "./catalog-more";

test("every default model appears in its popular list", () => {
  for (const entry of PROVIDER_CATALOG) {
    const models = entry.models;
    if (!models?.default || models.popular.length === 0) continue;
    assert.ok(
      models.popular.includes(models.default),
      `${entry.id}: default "${models.default}" must be in popular [${models.popular.join(", ")}]`,
    );
  }
});

test("free-tier marks are exactly the verified set", () => {
  // Hosted providers with a genuinely free tier (no card, or a free daily
  // allowance). Trial credits and eval-only keys do not count.
  const expectedHostedFree = new Set([
    "gemini",
    "mistral",
    "groq",
    "cerebras",
    "github",
    "cloudflare",
    "xkiro",
    "bynara",
  ]);
  const actualHostedFree = new Set(
    PROVIDER_CATALOG.filter((entry) => entry.isFree && !entry.isLocal).map((entry) => entry.id),
  );
  assert.deepEqual(actualHostedFree, expectedHostedFree);

  // Every local server costs $0 to run and must be marked free.
  for (const entry of PROVIDER_CATALOG) {
    if (entry.isLocal) {
      assert.equal(entry.isFree, true, `${entry.id}: local providers must be marked free`);
    }
  }
  for (const entry of MORE_LOCAL_PROVIDERS) {
    assert.equal(entry.isFree, true, `${entry.id}: local providers must be marked free`);
  }
});

test("xKiro and Bynara gateway entries are well-formed", () => {
  for (const id of ["xkiro", "bynara"]) {
    const entry = catalogEntry(id);
    assert.ok(entry, `${id} must exist in the catalog`);
    assert.equal(entry.apiStyle, "openai-chat", `${id}: apiStyle`);
    assert.ok(entry.baseUrl?.startsWith("https://"), `${id}: https baseUrl`);
    assert.match(entry.envVar, /^SWARM_KEYS_[A-Z0-9_]+$/, `${id}: envVar shape`);
    assert.ok(entry.links.apiKeys?.startsWith("https://"), `${id}: apiKeys link`);
    assert.ok(
      MORE_HOSTED_PROVIDERS.some((hosted) => hosted.id === id),
      `${id}: must live in MORE_HOSTED_PROVIDERS`,
    );
  }
  assert.equal(catalogEntry("xkiro")?.baseUrl, "https://api.xkiro.com/v1");
  assert.equal(catalogEntry("bynara")?.baseUrl, "https://router.bynara.id/v1");
});

test("corrected model ids and base URLs stay corrected", () => {
  const openrouter = catalogEntry("openrouter");
  assert.equal(openrouter?.models?.default, "anthropic/claude-sonnet-4.5");
  assert.ok(openrouter?.models?.popular.includes("openai/gpt-4.1-mini"));
  assert.ok(
    !openrouter?.models?.popular.some((m) => m.includes("claude-sonnet-4-5")),
    "openrouter: dash-form slugs do not exist",
  );

  const minimax = catalogEntry("minimax");
  assert.equal(minimax?.baseUrl, "https://api.minimax.io/v1");
  assert.equal(minimax?.models?.default, "MiniMax-M3");

  const moonshot = catalogEntry("moonshot");
  assert.equal(moonshot?.baseUrl, "https://api.moonshot.ai/v1");
  assert.equal(moonshot?.models?.default, "kimi-k3");
  assert.ok(
    !moonshot?.models?.popular.some((m) => m.startsWith("moonshot-v1-")),
    "moonshot: the v1 series is sunset",
  );

  const cohere = catalogEntry("cohere");
  assert.equal(cohere?.models?.default, "command-a-03-2025");

  const qwen = catalogEntry("qwen");
  assert.ok(qwen?.models?.popular.includes("qwen3-coder-plus"));
  assert.ok(!qwen?.models?.popular.includes("qwen3-coder"), "qwen: bare qwen3-coder is not an id");

  const zai = catalogEntry("zai");
  assert.ok(
    !zai?.models?.popular.includes("glm-4.5-thinking"),
    "zai: thinking is a request parameter, not a model id",
  );

  assert.ok(catalogEntry("cerebras")?.models?.popular.includes("gpt-oss-120b"));
  assert.ok(catalogEntry("sambanova")?.models?.popular.includes("gpt-oss-120b"));
  // Perplexity moved to the Agent API: one perplexity/sonar model, the
  // old sonar* tiers are effort levels (see perplexity-agent-api.test.ts).
  assert.ok(catalogEntry("perplexity")?.models?.popular.includes("perplexity/sonar"));
  assert.ok(!catalogEntry("perplexity")?.models?.popular.includes("sonar-reasoning-pro"));
});

test("custom stays last and ids stay unique", () => {
  assert.equal(PROVIDER_CATALOG[PROVIDER_CATALOG.length - 1]?.id, "custom");
  const ids = PROVIDER_CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "provider ids must be unique");
});
