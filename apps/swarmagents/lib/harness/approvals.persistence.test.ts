/**
 * Durable approval records: pending approvals survive a new store instance,
 * the TTL is absolute wall clock, and a restart expiry is distinguishable from
 * both a user denial and a TTL timeout.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "./approvals";

function tmpFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-approval-persist-"));
  return { dir, file: path.join(dir, "approvals.json") };
}

test("approvals: a pending approval survives a new store with its remaining TTL", () => {
  const { dir, file } = tmpFile();
  try {
    let now = 1_000_000;
    const first = new ApprovalStore({ persistPath: file, ttlMs: 10_000, now: () => now });
    const created = first.create({
      runId: "run_persist",
      userId: "alice",
      toolName: "Bash",
      action: "npm publish",
      reason: "external side effect",
    });
    assert.equal(created.expiresAt, 1_010_000);

    now += 4_000;
    const second = new ApprovalStore({ persistPath: file, ttlMs: 10_000, now: () => now });
    const restored = second.get(created.id);
    assert.ok(restored);
    assert.equal(restored.status, "pending");
    assert.equal(restored.expiresAt, 1_010_000, "the clock does not pause across a restart");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("approvals: a TTL that elapsed while the process was down loads as expired", () => {
  const { dir, file } = tmpFile();
  try {
    let now = 2_000_000;
    const first = new ApprovalStore({ persistPath: file, ttlMs: 5_000, now: () => now });
    const created = first.create({
      runId: "run_ttl",
      userId: "alice",
      toolName: "Bash",
      action: "curl example.com",
      reason: "network",
    });

    now += 6_000;
    const second = new ApprovalStore({ persistPath: file, ttlMs: 5_000, now: () => now });
    const restored = second.get(created.id);
    assert.ok(restored);
    assert.equal(restored.status, "expired");
    assert.equal(restored.timedOut, true);
    assert.equal(restored.expiredReason, "ttl");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("approvals: restart expiry is explicit, not a denial", () => {
  const { dir, file } = tmpFile();
  try {
    const store = new ApprovalStore({ persistPath: file, ttlMs: 60_000 });
    const created = store.create({
      runId: "run_restart",
      userId: "alice",
      toolName: "Edit",
      action: "rewrite config",
      reason: "write outside workspace",
    });
    store.expireForRunRestart(created.runId);

    const reopened = new ApprovalStore({ persistPath: file, ttlMs: 60_000 });
    const restored = reopened.get(created.id);
    assert.ok(restored);
    assert.equal(restored.status, "expired");
    assert.equal(restored.expiredReason, "server_restart");
    assert.equal(restored.timedOut, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("approvals: a restored pending approval has a waiter and can still be decided", async () => {
  const { dir, file } = tmpFile();
  try {
    let now = 1_000_000;
    const first = new ApprovalStore({ persistPath: file, ttlMs: 10_000, now: () => now });
    const created = first.create({
      runId: "run_waiter",
      userId: "alice",
      toolName: "Bash",
      action: "npm publish",
      reason: "external side effect",
    });

    now += 4_000;
    const second = new ApprovalStore({ persistPath: file, ttlMs: 10_000, now: () => now });
    const verdict = second.waitFor(created.id);
    // Not settled immediately: the approval is still live.
    const raced = await Promise.race([
      verdict.then(() => "settled" as const),
      new Promise((resolve) => setTimeout(() => resolve("pending" as const), 20)),
    ]);
    assert.equal(raced, "pending");
    second.resolve(created.id, "approved");
    assert.equal(await verdict, "approved");
    // A late waitFor still reports the verdict, not "expired".
    assert.equal(await second.waitFor(created.id), "approved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("approvals: a restored pending approval expires when its remaining TTL elapses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { dir, file } = tmpFile();
  try {
    let now = 1_000_000;
    const fired: string[] = [];
    const first = new ApprovalStore({ persistPath: file, ttlMs: 10_000, now: () => now });
    first.create({
      runId: "run_restore_ttl",
      userId: "alice",
      toolName: "Bash",
      action: "curl example.com",
      reason: "network",
    });

    now += 4_000;
    const second = new ApprovalStore({
      persistPath: file,
      ttlMs: 10_000,
      now: () => now,
      onTimeout: (a) => fired.push(a.id),
    });
    const restored = second.listPendingForUser("alice");
    assert.equal(restored.length, 1);
    const verdict = second.waitFor(restored[0].id);
    t.mock.timers.tick(5_999);
    assert.equal(second.get(restored[0].id)?.status, "pending");
    t.mock.timers.tick(1);
    assert.equal(second.get(restored[0].id)?.status, "expired");
    assert.equal(await verdict, "expired");
    assert.equal(fired.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("approvals: a decision after the TTL expires instead of approving", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { dir, file } = tmpFile();
  try {
    let now = 1_000_000;
    const fired: string[] = [];
    const store = new ApprovalStore({
      persistPath: file,
      ttlMs: 1_000,
      now: () => now,
      onTimeout: (a) => fired.push(a.id),
    });
    const created = store.create({
      runId: "run_late",
      userId: "alice",
      toolName: "Bash",
      action: "rm -rf /tmp/x",
      reason: "destructive",
    });
    const verdict = store.waitFor(created.id);
    // The TTL elapsed but the timer has not fired yet.
    now += 2_000;
    const resolved = store.resolve(created.id, "approved");
    assert.equal(resolved?.status, "expired");
    assert.equal(resolved?.timedOut, true);
    assert.equal(resolved?.expiredReason, "ttl");
    assert.equal(await verdict, "expired");
    assert.equal(fired.length, 1, "the timeout hook fires exactly once");
    t.mock.timers.tick(5_000);
    assert.equal(fired.length, 1, "the cleared timer does not fire again");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("approvals: persist leaves no temp files and the snapshot is mode 0o600", () => {
  const { dir, file } = tmpFile();
  try {
    const store = new ApprovalStore({ persistPath: file, ttlMs: 60_000 });
    for (let i = 0; i < 10; i++) {
      store.create({
        runId: `run_burst_${i}`,
        userId: "alice",
        toolName: "Bash",
        action: `echo ${i}`,
        reason: "burst",
      });
    }
    assert.deepEqual(fs.readdirSync(dir), ["approvals.json"]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("approvals: decided records older than the retention bound are pruned from memory", () => {
  const { dir, file } = tmpFile();
  try {
    let now = 1_000_000;
    const store = new ApprovalStore({ persistPath: file, ttlMs: 60_000, now: () => now });
    const old = store.create({
      runId: "run_old",
      userId: "alice",
      toolName: "Bash",
      action: "echo old",
      reason: "old",
    });
    store.resolve(old.id, "approved");
    assert.ok(store.get(old.id));

    now += 25 * 60 * 60 * 1000;
    store.create({
      runId: "run_new",
      userId: "alice",
      toolName: "Bash",
      action: "echo new",
      reason: "new",
    });
    assert.equal(store.get(old.id), undefined);
    const persisted = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      approvals: { id: string }[];
    };
    assert.ok(!persisted.approvals.some((a) => a.id === old.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
