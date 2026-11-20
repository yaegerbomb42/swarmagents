/**
 * Tests for POST /api/providers/test.
 *
 * Regression: the legacy apiStyle aliases ("openai-compatible", "custom") are
 * accepted on POST /api/providers but were rejected with a 400 here. They must
 * normalize to "openai-chat" the same way.
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

const KEY = "sk-secret-test-aaaa";

let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-test-route-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
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
    })
  );
}

test("POST /api/providers/test accepts legacy apiStyle aliases instead of 400", async () => {
  saveProvider("local", {
    id: "openai",
    apiKey: KEY,
    baseUrl: "https://api.openai.com/v1",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "fast",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  try {
    for (const alias of ["openai-compatible", "custom"]) {
      const res = await testProvider({
        id: "openai",
        apiStyle: alias,
        model: "fast",
      });
      assert.equal(res.status, 200, `alias "${alias}" should be accepted, not 400`);
      const text = await res.text();
      assert.equal(text.includes(KEY), false, "response must not leak the key");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/providers/test resolves mixed-case IDs (e.g. 'OpenAI')", async () => {
  saveProvider("local", {
    id: "openai",
    apiKey: KEY,
    baseUrl: "https://api.openai.com/v1",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "fast",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  try {
    const res = await testProvider({
      id: "OpenAI",
      model: "fast",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean };
    assert.equal(body.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
