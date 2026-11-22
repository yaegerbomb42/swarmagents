/**
 * Tests for the structured result on POST /api/providers/test (draft
 * testing): failures carry errorClass/kind/status/latencyMs alongside the
 * existing ok/error fields; successes gain status 200. The existing
 * response shape is extended, never broken.
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
  saveProvider,
} from "../../../../lib/providers/store";

const KEY = "test-key-not-real";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-draft-test-errors-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  saveProvider("local", {
    id: "openai",
    apiKey: KEY,
    baseUrl: "https://api.openai.com/v1",
  });
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function testProvider(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/providers/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function withFetch(impl: typeof fetch, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a 401 draft test reports errorClass auth with status and latency", async () => {
  await withFetch(
    (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
    async () => {
      const res = await testProvider({ id: "openai", model: "gpt-4.1" });
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.equal(text.includes(KEY), false, "response must not leak the key");
      const body = JSON.parse(text) as {
        ok: boolean;
        error: string;
        errorClass?: string;
        kind?: string;
        status?: number;
        latencyMs?: number;
      };
      assert.equal(body.ok, false);
      assert.equal(typeof body.error, "string");
      assert.equal(body.errorClass, "auth");
      assert.equal(body.kind, "auth");
      assert.equal(body.status, 401);
      assert.equal(typeof body.latencyMs, "number");
    },
  );
});

test("a network failure reports errorClass network", async () => {
  await withFetch(
    (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    async () => {
      const res = await testProvider({ id: "openai", model: "gpt-4.1" });
      assert.equal(res.status, 502);
      const body = (await res.json()) as { ok: boolean; errorClass?: string; status?: number };
      assert.equal(body.ok, false);
      assert.equal(body.errorClass, "network");
      assert.equal(body.status, undefined);
    },
  );
});

test("a successful draft test keeps its shape and gains status 200", async () => {
  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "pong" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: "gpt-4.1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
    async () => {
      const res = await testProvider({ id: "openai", model: "gpt-4.1" });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        model: string;
        text: string;
        latencyMs: number;
        endpoint: string;
        status?: number;
      };
      assert.equal(body.ok, true);
      assert.equal(body.model, "gpt-4.1");
      assert.equal(body.status, 200);
      assert.equal(typeof body.latencyMs, "number");
      assert.ok(body.endpoint.includes("api.openai.com"));
    },
  );
});
