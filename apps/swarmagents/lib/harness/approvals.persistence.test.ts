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
