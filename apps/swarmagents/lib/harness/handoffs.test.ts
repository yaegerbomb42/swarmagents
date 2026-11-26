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

test("handoffs: waitFor after settle still reports the outcome", async () => {
  const store = makeStore();
  const h = store.create({ runId: "r1", userId: "u1", reason: "2FA" });
  const outcome = store.waitFor(h.id);
  store.resolve(h.id);
  assert.deepEqual(await outcome, { status: "answered" });
  // The waiter was deleted on settle; a late waitFor falls back to the
  // stored status instead of the "cancelled" default.
  assert.deepEqual(await store.waitFor(h.id), { status: "answered" });
});

test("handoffs: a restored pending handoff has a waiter and can still be resolved", async () => {
  const file = path.join(TMP, `handoffs-restore-${Math.random().toString(36).slice(2)}.json`);
  let now = 1_000_000;
  const first = new HandoffStore({ now: () => now, filePath: file, ttlMs: 10_000 });
  const h = first.create({ runId: "r1", userId: "u1", reason: "CAPTCHA" });

  now += 4_000;
  const second = new HandoffStore({ now: () => now, filePath: file, ttlMs: 10_000 });
  assert.equal(second.get(h.id)?.status, "pending");
  const outcome = second.waitFor(h.id);
  const raced = await Promise.race([
    outcome.then(() => "settled" as const),
    new Promise((resolve) => setTimeout(() => resolve("pending" as const), 20)),
  ]);
  assert.equal(raced, "pending", "waitFor must not resolve immediately for a live restored handoff");
  second.resolve(h.id);
  assert.deepEqual(await outcome, { status: "answered" });
});

test("handoffs: a restored pending handoff expires when its remaining TTL elapses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const file = path.join(TMP, `handoffs-restore-ttl-${Math.random().toString(36).slice(2)}.json`);
  let now = 1_000_000;
  const first = new HandoffStore({ now: () => now, filePath: file, ttlMs: 10_000 });
  const h = first.create({ runId: "r1", userId: "u1", reason: "drag" });

  now += 4_000;
  const second = new HandoffStore({ now: () => now, filePath: file, ttlMs: 10_000 });
  assert.equal(second.get(h.id)?.status, "pending");
  const outcome = second.waitFor(h.id);
  t.mock.timers.tick(5_999);
  assert.equal(second.get(h.id)?.status, "pending");
  t.mock.timers.tick(1);
  assert.deepEqual(await outcome, { status: "expired" });
  assert.equal(second.get(h.id)?.status, "expired");
});

test("handoffs: listPending hides a stale pending handoff whose TTL elapsed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000_000;
  const store = makeStore(() => now);
  const h = store.create({ runId: "r1", userId: "u1", reason: "drag", ttlMs: 10 });
  assert.equal(store.listPending().length, 1);
  // The TTL elapsed but the timer has not fired yet.
  now += 100;
  assert.equal(store.listPending().length, 0);
  assert.equal(store.get(h.id)?.status, "pending", "the guard only hides the entry; the timer still expires it");
  t.mock.timers.tick(10);
  assert.equal(store.get(h.id)?.status, "expired");
});

test("handoffs: decided handoffs older than the retention bound are pruned from memory", () => {
  let now = 1_000_000;
  const store = makeStore(() => now);
  const old = store.create({ runId: "r1", userId: "u1", reason: "old" });
  store.resolve(old.id);
  assert.ok(store.get(old.id));

  now += 25 * 60 * 60 * 1000;
  store.create({ runId: "r2", userId: "u2", reason: "new" });
  assert.equal(store.get(old.id), undefined);
});

test("handoffs: create adopts the VM server's handoff id so the resolution reaches the same rendezvous file", () => {
  const store = makeStore();
  const vmId = "h_0c9aa2e0-1111-4222-8333-444455556666";
  const h = store.create({ id: vmId, runId: "r1", userId: "u1", reason: "SSO redirect loop" });
  assert.equal(h.id, vmId, "the VM desktop-handoff server polls <id>.answer.json by this id");
  const resolved = store.resolve(vmId);
  assert.equal(resolved?.status, "answered");
  assert.equal(store.get(vmId)?.status, "answered");
});

test("handoffs: a per-handoff TTL override bounds the wait independently of the default", () => {
  const store = makeStore(() => 2_000_000);
  const short = store.create({ runId: "r1", userId: "u1", reason: "quick", ttlMs: 60_000 });
  assert.equal(short.expiresAt, 2_060_000);
  const long = store.create({ runId: "r1", userId: "u1", reason: "slow" });
  assert.equal(long.expiresAt, 2_000_000 + 30 * 60 * 1000, "no override keeps the 30-minute default");
});
