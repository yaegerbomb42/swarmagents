/**
 * Tests for the structured probe result on POST /api/providers/[id]/test:
 * failures carry errorClass/status/model alongside the existing fields,
 * successes echo the probed model, and no response carries key material.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST, _resetProbeBucketForTests } from "./route";
import {
  configureProviderStorePaths,
  saveProvider,
} from "../../../../../lib/providers/store";

const KEY = "test-key-not-real";

let tempDir: string;

test.beforeEach(() => {
  _resetProbeBucketForTests();
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-test-errors-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  saveProvider("local", { id: "openai", apiKey: KEY });
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function post(id: string): Promise<Response> {
  return POST(new Request(`http://localhost/api/providers/${id}/test`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

interface TestBody {
  test: {
    id: string;
    ok: boolean;
    latencyMs: number | null;
    error?: string;
    errorClass?: string;
    errorKind?: string;
    status?: number;
    model?: string;
  };
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

test("a 401 probe reports errorClass auth, status 401, and the probed model", async () => {
  await withFetch(
    (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
    async () => {
      const res = await post("openai");
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.equal(text.includes(KEY), false, "response must not leak the key");
      const body = JSON.parse(text) as TestBody;
      assert.equal(body.test.ok, false);
      assert.match(body.test.error ?? "", /401/);
      assert.equal(body.test.errorClass, "auth");
      assert.equal(body.test.errorKind, "auth");
      assert.equal(body.test.status, 401);
      // The fast tier of the saved catalog models.
      assert.equal(body.test.model, "gpt-4.1");
      assert.equal(typeof body.test.latencyMs, "number");
    },
  );
});

test("a 429 probe reports errorClass rate-limit", async () => {
  await withFetch(
    (async () => new Response("slow down", { status: 429 })) as typeof fetch,
    async () => {
      const body = (await (await post("openai")).json()) as TestBody;
      assert.equal(body.test.ok, false);
      assert.equal(body.test.errorClass, "rate-limit");
      assert.equal(body.test.status, 429);
    },
  );
});

test("a thrown fetch reports errorClass network with no status", async () => {
  await withFetch(
    (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    async () => {
      const body = (await (await post("openai")).json()) as TestBody;
      assert.equal(body.test.ok, false);
      assert.equal(body.test.errorClass, "network");
      assert.equal(body.test.status, undefined);
    },
  );
});

test("a successful probe echoes the model and status 200", async () => {
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
      const body = (await (await post("openai")).json()) as TestBody;
      assert.equal(body.test.ok, true);
      assert.equal(body.test.model, "gpt-4.1");
      assert.equal(body.test.status, 200);
      assert.equal(typeof body.test.latencyMs, "number");
    },
  );
});
