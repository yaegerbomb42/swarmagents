/**
 * Route tests for POST /api/runtime/web/<runToken>/search:
 * run-token auth rejection (missing/invalid/inactive), the structured
 * not-configured error, per-user key isolation (one account's key can never
 * serve another's run), and the happy path. The outbound search fetch is a
 * global stub — no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { clearRevokedRunTokens, signRunToken } from "../../../../../../lib/runtime/run-token";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../../../lib/runtime/manager";
import { resetWebRateLimit } from "../../../../../../lib/runtime/web-shared";
import { VmManager } from "../../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../../lib/vm/fake-driver";
import { configureProviderStorePaths } from "../../../../../../lib/providers/store";
import { updateUserSettings } from "../../../../../../lib/providers/settings";
import { clearWebSearchCache } from "../../../../../../lib/web/search";

const ENV: Record<string, string | undefined> = { SWARM_SESSION_SECRET: "web-route-secret" };
const USER_A = "local_alice@example.com";
const USER_B = "local_bob@example.com";

let tempDir: string;
let realFetch: typeof fetch;
let fetchCalls: Array<{ url: string; init: RequestInit }>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeManager(): RuntimeManager {
  return new RuntimeManager({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });
}

function searchReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/runtime/web/placeholder/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(token: string) {
  return { params: Promise.resolve({ runToken: token }) };
}

test.before(() => {
  process.env.SWARM_SESSION_SECRET = "web-route-secret";
  realFetch = globalThis.fetch;
});

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-web-route-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("api.search.brave.com")) {
      return jsonResponse({ web: { results: [{ title: "Brave hit", url: "https://b.example", description: "bd" }] } });
    }
    if (String(url).includes("api.tavily.com")) {
      return jsonResponse({ results: [{ title: "Tavily hit", url: "https://t.example", content: "td" }] });
    }
    return jsonResponse({ error: "unexpected url" }, 500);
  }) as typeof fetch;
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  setRuntimeManagerForTesting(null);
  clearRevokedRunTokens();
  resetWebRateLimit();
  clearWebSearchCache();
  rmSync(tempDir, { recursive: true, force: true });
});

test("a missing or invalid run token is rejected with 401", async () => {
  const manager = makeManager();
  manager.start(USER_A, { prompt: "hi" });
  setRuntimeManagerForTesting(manager);

  const missing = await POST(searchReq({ query: "x" }), ctx(""));
  assert.equal(missing.status, 401);

  const bogus = await POST(searchReq({ query: "x" }), ctx("rt1.not-a-real-token.nope"));
  assert.equal(bogus.status, 401);
  assert.equal(fetchCalls.length, 0);
});

test("a token for a run that is not active is rejected with 401", async () => {
  const manager = makeManager();
  manager.start(USER_A, { prompt: "hi" });
  setRuntimeManagerForTesting(manager);
  const token = signRunToken(USER_A, "run_never_started", { env: ENV });
  const res = await POST(searchReq({ query: "x" }), ctx(token));
  assert.equal(res.status, 401);
  assert.equal(fetchCalls.length, 0);
});

test("an account without web search configured gets a structured 503", async () => {
  const manager = makeManager();
  const started = manager.start(USER_A, { prompt: "hi" });
  assert.ok(started.accepted);
  setRuntimeManagerForTesting(manager);
  const token = signRunToken(USER_A, started.runId, { env: ENV });

  const res = await POST(searchReq({ query: "node test" }), ctx(token));
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /not configured/);
  assert.equal(fetchCalls.length, 0);
});

test("each run searches with its own owner's key, never another account's", async () => {
  updateUserSettings(USER_A, { webSearch: { backend: "brave", apiKey: "alice-brave-key" } });
  updateUserSettings(USER_B, { webSearch: { backend: "tavily", apiKey: "bob-tavily-key" } });

  const manager = makeManager();
  const runA = manager.start(USER_A, { prompt: "hi" });
  const runB = manager.start(USER_B, { prompt: "hi" });
  assert.ok(runA.accepted && runB.accepted);
  setRuntimeManagerForTesting(manager);

  const resA = await POST(searchReq({ query: "alice query" }), ctx(signRunToken(USER_A, runA.runId, { env: ENV })));
  assert.equal(resA.status, 200);
  const bodyA = (await resA.json()) as { ok: boolean; results: Array<{ title: string }> };
  assert.equal(bodyA.ok, true);
  assert.equal(bodyA.results[0].title, "Brave hit");

  const resB = await POST(searchReq({ query: "bob query" }), ctx(signRunToken(USER_B, runB.runId, { env: ENV })));
  assert.equal(resB.status, 200);
  const bodyB = (await resB.json()) as { ok: boolean; results: Array<{ title: string }> };
  assert.equal(bodyB.results[0].title, "Tavily hit");

  assert.equal(fetchCalls.length, 2);
  const [callA, callB] = fetchCalls;
  // Alice's run → Brave with Alice's key in the header; Bob's key nowhere.
  assert.match(callA.url, /api\.search\.brave\.com/);
  const headersA = callA.init.headers as Record<string, string>;
  assert.equal(headersA["X-Subscription-Token"], "alice-brave-key");
  assert.equal(JSON.stringify(callA).includes("bob-tavily-key"), false);
  // Bob's run → Tavily with Bob's key in the body; Alice's key nowhere.
  assert.match(callB.url, /api\.tavily\.com/);
  const sentB = JSON.parse(String(callB.init.body)) as { api_key: string };
  assert.equal(sentB.api_key, "bob-tavily-key");
  assert.equal(JSON.stringify(callB).includes("alice-brave-key"), false);
});

test("an empty query is a 400, before any backend call", async () => {
  updateUserSettings(USER_A, { webSearch: { backend: "brave", apiKey: "alice-brave-key" } });
  const manager = makeManager();
  const started = manager.start(USER_A, { prompt: "hi" });
  assert.ok(started.accepted);
  setRuntimeManagerForTesting(manager);
  const token = signRunToken(USER_A, started.runId, { env: ENV });

  const res = await POST(searchReq({ query: "  " }), ctx(token));
  assert.equal(res.status, 400);
  assert.equal(fetchCalls.length, 0);
});
