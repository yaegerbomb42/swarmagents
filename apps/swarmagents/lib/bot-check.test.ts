/**
 * Bot-check tests (FIX-44): unconfigured deployments skip the check;
 * configured ones fail closed on a missing token, a provider rejection,
 * and transport failures. The provider call is stubbed — no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { botCheckConfigured, botCheckSiteKey, verifyBotToken } from "./bot-check";

const CONFIGURED = { SWARM_TURNSTILE_SECRET: "test-secret" };

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
}

test("unconfigured: check is skipped and site key is empty", async () => {
  assert.equal(botCheckConfigured({}), false);
  assert.equal(botCheckSiteKey({}), "");
  assert.deepEqual(await verifyBotToken(undefined, { env: {} }), { ok: true });
  assert.deepEqual(await verifyBotToken("anything", { env: {} }), { ok: true });
});

test("configured: missing or blank token fails without calling the provider", async () => {
  let called = false;
  const fetchImpl = stubFetch(async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });
  assert.equal(botCheckConfigured(CONFIGURED), true);
  const missing = await verifyBotToken(undefined, { env: CONFIGURED, fetchImpl });
  assert.equal(missing.ok, false);
  const blank = await verifyBotToken("   ", { env: CONFIGURED, fetchImpl });
  assert.equal(blank.ok, false);
  assert.equal(called, false);
});

test("configured: provider success passes and sends secret+response form-encoded", async () => {
  let seenBody = "";
  const fetchImpl = stubFetch(async (_url, init) => {
    seenBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  const result = await verifyBotToken("tok-123", { env: CONFIGURED, fetchImpl, remoteIp: "203.0.113.7" });
  assert.deepEqual(result, { ok: true });
  const params = new URLSearchParams(seenBody);
  assert.equal(params.get("secret"), "test-secret");
  assert.equal(params.get("response"), "tok-123");
  assert.equal(params.get("remoteip"), "203.0.113.7");
});

test("configured: provider rejection, non-200, malformed JSON and transport failure all fail closed", async () => {
  const rejected = await verifyBotToken("tok", {
    env: CONFIGURED,
    fetchImpl: stubFetch(async () => new Response(JSON.stringify({ success: false }), { status: 200 })),
  });
  assert.equal(rejected.ok, false);

  const nonOk = await verifyBotToken("tok", {
    env: CONFIGURED,
    fetchImpl: stubFetch(async () => new Response("nope", { status: 503 })),
  });
  assert.equal(nonOk.ok, false);

  const malformed = await verifyBotToken("tok", {
    env: CONFIGURED,
    fetchImpl: stubFetch(async () => new Response("not json", { status: 200 })),
  });
  assert.equal(malformed.ok, false);

  const transport = await verifyBotToken("tok", {
    env: CONFIGURED,
    fetchImpl: stubFetch(async () => {
      throw new Error("connection refused");
    }),
  });
  assert.equal(transport.ok, false);
});
