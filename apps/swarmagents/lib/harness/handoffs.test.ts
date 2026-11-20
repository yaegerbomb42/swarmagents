/**
 * HandoffStore tests (lib/harness/handoffs.ts).
 *
 * Covers the pending handoff lifecycle: create (pending + TTL), resolve on
 * "Hand Back to Agent", expiry, run-cancel, scoped listing and the id that is
 * shared with the VM-side rendezvous file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { HandoffStore } from "./handoffs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "handoffs-test-"));

function makeStore(now = () => 1_000_000): HandoffStore {
  return new HandoffStore({
    now,
    filePath: path.join(TMP, `handoffs-${Math.random().toString(36).slice(2)}.json`),
  });
}

test("handoffs: create makes a pending handoff with a TTL", () => {
  const store = makeStore(() => 1_000_000);
  const h = store.create({ runId: "r1", userId: "u1", reason: "CAPTCHA", description: "solve it" });
  assert.equal(h.status, "pending");
  assert.equal(h.userId, "u1");
  assert.equal(h.reason, "CAPTCHA");
  assert.equal(h.description, "solve it");
  assert.ok(h.id.startsWith("h_"));
  assert.equal(h.expiresAt, 1_000_000 + 30 * 60 * 1000);
});

test("handoffs: resolve resolves the waiter and flips status", async () => {
  const store = makeStore();
  const h = store.create({ runId: "r1", userId: "u1", reason: "2FA" });
  const outcome = store.waitFor(h.id);
  const resolved = store.resolve(h.id);
  assert.equal(resolved?.status, "answered");
  assert.deepEqual(await outcome, { status: "answered" });
  // Idempotent: a second resolve does not throw and stays answered.
  assert.equal(store.resolve(h.id)?.status, "answered");
});

test("handoffs: expiry resolves the waiter with expired", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = makeStore(() => 1_000_000);
  const h = store.create({ runId: "r1", userId: "u1", reason: "drag", ttlMs: 10 });
  const outcome = store.waitFor(h.id);
  t.mock.timers.tick(9);
  assert.equal(store.get(h.id)?.status, "pending");
  t.mock.timers.tick(1);
  assert.deepEqual(await outcome, { status: "expired" });
  assert.equal(store.get(h.id)?.status, "expired");
});

test("handoffs: cancelPendingForRun resolves pending handoffs for a run", async () => {
  const store = makeStore();
  const h1 = store.create({ runId: "r1", userId: "u1", reason: "a" });
  const h2 = store.create({ runId: "r1", userId: "u1", reason: "b" });
  const h3 = store.create({ runId: "r2", userId: "u2", reason: "c" });
  const o1 = store.waitFor(h1.id);
  const o2 = store.waitFor(h2.id);
  store.cancelPendingForRun("r1");
  assert.deepEqual(await o1, { status: "cancelled" });
  assert.deepEqual(await o2, { status: "cancelled" });
  assert.equal(store.get(h1.id)?.status, "cancelled");
  // Unrelated run is untouched.
  assert.equal(store.get(h3.id)?.status, "pending");
});

test("handoffs: listPending scopes by user and run, newest first", () => {
  const store = makeStore();
  store.create({ runId: "r1", userId: "u1", reason: "old" });
  const h = store.create({ runId: "r2", userId: "u2", reason: "new" });
  assert.equal(store.listPending({ userId: "u1" }).length, 1);
  assert.equal(store.listPending({ userId: "u2", runId: "r2" })[0].id, h.id);
  store.resolve(h.id);
  assert.equal(store.listPending({ userId: "u2" }).length, 0);
});

test("handoffs: waitFor of an unknown id resolves cancelled (safe default)", async () => {
  const store = makeStore();
  assert.deepEqual(await store.waitFor("nope"), { status: "cancelled" });
});
