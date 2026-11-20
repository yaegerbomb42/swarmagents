/**
 * Cache-Control: no-store on sensitive and dynamic endpoints.
 *
 * These routes carry per-user state (gardener, providers), a session cookie
 * (login), live work-in-progress (the swarm board) or a run trigger (ambient
 * hooks). A cached copy is a correctness bug, not a perf trade-off — a browser
 * that revalidates a login response or a proxy that caches a board reply serves
 * one user's state to the next reader. Each endpoint is asserted on its success
 * AND its error branches, because error responses leak shape too.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as LOGIN } from "./login/route";
import { POST as BOARD } from "./mcp/swarm-board/route";
import { POST as HOOK } from "./hooks/[userId]/[id]/route";
import { GET as GARDENER_GET, POST as GARDENER_POST } from "./gardener/route";
import { GET as PROVIDERS_GET, POST as PROVIDERS_POST } from "./providers/route";
import { GET as PROVIDER_GET } from "./providers/[id]/route";
import { configureStorePaths } from "../..//lib/board/store";
import { configureAmbientStore } from "../../lib/ambient/store";
import { setAmbientEngineForTesting } from "../../lib/ambient/runtime";
import { configureGardenerDir } from "../../lib/gardener/store";
import { configureProviderStorePaths } from "../../lib/providers/store";
import { configureUserPaths, signupLocalUser } from "../../lib/users";
import type { AmbientEngine } from "../../lib/ambient/engine";

const SESSION_SECRET = "no-store-test-session-secret-0123456789";
let dir = "";

function assertNoStore(res: Response, label: string): void {
  assert.equal(
    (res.headers.get("cache-control") ?? "").toLowerCase(),
    "no-store",
    `${label} must send Cache-Control: no-store (got ${res.headers.get("cache-control")})`,
  );
}

function jsonRequest(url: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-no-store-"));
  configureStorePaths(dir, path.join(dir, "swarm_board.json"));
  configureAmbientStore(path.join(dir, "ambient"));
  configureGardenerDir(dir);
  configureProviderStorePaths(path.join(dir, "providers.json"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = SESSION_SECRET;
});

test.afterEach(() => {
  setAmbientEngineForTesting(null);
  configureStorePaths(tmpdirUnused(), path.join(tmpdirUnused(), "swarm_board.json"));
  configureProviderStorePaths("");
  configureGardenerDir(null);
  configureUserPaths("");
  delete process.env.SWARM_SESSION_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdirUnused(): string {
  return path.join(os.tmpdir(), "swarm-no-store-reset");
}

test("POST /api/login is uncacheable on success and on every error", async () => {
  // 500: no session secret configured.
  const savedSecret = process.env.SWARM_SESSION_SECRET;
  delete process.env.SWARM_SESSION_SECRET;
  const unconfigured = await LOGIN(jsonRequest("http://localhost/api/login", { email: "a@b.c", password: "x" }));
  assert.equal(unconfigured.status, 500);
  assertNoStore(unconfigured, "login 500");
  process.env.SWARM_SESSION_SECRET = savedSecret;

  const badBody = await LOGIN(jsonRequest("http://localhost/api/login", "{not json"));
  assert.equal(badBody.status, 400);
  assertNoStore(badBody, "login 400");

  await signupLocalUser("alice@example.com", "correct horse battery staple");
  const wrongPassword = await LOGIN(
    jsonRequest("http://localhost/api/login", { email: "alice@example.com", password: "nope" }),
  );
  assert.equal(wrongPassword.status, 401);
  assertNoStore(wrongPassword, "login 401");

  // Success sets Set-Cookie, which is the strongest reason not to cache it.
  const ok = await LOGIN(
    jsonRequest("http://localhost/api/login", {
      email: "alice@example.com",
      password: "correct horse battery staple",
    }),
  );
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get("set-cookie"), "expected the session cookie");
  assertNoStore(ok, "login 200");
});

test("POST /api/mcp/swarm-board is uncacheable on success and on a JSON-RPC error", async () => {
  const init = await BOARD(
    jsonRequest("http://localhost/api/mcp/swarm-board", { jsonrpc: "2.0", id: 1, method: "initialize" }),
  );
  assert.equal(init.status, 200);
  assertNoStore(init, "board initialize");

  const malformed = await BOARD(jsonRequest("http://localhost/api/mcp/swarm-board", "{oops"));
  assertNoStore(malformed, "board parse error");

  const unknown = await BOARD(
    jsonRequest("http://localhost/api/mcp/swarm-board", { jsonrpc: "2.0", id: 2, method: "nope/nothing" }),
  );
  assertNoStore(unknown, "board method-not-found error");
});

test("POST /api/hooks/[userId]/[id] is uncacheable on fire and on refusal", async () => {
  setAmbientEngineForTesting({
    acceptWebhook: async () => ({ fired: true, runId: "run_hook_1", queued: false }),
  } as unknown as AmbientEngine);

  const fired = await HOOK(
    new NextRequest("http://localhost/api/hooks/local/rule_1", {
      method: "POST",
      headers: { "x-swarm-hook-secret": "sekret", "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ userId: "local", id: "rule_1" }) },
  );
  assert.equal(fired.status, 200);
  assertNoStore(fired, "hook fired");

  setAmbientEngineForTesting({
    acceptWebhook: async () => ({ fired: false, error: "unauthorized" }),
  } as unknown as AmbientEngine);
  const denied = await HOOK(
    new NextRequest("http://localhost/api/hooks/local/rule_1", {
      method: "POST",
      headers: { "x-swarm-hook-secret": "wrong", "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ userId: "local", id: "rule_1" }) },
  );
  assert.equal(denied.status, 401);
  assertNoStore(denied, "hook 401");

  setAmbientEngineForTesting({
    acceptWebhook: async () => ({ fired: false, error: "not found" }),
  } as unknown as AmbientEngine);
  const missing = await HOOK(
    new NextRequest("http://localhost/api/hooks/local/rule_1", {
      method: "POST",
      headers: { "x-swarm-hook-secret": "sekret", "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ userId: "local", id: "rule_1" }) },
  );
  assert.equal(missing.status, 404);
  assertNoStore(missing, "hook 404");
});

test("the gardener is uncacheable on read, on a mutation and on a rejected action", async () => {
  const read = await GARDENER_GET(new NextRequest("http://localhost/api/gardener"));
  assert.equal(read.status, 200);
  assertNoStore(read, "gardener GET");

  const pinned = await GARDENER_POST(jsonRequest("http://localhost/api/gardener", { action: "pin", repoRoot: "/workspace/demo" }));
  assert.equal(pinned.status, 200);
  assertNoStore(pinned, "gardener pin");

  const rejected = await GARDENER_POST(jsonRequest("http://localhost/api/gardener", { action: "definitely-not-an-action" }));
  assert.equal(rejected.status, 400);
  assertNoStore(rejected, "gardener unknown action");
});

test("the provider routes are uncacheable on read, on create and on validation errors", async () => {
  const list = await PROVIDERS_GET(new NextRequest("http://localhost/api/providers"));
  assert.equal(list.status, 200);
  assertNoStore(list, "providers GET");

  const created = await PROVIDERS_POST(
    jsonRequest("http://localhost/api/providers", { id: "openai", apiKey: "sk-test-not-a-real-key" }),
  );
  assert.equal(created.status, 201);
  assertNoStore(created, "providers POST 201");

  const badBody = await PROVIDERS_POST(jsonRequest("http://localhost/api/providers", "{oops"));
  assert.equal(badBody.status, 400);
  assertNoStore(badBody, "providers POST 400");

  const notFound = await PROVIDER_GET(new NextRequest("http://localhost/api/providers/does-not-exist"), {
    params: Promise.resolve({ id: "does-not-exist" }),
  });
  assert.equal(notFound.status, 404);
  assertNoStore(notFound, "providers/[id] 404");
});
