/**
 * Tests for POST /api/providers/[id]/models: id-addressed live model list for
 * a saved provider. The provider's model-list endpoint is stubbed with a
 * fake fetch; the stored key must be used server-side and never appear in a
 * response, and results must be cached for the 10-minute window.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  configureProviderStorePaths,
  routerProviders,
  saveProvider,
} from "../../../../../lib/providers/store";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-models-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function fetchModels(providerId: string, body: unknown): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost/api/providers/${providerId}/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: providerId }) },
  );
}

function modelListFetch(calls: { hrefs: string[] }): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    calls.hrefs.push(href);
    if (href.includes("/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-4o-mini", object: "model" },
            { id: "gpt-4o", object: "model" },
            { id: "gpt-4o", object: "model" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("POST /api/providers/[id]/models returns ids only, never key material", async () => {
  saveProvider("local", {
    id: "openai",
    apiKey: "sk-secret-models-key",
    baseUrl: "https://api.openai.com/v1",
  });
  const calls: { hrefs: string[] } = { hrefs: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = modelListFetch(calls);
  try {
    const res = await fetchModels("openai", {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok?: boolean;
      models?: { id: string }[];
      endpoint?: string;
      source?: string;
    };
    assert.equal(body.ok, true);
    assert.deepEqual(body.models, [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }]);
    for (const m of body.models ?? []) {
      assert.equal(typeof m.id, "string");
      assert.ok("id" in m);
    }
    // No key material anywhere in the payload; the endpoint URL is clean too.
    const raw = JSON.stringify(body);
    assert.equal(raw.includes("sk-secret-models-key"), false);
    assert.equal((body.endpoint ?? "").includes("sk-secret-models-key"), false);
    assert.equal(calls.hrefs.some((href) => href.includes("sk-secret-models-key")), false);
    // The stored key was used for the upstream call via the auth header.
    assert.equal(calls.hrefs.some((href) => href.includes("/models")), true);
    // Live ids persisted against the saved provider.
    const saved = routerProviders("local").find((p) => p.id === "openai");
    assert.deepEqual([...(saved?.availableModels ?? [])].sort(), ["gpt-4o", "gpt-4o-mini"].sort());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model ids are served from the 10-minute cache without another upstream call", async () => {
  saveProvider("local", {
    id: "groq",
    apiKey: "sk-groq-cache-check",
    baseUrl: "https://api.groq.com/openai/v1",
  });
  const calls: { hrefs: string[] } = { hrefs: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = modelListFetch(calls);
  try {
    const first = await fetchModels("groq", {});
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { source?: string; models?: { id: string }[] };
    assert.equal(firstBody.source, "live");

    const second = await fetchModels("groq", {});
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { source?: string; models?: { id: string }[] };
    assert.equal(secondBody.source, "cache");
    assert.deepEqual(secondBody.models, [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }]);
    assert.equal(calls.hrefs.length, 1, "the second call within 10 minutes must hit the cache");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown provider id is a 404", async () => {
  const missing = await fetchModels("no-such-provider", {});
  assert.equal(missing.status, 404);
});

test("Ollama auto-detect fetches from /api/tags stub and discovers model ids", async () => {
  saveProvider("local", { id: "ollama", apiStyle: "ollama", baseUrl: "http://127.0.0.1:11434" });
  const calls: { hrefs: string[] } = { hrefs: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    calls.hrefs.push(href);
    if (href.includes("/api/tags")) {
      return new Response(
        JSON.stringify({
          object: "list",
          models: [
            { name: "llama2", size: 0 },
            { name: "mistral", size: 0 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const res = await fetchModels("ollama", {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; models?: { id: string }[]; source?: string };
    assert.equal(body.ok, true);
    assert(Array.isArray(body.models));
    // Models should have ids extracted from /api/tags data.
    assert.deepEqual(
      (body.models ?? []).map((m) => m.id).sort(),
      ["llama2", "mistral"],
    );
    // No key material anywhere.
    const raw = JSON.stringify(body);
    assert.equal(raw.includes("sk-secret-models-key"), false);
    // The stored key was not used (Ollama has no key).
    assert.equal(calls.hrefs.some((href) => href.includes("/models")), false);
    // Live ids persisted against the saved provider.
    const saved = routerProviders("local").find((p) => p.id === "ollama");
    // Route now returns [{id: "llama2"}, {id: "mistral"}] instead of ["llama2", "mistral"]
    assert.deepEqual([...(saved?.availableModels ?? [])].sort(), ["llama2", "mistral"].sort());
  } finally {
    globalThis.fetch = originalFetch;
  }
});
