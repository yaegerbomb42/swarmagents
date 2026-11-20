/**
 * Cross-account isolation for every provider route: a user can only list,
 * read, mutate, delete, test and route through their own providers, and no
 * response carries more than a last-4 mask of a key.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET as LIST, PATCH as PATCH_COLLECTION, POST as SAVE } from "./route";
import { DELETE, GET as GET_ONE, PATCH } from "./[id]/route";
import { POST as TEST } from "./[id]/test/route";
import { POST as COMPLETE } from "./complete/route";
import { GET as HEALTH } from "./health/route";
import { GET as APP_HEALTH } from "../health/route";
import { configureProviderStorePaths, readConfiguredProviders } from "../../../lib/providers/store";

const ALICE = "local_alice@example.com";
const BOB = "local_bob@example.com";
const ALICE_KEY = "sk-alice-route-secret-a1b2";
const HOST_KEY = "sk-host-shared-anthropic-zzzz";

let tempDir: string;
const originalFetch = globalThis.fetch;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-provider-isolation-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SWARM_SERVER_MODE;
  delete process.env.SWARM_KEYS_ANTHROPIC;
  configureProviderStorePaths("");
  rmSync(tempDir, { recursive: true, force: true });
});

function as(user: string | null, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (user) headers.set("x-swarm-user", user);
  return new Request(`http://localhost${url}`, { ...init, headers });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function saveAs(user: string, body: unknown): Promise<Response> {
  return SAVE(as(user, "/api/providers", { method: "POST", body: JSON.stringify(body) }));
}

test("a provider saved by Alice is invisible to Bob in the list and catalog", async () => {
  assert.equal((await saveAs(ALICE, { id: "groq", apiKey: ALICE_KEY })).status, 201);

  const aliceText = await LIST(as(ALICE, "/api/providers")).text();
  assert.equal(aliceText.includes(ALICE_KEY), false, "list leaked a full key");
  const alice = JSON.parse(aliceText) as { providers: Array<{ id: string; keySlots: unknown }>; catalog: Array<{ id: string; connected: boolean }> };
  assert.deepEqual(alice.providers.find((p) => p.id === "groq")?.keySlots, [{ index: 0, mask: "••••a1b2" }]);
  assert.equal(alice.catalog.find((e) => e.id === "groq")?.connected, true);

  const bob = (await LIST(as(BOB, "/api/providers")).json()) as { providers: Array<{ id: string }>; catalog: Array<{ id: string; connected: boolean }> };
  assert.equal(bob.providers.some((p) => p.id === "groq"), false);
  assert.equal(bob.catalog.find((e) => e.id === "groq")?.connected, false);
});

test("Bob cannot read, rotate, add to, delete or test Alice's provider", async () => {
  await saveAs(ALICE, { id: "groq", apiKey: ALICE_KEY });

  assert.equal((await GET_ONE(as(BOB, "/api/providers/groq"), ctx("groq"))).status, 404);
  const rotate = await PATCH(
    as(BOB, "/api/providers/groq", { method: "PATCH", body: JSON.stringify({ action: "rotate-key", index: 0, apiKey: "sk-bob-evil" }) }),
    ctx("groq")
  );
  assert.equal(rotate.status, 404);
  const add = await PATCH_COLLECTION(
    as(BOB, "/api/providers", { method: "PATCH", body: JSON.stringify({ id: "groq", action: "add-key", apiKey: "sk-bob-evil" }) })
  );
  assert.equal(add.status, 404);
  assert.equal((await DELETE(as(BOB, "/api/providers/groq", { method: "DELETE" }), ctx("groq"))).status, 404);
  assert.equal((await TEST(as(BOB, "/api/providers/groq/test", { method: "POST" }), ctx("groq"))).status, 404);

  // Alice's provider is untouched.
  assert.deepEqual(readConfiguredProviders(ALICE)[0].keys, [ALICE_KEY]);
});

test("server mode refuses provider routes without a signed-in user", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  assert.equal(LIST(as(null, "/api/providers")).status, 401);
  assert.equal((await SAVE(as(null, "/api/providers", { method: "POST", body: JSON.stringify({ id: "groq", apiKey: "sk-x-123456" }) }))).status, 401);
  assert.equal((await GET_ONE(as(null, "/api/providers/groq"), ctx("groq"))).status, 401);
  assert.equal((await DELETE(as(null, "/api/providers/groq", { method: "DELETE" }), ctx("groq"))).status, 401);
  assert.equal((await TEST(as(null, "/api/providers/groq/test", { method: "POST" }), ctx("groq"))).status, 401);
  assert.equal((await HEALTH(as(null, "/api/providers/health"))).status, 401);
});

function anthropicOk(text: string): Response {
  return new Response(
    JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 }, model: "m" }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function complete(user: string): Promise<Response> {
  return COMPLETE(
    new NextRequest("http://localhost/api/providers/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-swarm-user": user },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
  );
}

test("/api/providers/complete routes only through the caller's keys; server mode never uses host keys", async () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_KEYS_ANTHROPIC = HOST_KEY;
  const seenKeys: string[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenKeys.push(headers.get("x-api-key") ?? headers.get("authorization") ?? "");
    return anthropicOk("ok");
  }) as typeof fetch;

  // Bob has no providers: the host key must not be used.
  const bobRes = await complete(BOB);
  assert.notEqual(bobRes.status, 200);
  assert.equal(seenKeys.some((k) => k.includes(HOST_KEY)), false, "host key was used for an account");
  assert.equal((await bobRes.text()).includes(HOST_KEY), false);

  // Alice saved her own Anthropic key: it (and only it) is used.
  await saveAs(ALICE, { id: "anthropic", apiKey: ALICE_KEY });
  const aliceRes = await complete(ALICE);
  assert.equal(aliceRes.status, 200);
  assert.ok(seenKeys.some((k) => k.includes(ALICE_KEY)));
  assert.equal(seenKeys.some((k) => k.includes(HOST_KEY)), false);
  assert.equal((await aliceRes.text()).includes(ALICE_KEY), false);

  // And Bob still cannot reach Alice's key.
  seenKeys.length = 0;
  await complete(BOB);
  assert.equal(seenKeys.some((k) => k.includes(ALICE_KEY)), false);
});

test("/api/health counts the signed-in user's providers and says so", async () => {
  await saveAs(ALICE, { id: "groq", apiKey: ALICE_KEY });
  const healthReq = (user: string | null) => {
    const headers = new Headers();
    if (user) headers.set("x-swarm-user", user);
    return new NextRequest("http://localhost/api/health", { headers });
  };
  const alice = (await (await APP_HEALTH(healthReq(ALICE))).json()) as { providersConfigured: number; providersScope: string };
  assert.equal(alice.providersConfigured, 1);
  assert.equal(alice.providersScope, "user");
  const bob = (await (await APP_HEALTH(healthReq(BOB))).json()) as { providersConfigured: number; providersScope: string };
  assert.equal(bob.providersConfigured, 0);
  assert.equal(bob.providersScope, "user");
  const anon = (await (await APP_HEALTH(healthReq(null))).json()) as { providersScope: string };
  assert.equal(anon.providersScope, "host-env");
});
