/**
 * Unit tests for the in-memory approval store (lib/harness/approvals.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore, type PendingApproval } from "./approvals";

const base = { runId: "run_1", userId: "alice", toolName: "Bash", action: "rm -rf /", reason: "destructive root deletion requires approval" };

test("create returns a pending approval with id, expiry and metadata", () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const a = store.create(base);
  assert.match(a.id, /^appr_/);
  assert.equal(a.status, "pending");
  assert.equal(a.userId, "alice");
  assert.equal(a.toolName, "Bash");
  assert.ok(a.createdAt <= a.expiresAt);
  assert.equal(store.get(a.id), a);
});

test("waitFor resolves approved when the approval is resolved", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const a = store.create(base);
  const verdict = store.waitFor(a.id);
  const resolved = store.resolve(a.id, "approved");
  assert.equal(resolved?.status, "approved");
  assert.equal(await verdict, "approved");
});

test("waitFor resolves denied when the approval is denied", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const a = store.create(base);
  const verdict = store.waitFor(a.id);
  store.resolve(a.id, "denied");
  assert.equal(await verdict, "denied");
});

test("waitFor resolves expired after the TTL when undecided", async () => {
  const store = new ApprovalStore({ ttlMs: 20 });
  const a = store.create(base);
  const verdict = store.waitFor(a.id);
  // The store's expiry timer is unref'd (the live run keeps the loop busy in
  // production); hold the loop open here so the timer can fire.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal(await verdict, "expired");
    assert.equal(store.get(a.id)?.status, "expired");
  } finally {
    clearInterval(keepAlive);
  }
});

test("resolve is idempotent: first verdict wins", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const a = store.create(base);
  const resolved = store.resolve(a.id, "approved");
  assert.equal(resolved?.status, "approved");
  const second = store.resolve(a.id, "denied");
  assert.equal(second?.status, "approved"); // unchanged
});

test("resolve unknown id returns undefined", () => {
  const store = new ApprovalStore();
  assert.equal(store.resolve("appr_nope", "approved"), undefined);
  assert.equal(store.get("appr_nope"), undefined);
});

test("auto-expires after the TTL with fake timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new ApprovalStore({ ttlMs: 300_000 });
  const a = store.create(base);
  const verdict = store.waitFor(a.id);

  t.mock.timers.tick(299_999);
  assert.equal(store.get(a.id)?.status, "pending");

  t.mock.timers.tick(1);
  assert.equal(store.get(a.id)?.status, "expired");
  assert.equal(store.get(a.id)?.timedOut, true);
  assert.equal(await verdict, "expired");
});

test("onTimeout fires exactly once on auto-expiry, not on a manual decision", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fired: PendingApproval[] = [];
  const store = new ApprovalStore({ ttlMs: 1000, onTimeout: (a) => fired.push(a) });

  const manual = store.create(base);
  store.resolve(manual.id, "denied");
  t.mock.timers.tick(1000);
  assert.equal(fired.length, 0);
  assert.equal(store.get(manual.id)?.timedOut, undefined);

  const timedOut = store.create(base);
  t.mock.timers.tick(1000);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, timedOut.id);
  assert.equal(fired[0].timedOut, true);
});

test("per-create onTimeout overrides the store-level hook", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  const store = new ApprovalStore({ ttlMs: 1000, onTimeout: () => calls.push("store") });
  store.create({ ...base, onTimeout: (a) => calls.push(`create:${a.id}`) });
  t.mock.timers.tick(1000);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^create:appr_/);
});

test("default TTL is 300s and can be overridden by SWARM_APPROVAL_TIMEOUT_SEC", () => {
  const prevSec = process.env.SWARM_APPROVAL_TIMEOUT_SEC;
  const prevMs = process.env.SWARM_APPROVAL_TIMEOUT_MS;
  try {
    delete process.env.SWARM_APPROVAL_TIMEOUT_SEC;
    delete process.env.SWARM_APPROVAL_TIMEOUT_MS;
    const byDefault = new ApprovalStore();
    const a = byDefault.create(base);
    assert.equal(a.expiresAt - a.createdAt, 300_000);

    process.env.SWARM_APPROVAL_TIMEOUT_SEC = "7";
    const fromEnv = new ApprovalStore();
    const b = fromEnv.create(base);
    assert.equal(b.expiresAt - b.createdAt, 7000);
    byDefault.clear();
    fromEnv.clear();
  } finally {
    if (prevSec === undefined) delete process.env.SWARM_APPROVAL_TIMEOUT_SEC;
    else process.env.SWARM_APPROVAL_TIMEOUT_SEC = prevSec;
    if (prevMs === undefined) delete process.env.SWARM_APPROVAL_TIMEOUT_MS;
    else process.env.SWARM_APPROVAL_TIMEOUT_MS = prevMs;
  }
});

test("expirePendingForRun settles all pending approvals for a run", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const a = store.create(base);
  const b = store.create({ ...base, runId: "run_2" });
  const va = store.waitFor(a.id);
  const vb = store.waitFor(b.id);
  store.expirePendingForRun("run_1");
  assert.equal(await va, "expired");
  assert.equal(store.get(a.id)?.status, "expired");
  // Other run untouched.
  assert.equal(store.get(b.id)?.status, "pending");
  store.resolve(b.id, "approved");
  assert.equal(await vb, "approved");
});
