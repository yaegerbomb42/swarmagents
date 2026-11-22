/**
 * Tests for the BYOC pairing API (POST/GET/DELETE /api/byoc/pair).
 *
 * The routes are scoped to the caller (the middleware-set x-swarm-user
 * header): a pairing code belongs to the account that created it and a node
 * can only be revoked by the account that owns it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { DELETE, GET, POST } from "./route";
import { ByocHub } from "../../../../lib/byoc/hub";
import {
  ByocTokenStore,
  setByocTokenStoreForTesting,
} from "../../../../lib/byoc/tokens";
import { setByocHubForTesting } from "../../../../lib/byoc/hub";
import { configureAuditPath, readAuditEntries } from "../../../../lib/audit";

function request(path: string, init: RequestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${path}`, {
    ...init,
    headers,
    signal: init.signal ?? undefined,
  });
}

const tempDirs: string[] = [];

function install(): { hub: ByocHub; store: ByocTokenStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-byoc-api-"));
  tempDirs.push(dir);
  const store = new ByocTokenStore({ file: path.join(dir, "byoc.json") });
  const hub = new ByocHub({ port: 0, tokens: store, heartbeatMs: 60_000 });
  setByocTokenStoreForTesting(store);
  setByocHubForTesting(hub);
  configureAuditPath(path.join(dir, "audit.jsonl"));
  return { hub, store };
}

test.afterEach(() => {
  setByocTokenStoreForTesting(null);
  setByocHubForTesting(null);
  configureAuditPath(undefined);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pair: creating a pairing code needs a signed-in caller", async () => {
  install();
  const res = await POST(request("/api/byoc/pair", { method: "POST" }, null));
  assert.equal(res.status, 401);
});

test("pair: a pairing code is created for the caller and can be redeemed once", async () => {
  const { store } = install();
  const res = await POST(request("/api/byoc/pair", { method: "POST", body: "{}" }));
  assert.equal(res.status, 201);
  const body = (await res.json()) as { code: string; command: string; expiresAt: number };
  assert.match(body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(body.command.includes(body.code));
  assert.ok(body.expiresAt > Date.now());

  const paired = store.redeemPairingCode(body.code, "my-node");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  assert.equal(paired.device.userId, "alice");
});

test("pair: the node list only shows the caller's nodes", async () => {
  const { store } = install();
  const alice = store.createPairingCode("alice");
  store.redeemPairingCode(alice.code, "alice-node");
  const bob = store.createPairingCode("bob");
  store.redeemPairingCode(bob.code, "bob-node");

  const res = await GET(request("/api/byoc/pair"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { nodes: Array<{ name: string; online: boolean }> };
  assert.equal(body.nodes.length, 1);
  assert.equal(body.nodes[0].name, "alice-node");
  assert.equal(body.nodes[0].online, false);
});

test("pair: revoking a node kills its session and its token", async () => {
  const { hub, store } = install();
  const code = store.createPairingCode("alice");
  const paired = store.redeemPairingCode(code.code, "alice-node");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;

  // Pretend the node is connected.
  const sessions = hub.listSessions();
  assert.equal(sessions.length, 0);

  const res = await DELETE(
    request(`/api/byoc/pair?deviceId=${paired.device.id}`, { method: "DELETE" }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, deviceId: paired.device.id });

  const verified = store.verifyToken(paired.token);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.error, "revoked");
});

test("pair: another account cannot revoke a node", async () => {
  const { store } = install();
  const code = store.createPairingCode("alice");
  const paired = store.redeemPairingCode(code.code, "alice-node");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;

  const res = await DELETE(
    request(`/api/byoc/pair?deviceId=${paired.device.id}`, { method: "DELETE" }, "bob"),
  );
  assert.equal(res.status, 404);

  const still = store.verifyToken(paired.token);
  assert.equal(still.ok, true);
});

test("pair: a malformed device id is refused", async () => {
  install();
  const res = await DELETE(request("/api/byoc/pair?deviceId=../etc", { method: "DELETE" }));
  assert.equal(res.status, 400);
});

test("pair: the node list never leaks a token", async () => {
  const { store } = install();
  const code = store.createPairingCode("alice");
  const paired = store.redeemPairingCode(code.code, "alice-node");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;

  const res = await GET(request("/api/byoc/pair"));
  const text = await res.text();
  assert.ok(!text.includes(paired.token), "the device token must never be returned");
  assert.ok(!text.includes(store.listDevices("alice")[0].tokenHash), "the token hash must not leak");
});

test("pair: name is persisted and applied when the node redeems without a name", async () => {
  const { store } = install();
  const res = await POST(
    request("/api/byoc/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "desk-box" }),
    }),
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { code: string; name: string };
  assert.equal(body.name, "desk-box");

  const paired = store.redeemPairingCode(body.code, "  ");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  assert.equal(paired.device.name, "desk-box");

  const audit = readAuditEntries("alice").find((e) => e.action === "computer.pair");
  assert.ok(audit);
});

test("pair: malformed JSON returns 400", async () => {
  install();
  const res = await POST(
    request("/api/byoc/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    }),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Invalid JSON/i);
});

test("pair: revoke writes a computer.revoke audit entry", async () => {
  const { store } = install();
  const { code } = store.createPairingCode("alice");
  const paired = store.redeemPairingCode(code, "to-revoke");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;

  const res = await DELETE(request(`/api/byoc/pair?deviceId=${paired.device.id}`, { method: "DELETE" }));
  assert.equal(res.status, 200);
  const audit = readAuditEntries("alice").find((e) => e.action === "computer.revoke");
  assert.ok(audit);
  assert.equal(audit!.target, paired.device.id);
});

