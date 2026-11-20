/**
 * Tests for the Ollama endpoint as a user setting.
 *
 * PUT /api/providers/settings already persisted ollamaBaseUrl, but every Ollama
 * call site still hardcoded http://127.0.0.1:11434, so a custom local/LAN port
 * never took effect. These tests pin discover, test, and the router to the
 * saved setting, and pin the fallback when it is unset.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST as DISCOVER } from "./discover/route";
import { POST as TEST_CONNECTION } from "./test/route";
import {
  configureProviderStorePaths,
  routerProviders,
  saveProvider,
  userProvidersSignature,
} from "../../../lib/providers/store";
import { DEFAULT_OLLAMA_URL, writeUserSettings } from "../../../lib/providers/settings";

const CUSTOM = "http://127.0.0.1:11500";
let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-ollama-base-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

function post(route: (request: NextRequest) => Promise<Response>, path: string, body: unknown): Promise<Response> {
  return route(
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function setOllama(url: string | undefined): void {
  writeUserSettings("local", {
    preferFreeProviders: true,
    ...(url ? { ollamaBaseUrl: url } : {}),
  });
}

/** Stub fetch for the Ollama probes, recording the URLs it was asked for. */
function recordingFetch(calls: string[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (href.endsWith("/api/tags")) return json({ models: [{ name: "llama3.2:1b" }] });
    if (href.endsWith("/api/show")) return json({ capabilities: ["completion"] });
    return json({ message: { role: "assistant", content: "pong" }, done: true });
  }) as typeof fetch;
}

test("discover uses the saved ollamaBaseUrl instead of the default", async () => {
  setOllama(CUSTOM);
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  try {
    const res = await post(DISCOVER, "/api/providers/discover", { apiStyle: "ollama", save: false });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; models?: unknown[] };
    assert.equal(body.ok, true);
    assert.equal(body.models?.length, 1);
    assert.ok(
      calls.length > 0 && calls.every((href) => href.startsWith(CUSTOM)),
      `every Ollama probe should hit ${CUSTOM}, got ${calls.join(", ")}`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("discover falls back to the local default when no setting is saved", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  try {
    const res = await post(DISCOVER, "/api/providers/discover", { apiStyle: "ollama", save: false });
    assert.equal(res.status, 200);
    assert.ok(
      calls.length > 0 && calls.every((href) => href.startsWith(DEFAULT_OLLAMA_URL)),
      `unset setting should use ${DEFAULT_OLLAMA_URL}, got ${calls.join(", ")}`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("the connection test uses the saved ollamaBaseUrl", async () => {
  setOllama(CUSTOM);
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  try {
    const res = await post(TEST_CONNECTION, "/api/providers/test", {
      apiStyle: "ollama",
      model: "llama3.2:1b",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean };
    assert.equal(body.ok, true);
    assert.deepEqual(calls, [`${CUSTOM}/api/chat`]);
  } finally {
    globalThis.fetch = original;
  }
});

test("the connection test falls back to the local default when unset", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  try {
    const res = await post(TEST_CONNECTION, "/api/providers/test", {
      apiStyle: "ollama",
      model: "llama3.2:1b",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [`${DEFAULT_OLLAMA_URL}/api/chat`]);
  } finally {
    globalThis.fetch = original;
  }
});

test("routerProviders sends the saved provider to the configured endpoint", () => {
  // Saving an Ollama provider persists the catalog default into the file; that
  // must be read as "nothing chosen", not as a pin.
  saveProvider("local", { id: "ollama" });
  setOllama(CUSTOM);
  const ollama = routerProviders("local").find((provider) => provider.id === "ollama");
  assert.ok(ollama, "the saved ollama provider is in the router list");
  assert.equal(ollama.baseUrl, CUSTOM);
});

test("routerProviders keeps the default when no setting is saved", () => {
  saveProvider("local", { id: "ollama" });
  const ollama = routerProviders("local").find((provider) => provider.id === "ollama");
  assert.equal(ollama?.baseUrl, DEFAULT_OLLAMA_URL);
});

test("a baseUrl pinned on the ollama provider wins over the setting", () => {
  setOllama(CUSTOM);
  saveProvider("local", { id: "ollama", baseUrl: "http://127.0.0.1:11999" });
  const ollama = routerProviders("local").find((provider) => provider.id === "ollama");
  assert.equal(ollama?.baseUrl, "http://127.0.0.1:11999");
});

test("saving only the setting changes the router cache signature", () => {
  saveProvider("local", { id: "openai", apiKey: "sk-test-not-a-real-key", baseUrl: "https://api.openai.com/v1" });
  const before = userProvidersSignature("local");
  setOllama(CUSTOM);
  const after = userProvidersSignature("local");
  assert.notEqual(after, before, "a settings-only change must invalidate the cached router");
});
