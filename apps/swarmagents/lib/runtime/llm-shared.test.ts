/**
 * Unit tests for the LLM translation endpoint auth layer
 * (lib/runtime/llm-shared.ts): per-run token verification against the live
 * runtime, so wrong-user/wrong-run/expired/revoked tokens are rejected.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { authLlmCall, resetLlmRateLimit } from "./llm-shared";
import { clearRevokedRunTokens, revokeRunToken, signRunToken } from "./run-token";
import { RuntimeManager, setRuntimeManagerForTesting } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";

const ENV: Record<string, string | undefined> = { SWARM_SESSION_SECRET: "llm-shared-secret" };
const USER = "user-llm-shared";

function makeManager(): RuntimeManager {
  return new RuntimeManager({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });
}

function tokenReq(token: string, userHeader?: string): NextRequest {
  const headers = new Headers();
  if (userHeader !== undefined) headers.set("x-swarm-user", userHeader);
  return new NextRequest("http://localhost/api/runtime/llm/placeholder/v1/messages", { headers });
}

test.before(() => {
  process.env.SWARM_SESSION_SECRET = "llm-shared-secret";
});

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
  clearRevokedRunTokens();
  resetLlmRateLimit();
});

test("authLlmCall accepts a valid token for the user's active run", () => {
  const manager = makeManager();
  const started = manager.start(USER, { prompt: "hi" });
  assert.ok(started.accepted);
  setRuntimeManagerForTesting(manager);
  const token = signRunToken(USER, started.runId, { env: ENV });
  const caller = authLlmCall(tokenReq(token), token);
  assert.ok(!(caller instanceof Response));
  assert.equal(caller.owner, USER);
  assert.equal(caller.runId, started.runId);
});

test("authLlmCall rejects a missing token", () => {
  const manager = makeManager();
  manager.start(USER, { prompt: "hi" });
  setRuntimeManagerForTesting(manager);
  const res = authLlmCall(tokenReq(""), "");
  assert.ok(res instanceof Response);
  assert.equal(res.status, 401);
});

test("authLlmCall rejects a token for the wrong user", () => {
  const manager = makeManager();
  const started = manager.start(USER, { prompt: "hi" });
  setRuntimeManagerForTesting(manager);
  const token = signRunToken("someone-else", started.runId, { env: ENV });
  // No session header: the run-activity check rejects it (not this user's run).
  const res = authLlmCall(tokenReq(token), token);
  assert.ok(res instanceof Response);
  assert.equal(res.status, 401);
  // With a session header for a different user, the mismatch is caught directly.
  const headerUser = signRunToken(USER, started.runId, { env: ENV });
  const mismatch = authLlmCall(tokenReq(headerUser, "other-user"), headerUser);
  assert.ok(mismatch instanceof Response);
  assert.equal(mismatch.status, 401);
});

test("authLlmCall rejects a token for the wrong run (not active)", () => {
  const manager = makeManager();
  const started = manager.start(USER, { prompt: "hi" });
  setRuntimeManagerForTesting(manager);
  const token = signRunToken(USER, "run_never_started", { env: ENV });
  const res = authLlmCall(tokenReq(token), token);
  assert.ok(res instanceof Response);
  assert.equal(res.status, 401);
  assert.ok(started.accepted);
});

test("authLlmCall rejects an expired token", () => {
  const manager = makeManager();
  const started = manager.start(USER, { prompt: "hi" });
  setRuntimeManagerForTesting(manager);
  // Mint at 61s in the past with a 60s TTL: expired by the time auth runs.
  const expired = signRunToken(USER, started.runId, {
    env: ENV,
    now: Math.floor(Date.now() / 1000) - 61,
    ttlSec: 60,
  });
  const res = authLlmCall(tokenReq(expired, USER), expired);
  assert.ok(res instanceof Response);
  assert.equal(res.status, 401);
});

test("authLlmCall rejects a revoked token", () => {
  const manager = makeManager();
  const started = manager.start(USER, { prompt: "hi" });
  setRuntimeManagerForTesting(manager);
  revokeRunToken(started.runId);
  const token = signRunToken(USER, started.runId, { env: ENV });
  const res = authLlmCall(tokenReq(token, USER), token);
  assert.ok(res instanceof Response);
  assert.equal(res.status, 401);
});

test("authLlmCall rejects a run that has since finalized", async () => {
  const manager = makeManager();
  const started = manager.start(USER, { prompt: "hi" });
  setRuntimeManagerForTesting(manager);
  // Finalize the run like a finish/cancel would: it is no longer active and
  // its token is revoked, so a still-unexpired token must be rejected.
  manager.cancel(USER, started.runId);
  const token = signRunToken(USER, started.runId, { env: ENV });
  const res = authLlmCall(tokenReq(token, USER), token);
  assert.ok(res instanceof Response);
  assert.equal(res.status, 401);
});
