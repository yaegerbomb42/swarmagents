/**
 * Tests for POST /api/providers/[id]/test.
 *
 * The endpoint runs the live health probe for exactly that provider and
 * returns the outcome (ok/latency/error kind). No response may ever carry
 * key material.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST } from "./route";
import {
  configureProviderStorePaths,
  saveProvider,
} from "../../../../../lib/providers/store";
import { resetBuckets } from "../../../../../lib/rate-limit";

const KEY = "sk-secret-test-aaaa";

let tempDir: string;
let providersFile: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-test-route-"));
  providersFile = join(tempDir, "providers.json");
  configureProviderStorePaths(providersFile);
  resetBuckets();
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function post(id: string): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/providers/${id}/test`, { method: "POST" }),
    ctx(id)
  );
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "pong" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: "fast",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

test("POST /api/providers/[id]/test runs the probe and returns ok/latency without key material", async () => {
  saveProvider("local", { id: "openai", apiKey: KEY });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => okResponse()) as typeof fetch;
  try {
    const res = await post("openai");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes(KEY), false, 'response leaked the key');
    const body = JSON.parse(text) as {
      test: { id: string; ok: boolean; latencyMs: number; checkedAt: number };
    };
    assert.equal(body.test.id, "openai");
    assert.equal(body.test.ok, true);
    assert.equal(typeof body.test.latencyMs, "number");
    assert.equal(typeof body.test.checkedAt, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST returns 404 for an unknown provider", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => okResponse()) as typeof fetch;
  try {
    const res = await post("nope");
    assert.equal(res.status, 404);
    const body = JSON.parse(await res.text()) as { error?: string };
    assert.equal(typeof body.error, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST surfaces a failing probe with an error kind and no key material", async () => {
  saveProvider("local", { id: "openai", apiKey: KEY });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    const res = await post("openai");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes(KEY), false, 'response leaked the key');
    const body = JSON.parse(text) as { test: { ok: boolean; error?: string } };
    assert.equal(body.test.ok, false);
    assert.match(body.test.error ?? "", /401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST returns 404 with Cache-Control: no-store for an unknown provider", async () => {
  const res = await post("nope");
  assert.equal(res.status, 404);
  assert.equal((res.headers.get("cache-control") ?? "").toLowerCase(), "no-store");
});

test("per-user probe rate limit trips at 30/min with 429, Retry-After and no-store", async () => {
  // Each unknown-provider probe still consumes a token: the check runs
  // before the provider lookup.
  for (let i = 0; i < 30; i++) {
    const res = await post("nope");
    assert.equal(res.status, 404, `probe ${i + 1} should miss, not rate-limit`);
  }
  const limited = await post("nope");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after") ?? "0") > 0, "expected a Retry-After");
  assert.equal((limited.headers.get("cache-control") ?? "").toLowerCase(), "no-store");

  // The budget is per user: another account is unaffected.
  const other = await POST(
    new Request("http://localhost/api/providers/nope/test", {
      method: "POST",
      headers: { "x-swarm-user": "bob" },
    }),
    ctx("nope"),
  );
  assert.equal(other.status, 404);
});

test("POST returns resolved runMode & capabilities alongside probe result without leaking key", async () => {
  saveProvider("local", { id: "openai", apiKey: KEY, models: ["gpt-4o"] });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => okResponse()) as typeof fetch;
  try {
    const res = await post("openai");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text.includes(KEY), false, "response leaked the key");
    const body = JSON.parse(text) as {
      test: { ok: boolean };
      runMode?: { mode: string; label: string; capabilities: { vision: boolean; tools: boolean } };
    };
    assert.equal(body.test.ok, true);
    assert.ok(body.runMode, "expected runMode capability summary");
    assert.equal(body.runMode?.capabilities.vision, true);
    assert.equal(body.runMode?.capabilities.tools, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
