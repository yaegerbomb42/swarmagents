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
import { POST as PROVIDER_TEST_POST } from "./providers/[id]/test/route";
import { POST as COMPLETE_POST } from "./providers/complete/route";
import { GET as PROJECTS_GET, POST as PROJECTS_POST } from "./projects/route";
import {
  DELETE as PROJECT_DELETE,
  GET as PROJECT_GET,
  PATCH as PROJECT_PATCH,
} from "./projects/[id]/route";
import { DELETE as SHARE_DELETE, POST as SHARE_POST } from "./projects/[id]/share/route";
import { DELETE as PAIR_DELETE, GET as PAIR_GET, POST as PAIR_POST } from "./byoc/pair/route";
import { POST as LENSES_POST } from "./lenses/route";
import { ByocTokenStore, setByocTokenStoreForTesting } from "../../lib/byoc/tokens";
import { configureProjectStoreDir } from "../../lib/projects/store";
import { configureStorePaths } from "../..//lib/board/store";
import { configureAmbientStore } from "../../lib/ambient/store";
import { setAmbientEngineForTesting } from "../../lib/ambient/runtime";
import { configureGardenerDir } from "../../lib/gardener/store";
import { configureProviderStorePaths, saveProvider } from "../../lib/providers/store";
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

interface UserRequestInit {
  method?: string;
  body?: unknown;
  user?: string | null;
}

/** A caller-scoped request: the middleware sets x-swarm-user for signed-in users. */
function userRequest(url: string, init: UserRequestInit = {}): NextRequest {
  const headers = new Headers();
  const user = init.user === undefined ? "alice" : init.user;
  if (user !== null) headers.set("x-swarm-user", user);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    ...(init.body !== undefined
      ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }
      : {}),
    headers,
  });
}

function projectCtx(id: string) {
  return { params: Promise.resolve({ id }) };
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
  setByocTokenStoreForTesting(null);
  configureProjectStoreDir("");
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
    checkWebhook: () => "ok",
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
    checkWebhook: () => "unauthorized",
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
    checkWebhook: () => "not found",
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
  assert.equal(missing.status, 401);
  assertNoStore(missing, "hook unknown id 401");
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

test("the project routes are uncacheable on success, on auth failures and on missing projects", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-no-store-projects-"));
  configureProjectStoreDir(projectDir);
  try {
    const signedOutList = await PROJECTS_GET(userRequest("/api/projects", { user: null }));
    assert.equal(signedOutList.status, 401);
    assertNoStore(signedOutList, "projects GET 401");

    const created = await PROJECTS_POST(
      userRequest("/api/projects", { method: "POST", body: { name: "Atlas", activeBranch: "main" } }),
    );
    assert.equal(created.status, 201);
    assertNoStore(created, "projects POST 201");
    const { project } = (await created.json()) as { project: { id: string } };

    const list = await PROJECTS_GET(userRequest("/api/projects"));
    assert.equal(list.status, 200);
    assertNoStore(list, "projects GET 200");

    const one = await PROJECT_GET(userRequest(`/api/projects/${project.id}`), projectCtx(project.id));
    assert.equal(one.status, 200);
    assertNoStore(one, "projects/[id] GET 200");

    const patched = await PROJECT_PATCH(
      userRequest(`/api/projects/${project.id}`, { method: "PATCH", body: { activeBranch: "feat/x" } }),
      projectCtx(project.id),
    );
    assert.equal(patched.status, 200);
    assertNoStore(patched, "projects/[id] PATCH 200");

    // Another account gets a 404, which must not be cached either.
    const other = await PROJECT_GET(
      userRequest(`/api/projects/${project.id}`, { user: "bob" }),
      projectCtx(project.id),
    );
    assert.equal(other.status, 404);
    assertNoStore(other, "projects/[id] 404");

    // The share token is a live credential: neither the create nor the
    // revoke response may be cached.
    const shared = await SHARE_POST(
      userRequest(`/api/projects/${project.id}/share`, { method: "POST" }),
      projectCtx(project.id),
    );
    assert.equal(shared.status, 200);
    assertNoStore(shared, "projects/[id]/share POST 200");

    const revoked = await SHARE_DELETE(
      userRequest(`/api/projects/${project.id}/share`, { method: "DELETE" }),
      projectCtx(project.id),
    );
    assert.equal(revoked.status, 200);
    assertNoStore(revoked, "projects/[id]/share DELETE 200");

    const missingShare = await SHARE_POST(
      userRequest("/api/projects/prj_nope/share", { method: "POST" }),
      projectCtx("prj_nope"),
    );
    assert.equal(missingShare.status, 404);
    assertNoStore(missingShare, "projects/[id]/share POST 404");

    const deleted = await PROJECT_DELETE(
      userRequest(`/api/projects/${project.id}`, { method: "DELETE" }),
      projectCtx(project.id),
    );
    assert.equal(deleted.status, 200);
    assertNoStore(deleted, "projects/[id] DELETE 200");
  } finally {
    configureProjectStoreDir("");
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("the BYOC pair route is uncacheable on success and on refusals", async () => {
  const pairDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-no-store-pair-"));
  setByocTokenStoreForTesting(new ByocTokenStore({ file: path.join(pairDir, "byoc.json") }));
  try {
    const signedOutCreate = await PAIR_POST(userRequest("/api/byoc/pair", { method: "POST", user: null }));
    assert.equal(signedOutCreate.status, 401);
    assertNoStore(signedOutCreate, "byoc/pair POST 401");

    // A fresh pairing code is a one-time credential: never cache it.
    const created = await PAIR_POST(userRequest("/api/byoc/pair", { method: "POST", body: {} }));
    assert.equal(created.status, 201);
    assertNoStore(created, "byoc/pair POST 201");

    const list = await PAIR_GET(userRequest("/api/byoc/pair"));
    assert.equal(list.status, 200);
    assertNoStore(list, "byoc/pair GET 200");

    const badDevice = await PAIR_DELETE(
      userRequest("/api/byoc/pair?deviceId=../etc", { method: "DELETE" }),
    );
    assert.equal(badDevice.status, 400);
    assertNoStore(badDevice, "byoc/pair DELETE 400");

    const missingDevice = await PAIR_DELETE(
      userRequest("/api/byoc/pair?deviceId=dev_missing", { method: "DELETE" }),
    );
    assert.equal(missingDevice.status, 404);
    assertNoStore(missingDevice, "byoc/pair DELETE 404");
  } finally {
    setByocTokenStoreForTesting(null);
    fs.rmSync(pairDir, { recursive: true, force: true });
  }
});

test("the lens route is uncacheable on an auth failure and on a validation error", async () => {
  const signedOut = await LENSES_POST(
    userRequest("/api/lenses", { method: "POST", body: { lens: "eli5", message: "hi" }, user: null }),
  );
  assert.equal(signedOut.status, 401);
  assertNoStore(signedOut, "lenses POST 401");

  const unknownLens = await LENSES_POST(
    userRequest("/api/lenses", { method: "POST", body: { lens: "nope", message: "hi" } }),
  );
  assert.equal(unknownLens.status, 400);
  assertNoStore(unknownLens, "lenses POST 400");
});

test("gardener unpin and removeProposal are uncacheable, including their errors", async () => {
  // Both branches below used to bypass the file's json() helper, so they are
  // asserted directly rather than trusting the shared wrapper.
  const missingProposal = await GARDENER_POST(
    jsonRequest("http://localhost/api/gardener", { action: "removeProposal" }),
  );
  assert.equal(missingProposal.status, 400);
  assertNoStore(missingProposal, "gardener removeProposal 400");

  const unknownProposal = await GARDENER_POST(
    jsonRequest("http://localhost/api/gardener", { action: "removeProposal", proposalId: "prop_missing" }),
  );
  assert.equal(unknownProposal.status, 404);
  assertNoStore(unknownProposal, "gardener removeProposal 404");

  const unpinned = await GARDENER_POST(
    jsonRequest("http://localhost/api/gardener", { action: "unpin", repoRoot: "/workspace/not-pinned" }),
  );
  assert.equal(unpinned.status, 404);
  assertNoStore(unpinned, "gardener unpin 404");

  const badPath = await GARDENER_POST(
    jsonRequest("http://localhost/api/gardener", { action: "unpin", repoRoot: "/workspace/../etc" }),
  );
  assert.equal(badPath.status, 400);
  assertNoStore(badPath, "gardener unpin 400");
});

test("the provider completion route is uncacheable on success and on every error", async () => {
  const signedOut = await COMPLETE_POST(
    userRequest("/api/providers/complete", {
      method: "POST",
      body: { messages: [{ role: "user", content: "hi" }] },
      user: null,
    }),
  );
  assert.equal(signedOut.status, 401);
  assertNoStore(signedOut, "complete 401");

  const badJson = await COMPLETE_POST(
    userRequest("/api/providers/complete", { method: "POST", body: "{oops" }),
  );
  assert.equal(badJson.status, 400);
  assertNoStore(badJson, "complete 400 invalid JSON");

  const badBody = await COMPLETE_POST(
    userRequest("/api/providers/complete", { method: "POST", body: {} }),
  );
  assert.equal(badBody.status, 400);
  assertNoStore(badBody, "complete 400 validation");

  const tooLarge = await COMPLETE_POST(
    userRequest("/api/providers/complete", {
      method: "POST",
      body: { messages: [{ role: "user", content: "x".repeat(300_000) }] },
    }),
  );
  assert.equal(tooLarge.status, 413);
  assertNoStore(tooLarge, "complete 413");

  // Success and provider failure need the local operator's host keys.
  const savedKey = process.env.SWARM_KEYS_ANTHROPIC;
  process.env.SWARM_KEYS_ANTHROPIC = "sk-test-no-store-anthropic";
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hello back" }],
          usage: { input_tokens: 3, output_tokens: 4 },
          model: "claude-sonnet-4-5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const ok = await COMPLETE_POST(
      userRequest("/api/providers/complete", {
        method: "POST",
        body: { messages: [{ role: "user", content: "hi" }] },
        user: "local",
      }),
    );
    assert.equal(ok.status, 200);
    assertNoStore(ok, "complete 200");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "upstream boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const failed = await COMPLETE_POST(
      userRequest("/api/providers/complete", {
        method: "POST",
        body: { messages: [{ role: "user", content: "hi" }] },
        user: "local",
      }),
    );
    assert.equal(failed.status, 502);
    assertNoStore(failed, "complete 502");
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.SWARM_KEYS_ANTHROPIC;
    else process.env.SWARM_KEYS_ANTHROPIC = savedKey;
  }

  // A disconnected client aborts the completion: 499, still uncacheable.
  const controller = new AbortController();
  controller.abort();
  const aborted = await COMPLETE_POST(
    new NextRequest("http://localhost/api/providers/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-user": "local" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    }),
  );
  assert.equal(aborted.status, 499);
  assertNoStore(aborted, "complete 499");
});

test("the provider test route is uncacheable on success and on a missing provider", async () => {
  saveProvider("alice", { id: "openai", apiKey: "sk-test-no-store-probe" });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "pong" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: "fast",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const ok = await PROVIDER_TEST_POST(userRequest("/api/providers/openai/test", { method: "POST" }), {
      params: Promise.resolve({ id: "openai" }),
    });
    assert.equal(ok.status, 200);
    assertNoStore(ok, "providers/[id]/test 200");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const missing = await PROVIDER_TEST_POST(userRequest("/api/providers/nope/test", { method: "POST" }), {
    params: Promise.resolve({ id: "nope" }),
  });
  assert.equal(missing.status, 404);
  assertNoStore(missing, "providers/[id]/test 404");
});
