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

const KEY = "sk-secret-test-aaaa";

let tempDir: string;
let providersFile: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-test-route-"));
  providersFile = join(tempDir, "providers.json");
  configureProviderStorePaths(providersFile);
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
