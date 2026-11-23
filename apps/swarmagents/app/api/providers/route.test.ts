/**
 * Tests for GET/POST /api/providers. The route is auth-gated by middleware
 * (like every non-PUBLIC /api/* route); these tests exercise the handler
 * directly and assert the no-key-in-response invariant.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, PATCH, POST } from "./route";
import { configureProviderStorePaths, readConfiguredProviders, routerProviders } from "../../../lib/providers/store";
import type { ProviderCatalogEntry } from "../../../lib/providers/catalog";

let tempDir: string;
let providersFile: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-providers-route-"));
  providersFile = join(tempDir, "providers.json");
  configureProviderStorePaths(providersFile);
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Requests without the user header act as the local-mode owner. */
const OWNER = "local";

function onDisk(): { providers: Array<{ id: string; keys?: string[] }> } {
  return { providers: readConfiguredProviders(OWNER) };
}

function GET_(): Response {
  return GET(new Request("http://localhost/api/providers"));
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function patch(body: unknown): Promise<Response> {
  return PATCH(
    new Request("http://localhost/api/providers", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function isProviderCatalogEntry(value: unknown): value is ProviderCatalogEntry {
  const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  return Boolean(
    entry &&
      typeof entry.id === "string" &&
      typeof entry.name === "string" &&
      typeof entry.shortDescription === "string" &&
      typeof entry.apiStyle === "string" &&
      typeof entry.authHeader === "string" &&
      typeof entry.envVar === "string" &&
      typeof entry.links === "object"
  );
}

test("GET returns the full catalog and only built-in providers when none saved", async () => {
  const res = await GET_();
  assert.equal(res.status, 200);
  const data = (await res.json()) as { catalog?: unknown; providers?: unknown };
  assert.ok(Array.isArray(data.catalog), "catalog must be an array");
  assert.ok(data.catalog.length >= 25, "catalog must have 25+ entries");
  for (const entry of data.catalog) {
    assert.ok(isProviderCatalogEntry(entry), "every catalog entry must keep its shape");
  }
  assert.ok(Array.isArray(data.providers));
  // Built-in defaults (anthropic/openai/gemini) appear even with no saved file.
  assert.equal((data.providers as unknown[]).length, 3);
});

test("GET never returns key material; only key counts", async () => {
  const key = "sk-secret-route-test";
  await post({ id: "openai", apiKey: key });
  const res = await GET_();
  const text = await res.text();
  assert.ok(!text.includes(key), "response must not contain the API key");
  const data = JSON.parse(text) as {
    catalog: Array<Record<string, unknown>>;
    providers: Array<Record<string, unknown>>;
  };
  const openai = data.catalog.find((e) => e.id === "openai");
  assert.equal(openai?.connected, true);
  assert.equal(openai?.keyCount, 1);
  const row = data.providers.find((p) => p.id === "openai");
  assert.equal(row?.keyCount, 1);
  assert.equal("keys" in data, false, "top level must not expose keys");
  assert.equal("keys" in (row ?? {}), false, "provider rows must not expose keys");
});

test("GET reports key slots as last-4 masks and marks saved providers", async () => {
  const key = "sk-secret-mask-test";
  await post({ id: "openai", apiKey: key });
  const text = await (await GET_()).text();
  assert.ok(!text.includes(key), "response must not contain the API key");
  const data = JSON.parse(text) as {
    catalog: Array<Record<string, unknown>>;
    providers: Array<Record<string, unknown>>;
  };
  const row = data.providers.find((p) => p.id === "openai");
  assert.equal(row?.saved, true);
  assert.deepEqual(row?.keySlots, [{ index: 0, mask: "••••test" }]);
  const entry = data.catalog.find((e) => e.id === "openai");
  assert.equal(entry?.saved, true);
  assert.deepEqual(entry?.keySlots, [{ index: 0, mask: "••••test" }]);

  // A provider that was never saved is not marked as saved and has no slots.
  const anthropic = data.providers.find((p) => p.id === "anthropic");
  assert.equal(anthropic?.saved, false);
  assert.deepEqual(anthropic?.keySlots, []);
});

test("PATCH adds or removes a single key by index", async () => {
  const key = "sk-secret-patch-test";
  await post({ id: "openai", apiKey: key });

  const added = await patch({ id: "openai", action: "add-key", apiKey: "sk-secret-second-one" });
  assert.equal(added.status, 200);
  const addedText = await added.text();
  assert.ok(!addedText.includes(key), "response must not contain the API key");
  assert.ok(!addedText.includes("sk-secret-second-one"), "response must not contain the new key");
  const addedBody = JSON.parse(addedText) as { keyCount?: number };
  assert.equal(addedBody.keyCount, 2);

  const removed = await patch({ id: "openai", action: "remove-key", index: 0 });
  assert.equal(removed.status, 200);
  const removedText = await removed.text();
  assert.ok(!removedText.includes(key), "response must not contain the API key");
  const removedBody = JSON.parse(removedText) as { keyCount?: number };
  assert.equal(removedBody.keyCount, 1);

  const stored = onDisk();
  assert.deepEqual(stored.providers[0].keys, ["sk-secret-second-one"]);
});

test("PATCH validates its payload", async () => {
  await post({ id: "openai", apiKey: "sk-secret-validate" });
  assert.equal((await patch({ action: "remove-key", index: 0 })).status, 400);
  assert.equal((await patch({ id: "openai", action: "nope" })).status, 400);
  assert.equal((await patch({ id: "nope", action: "add-key", apiKey: "sk-x" })).status, 404);
});

test("POST saves a provider server-side and returns a masked summary", async () => {
  const key = "sk-openai-abc123";
  const res = await post({
    id: "openai",
    apiKey: key,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { ok?: boolean; provider?: Record<string, unknown> };
  assert.equal(body.ok, true);
  assert.equal(body.provider?.id, "openai");
  assert.equal(body.provider?.label, "OpenAI");
  assert.equal(body.provider?.keyCount, 1);
  assert.equal("apiKey" in (body.provider ?? {}), false, "response must not echo the key");

  const stored = onDisk();
  assert.equal(stored.providers.length, 1);
  assert.deepEqual(stored.providers[0].keys, [key]);

  // The saved provider now appears in the router's provider set.
  const route = routerProviders(OWNER);
  const saved = route.find((p) => p.id === "openai");
  assert.ok(saved, "saved provider must appear in the router provider set");
  assert.deepEqual(saved?.keys, [key]);
});

test("POST saves rank and preserves it when the provider is re-saved without one", async () => {
  const first = await post({ id: "openai", apiKey: "sk-openai-first", rank: 4 });
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { provider?: Record<string, unknown> };
  assert.equal(firstBody.provider?.rank, 4);

  const second = await post({ id: "openai", apiKey: "sk-openai-second" });
  assert.equal(second.status, 201);
  const secondBody = (await second.json()) as { provider?: Record<string, unknown> };
  assert.equal(secondBody.provider?.rank, 4, "re-saving must not drop rank");

  const data = (await (await GET_()).json()) as {
    catalog: Array<Record<string, unknown>>;
    providers: Array<Record<string, unknown>>;
  };
  assert.equal(data.providers.find((p) => p.id === "openai")?.rank, 4);
  assert.equal(data.catalog.find((p) => p.id === "openai")?.rank, 4);
  const stored = onDisk() as { providers: Array<{ id: string; rank?: number }> };
  assert.equal(stored.providers.find((p) => p.id === "openai")?.rank, 4);
});

test("POST rejects a negative or non-numeric rank with a friendly error", async () => {
  for (const rank of [-1, "first", null]) {
    const res = await post({ id: "openai", apiKey: "sk-openai", rank });
    assert.equal(res.status, 400, `rank=${JSON.stringify(rank)}`);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /Rank must be a number greater than or equal to 0/);
  }
  assert.deepEqual(readConfiguredProviders(OWNER), []);
});

test("PATCH sets and moves provider rank without touching keys", async () => {
  await post({ id: "openai", apiKey: "sk-openai", rank: 5 });
  await post({ id: "groq", apiKey: "gsk-groq", rank: 6 });

  const set = await patch({ id: "openai", action: "set-rank", rank: 1 });
  assert.equal(set.status, 200);
  const setBody = (await set.json()) as { rank?: number; provider?: Record<string, unknown> };
  assert.equal(setBody.rank, 1);
  assert.equal(setBody.provider?.keyCount, 1, "rank changes keep the keys");

  const moved = await patch({ id: "groq", action: "move-up" });
  assert.equal(moved.status, 200);
  const movedBody = (await moved.json()) as { rank?: number };
  assert.equal(movedBody.rank, 2);

  const shorthand = await patch({ id: "openai", rank: 0 });
  assert.equal(shorthand.status, 200);

  assert.equal((await patch({ id: "openai", action: "set-rank", rank: -1 })).status, 400);
  assert.equal((await patch({ id: "anthropic", action: "move-up" })).status, 400);
  assert.equal((await patch({ id: "gemini", action: "move-down" })).status, 400);
  assert.equal((await patch({ id: "nope", action: "move-down" })).status, 404);
});

test("POST validates input and never writes on bad payloads", async () => {
  assert.equal((await post({ id: "" })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ id: "openai", apiKey: "x".repeat(600) })).status, 400);
  assert.equal((await post({ id: "openai", apiKey: "x" })).status, 201);
  assert.equal(
    (await post({ id: "openai", baseUrl: "http://evil.example.com", apiKey: "x" })).status,
    400
  );
  assert.equal((await post({ id: "groq", baseUrl: "https://good.example.com", apiKey: "x" })).status, 201);
  assert.equal((await post({ id: "openai", apiStyle: "banana" })).status, 400);
  assert.equal((await post({ id: "openai", models: "gpt-4o" })).status, 400);
  assert.equal((await post({ id: "openai", models: Array.from({ length: 51 }, (_, i) => `m${i}`) })).status, 400);

  // The rejected cases never wrote: only the two successful ones are on disk.
  const stored = onDisk();
  assert.equal(stored.providers.length, 2);
  assert.deepEqual(
    stored.providers.map((p) => p.id).sort(),
    ["groq", "openai"]
  );
});

test("POST requires a key for non-local providers", async () => {
  const res = await post({ id: "deepseek" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /API key/);
});

test("POST allows keyless local providers and grace-returns them", async () => {
  const res = await post({ id: "ollama" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { provider?: Record<string, unknown> };
  assert.equal(body.provider?.id, "ollama");
  assert.equal(body.provider?.keyCount, 0);
});

test("POST rejects malformed JSON", async () => {
  const res = await POST(
    new Request("http://localhost/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    })
  );
  assert.equal(res.status, 400);
});

test("POST accepts custom OpenAI-compatible providers with a base URL", async () => {
  const res = await post({
    id: "custom",
    baseUrl: "https://my-gateway.example.com/v1",
    models: ["my-model"],
    apiKey: "sk-custom",
  });
  assert.equal(res.status, 201);
  const saved = routerProviders(OWNER).find((p) => p.id === "custom");
  assert.ok(saved);
  assert.equal(saved.baseUrl, "https://my-gateway.example.com/v1");
  assert.deepEqual(saved.keys, ["sk-custom"]);
});

test("POST and PATCH normalize legacy apiStyle aliases to openai-chat", async () => {
  const postRes = await post({ id: "openai", apiKey: "sk-openai-alias", apiStyle: "openai-compatible" });
  assert.equal(postRes.status, 201);
  assert.equal(routerProviders(OWNER).find((p) => p.id === "openai")?.apiStyle, "openai-chat");

  // PATCH set-endpoint previously rejected the aliases with a 400.
  const patchRes = await patch({
    id: "openai",
    action: "set-endpoint",
    baseUrl: "https://gw.example.com/v1",
    apiStyle: "custom",
  });
  assert.equal(patchRes.status, 200);
  const updated = routerProviders(OWNER).find((p) => p.id === "openai");
  assert.equal(updated?.apiStyle, "openai-chat");
  assert.equal(updated?.baseUrl, "https://gw.example.com/v1");
});

test("POST refuses a body over the 16kb cap with 413", async () => {
  const res = await POST(
    new Request("http://localhost/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "openai", apiKey: "sk-test", pad: "x".repeat(16 * 1024) }),
    }),
  );
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "Request body is too large.");
});

test("PATCH refuses a body over the 16kb cap with 413", async () => {
  const res = await PATCH(
    new Request("http://localhost/api/providers", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "openai", action: "add-key", apiKey: "sk-test", pad: "x".repeat(16 * 1024) }),
    }),
  );
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "Request body is too large.");
});

test("POST and PATCH canonicalize mixed-case provider IDs (e.g. 'OpenAI')", async () => {
  const postRes = await post({
    id: "OpenAI",
    apiKey: "sk-mixed-case-test",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(postRes.status, 201);
  const postData = (await postRes.json()) as { provider?: { id?: string } };
  assert.equal(postData.provider?.id, "openai");

  const patchRes = await patch({
    id: "OpenAI",
    action: "set-endpoint",
    baseUrl: "https://gw.example.com/v1",
  });
  assert.equal(patchRes.status, 200);
  const patchData = (await patchRes.json()) as { provider?: { id?: string; baseUrl?: string } };
  assert.equal(patchData.provider?.id, "openai");
  assert.equal(patchData.provider?.baseUrl, "https://gw.example.com/v1");

  const keyPatch = await patch({
    id: "OpenAI",
    action: "add-key",
    apiKey: "sk-second-key-test",
  });
  assert.equal(keyPatch.status, 200);
});
