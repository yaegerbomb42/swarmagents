/**
 * Tests for GET /api/providers/health.
 *
 * Regression tests for:
 * 1. The prod QA finding (2026-11-12): the first call returned only a partial snapshot,
 *    ok:false with "No keys configured", and an epoch-sized latencyMs.
 * 2. Key fingerprinting: rotating a single key in place invalidates the checker cache
 *    so it does not keep pinging with a stale key.
 * 3. Idle timers: checkers idle for >5 minutes stop polling and are pruned from memory.
 * 4. ?refresh=1 parameter: triggers an immediate probe round.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "./route";
import {
  IDLE_TIMEOUT_MS,
  pruneIdleCheckers,
  _testInspectCheckers,
  _testResetCheckers,
} from "../../../../lib/providers/health-pool";
import {
  configureProviderStorePaths,
  routerProviders,
  saveProvider,
} from "../../../../lib/providers/store";

const OPENAI_KEY = "sk-health-route-openai";
const ANTHROPIC_KEY = "sk-health-route-anthropic";

let tempDir: string;
let originalFetch: typeof fetch;

test.before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-health-route-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("anthropic")) {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "pong" }],
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "test-fast",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "test-fast",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  _testResetCheckers();
  rmSync(tempDir, { recursive: true, force: true });
});

test("first GET covers every configured provider with real latencies", async () => {
  saveProvider("local", { id: "openai", apiKey: OPENAI_KEY });
  saveProvider("local", { id: "anthropic", apiKey: ANTHROPIC_KEY });

  const res = await GET(new Request("http://localhost/api/providers/health"));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(OPENAI_KEY), false, "response leaked the OpenAI key");
  assert.equal(text.includes(ANTHROPIC_KEY), false, "response leaked the Anthropic key");
  const body = JSON.parse(text) as {
    providers: Array<{
      id: string;
      ok: boolean;
      latencyMs: number | null;
      checkedAt: number;
      checking?: boolean;
      error?: string;
    }>;
  };

  // Every provider the router knows about is present — none silently absent.
  const expectedIds = routerProviders("local").map((p) => p.id).sort();
  const actualIds = body.providers.map((p) => p.id).sort();
  assert.deepEqual(actualIds, expectedIds);

  const byId = new Map(body.providers.map((p) => [p.id, p]));
  assert.equal(byId.get("openai")?.ok, true);
  assert.equal(byId.get("anthropic")?.ok, true);

  for (const entry of body.providers) {
    // No epoch-sized latencies, no "checking" entries on a completed round.
    assert.equal(entry.checking, undefined, `${entry.id} still checking`);
    assert.ok(
      entry.latencyMs === null ||
        (typeof entry.latencyMs === "number" &&
          Number.isFinite(entry.latencyMs) &&
          entry.latencyMs >= 0 &&
          entry.latencyMs < 60_000),
      `${entry.id} latencyMs was ${entry.latencyMs}`
    );
  }

  // Keyless providers report null latency, not now() - 0.
  const gemini = byId.get("gemini");
  assert.ok(gemini, "gemini entry missing");
  if (!gemini.ok) {
    assert.equal(gemini.error, "No keys configured");
    assert.equal(gemini.latencyMs, null);
  }
});

test("the checker cache rebuilds when a provider's baseUrl changes", async () => {
  const urls: string[] = [];
  const testFetch = (async (url: string | URL | Request) => {
    const href = String(url);
    urls.push(href);
    if (href.includes("anthropic")) {
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "pong" }], usage: { input_tokens: 1, output_tokens: 1 }, model: "test-fast" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "test-fast" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const prev = globalThis.fetch;
  globalThis.fetch = testFetch;

  try {
    saveProvider("local", { id: "openai", apiKey: OPENAI_KEY, baseUrl: "https://one.example.com/v1" });
    await GET(new Request("http://localhost/api/providers/health"));
    assert.ok(urls.some((u) => u.includes("one.example.com")), "first round should ping the original baseUrl");

    urls.length = 0;
    saveProvider("local", { id: "openai", apiKey: OPENAI_KEY, baseUrl: "https://two.example.com/v1" });
    await GET(new Request("http://localhost/api/providers/health"));
    assert.ok(urls.some((u) => u.includes("two.example.com")), "editing the baseUrl should rebuild the checker and ping the new URL");
  } finally {
    globalThis.fetch = prev;
  }
});

test("rotating a key in place invalidates the checker cache and uses the new key", async () => {
  const seenAuthHeaders: string[] = [];
  const testFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? "";
    seenAuthHeaders.push(auth);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "test-fast" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const prev = globalThis.fetch;
  globalThis.fetch = testFetch;

  try {
    const KEY_V1 = "sk-key-version-one";
    const KEY_V2 = "sk-key-version-two";

    // 1. Initial key setup
    saveProvider("local", { id: "openai", apiKey: KEY_V1 });
    await GET(new Request("http://localhost/api/providers/health"));
    assert.ok(seenAuthHeaders.includes(`Bearer ${KEY_V1}`), "should have pinged with KEY_V1");

    seenAuthHeaders.length = 0;

    // 2. Rotate the single key in place (key length is still 1, but content changed)
    saveProvider("local", { id: "openai", apiKey: KEY_V2 });
    await GET(new Request("http://localhost/api/providers/health"));
    assert.ok(seenAuthHeaders.includes(`Bearer ${KEY_V2}`), "should have picked up KEY_V2 after rotation");
    assert.ok(!seenAuthHeaders.includes(`Bearer ${KEY_V1}`), "should not ping with stale KEY_V1");
  } finally {
    globalThis.fetch = prev;
  }
});

test("idle checker stops and is pruned after 5 minutes of inactivity", async () => {
  _testResetCheckers();

  saveProvider("local", { id: "openai", apiKey: OPENAI_KEY });
  await GET(new Request("http://localhost/api/providers/health"));

  let inspected = _testInspectCheckers();
  assert.equal(inspected.size, 1);
  const entryBefore = inspected.get("local");
  assert.ok(entryBefore, "checker for local owner should exist");

  let stoppedCalled = false;
  const originalStop = entryBefore.checker.stop.bind(entryBefore.checker);
  entryBefore.checker.stop = () => {
    stoppedCalled = true;
    originalStop();
  };

  // Advance time past 5 minutes (IDLE_TIMEOUT_MS)
  const future = Date.now() + IDLE_TIMEOUT_MS + 1000;
  const pruned = pruneIdleCheckers(IDLE_TIMEOUT_MS, future);
  assert.equal(pruned, 1, "should have pruned 1 idle checker");

  inspected = _testInspectCheckers();
  assert.equal(inspected.size, 0, "checkers map should be empty after pruning");
  assert.equal(stoppedCalled, true, "pruned checker should have had stop() called to halt polling");
});

test("?refresh=1 triggers an immediate probe round", async () => {
  let probeCount = 0;
  const testFetch = (async () => {
    probeCount++;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "test-fast" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const prev = globalThis.fetch;
  globalThis.fetch = testFetch;

  try {
    _testResetCheckers();
    saveProvider("local", { id: "openai", apiKey: OPENAI_KEY });

    // Initial call performs the first check round
    await GET(new Request("http://localhost/api/providers/health"));
    const countAfterFirst = probeCount;
    assert.ok(countAfterFirst > 0, "first GET should run probe");

    // Regular GET right after does not run a new round because first round is already settled
    await GET(new Request("http://localhost/api/providers/health"));
    assert.equal(probeCount, countAfterFirst, "subsequent regular GET without refresh should not trigger another probe round immediately");

    // GET with ?refresh=1 triggers immediate probe round
    const res = await GET(new Request("http://localhost/api/providers/health?refresh=1"));
    assert.equal(res.status, 200);
    assert.ok(probeCount > countAfterFirst, "?refresh=1 should have triggered a new probe round");
  } finally {
    globalThis.fetch = prev;
  }
});
