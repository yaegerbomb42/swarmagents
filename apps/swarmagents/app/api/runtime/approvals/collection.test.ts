/**
 * Tests for the pending-approval collection route:
 *
 *   GET  /api/runtime/approvals          -> { approvals: [...] } (caller only)
 *   POST /api/runtime/approvals          -> batch approve/deny { resolved, missing }
 *
 * Uses an in-memory ApprovalStore injected via setApprovalStoreForTesting
 * and a temp audit file so no real state is touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, POST, type PendingApprovalView } from "./route";
import {
  ApprovalStore,
  getApprovalStore,
  setApprovalStoreForTesting,
  type PendingApproval,
} from "../../../../lib/harness/approvals";
import { configureAuditPath, readAuditEntries } from "../../../../lib/audit";

let dir: string;

function request(pathname: string, init: RequestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${pathname}`, { ...init, headers, signal: init.signal ?? undefined });
}

function createApproval(userId: string, runId = "run_1"): PendingApproval {
  return getApprovalStore().create({
    runId,
    userId,
    toolName: "Bash",
    action: "rm -rf /",
    reason: "destructive command",
  });
}

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-approvals-collection-"));
  configureAuditPath(path.join(dir, "audit.jsonl"));
  setApprovalStoreForTesting(new ApprovalStore({ ttlMs: 60_000 }));
});

test.afterEach(() => {
  setApprovalStoreForTesting(null);
  configureAuditPath(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("GET lists only the caller's pending approvals, oldest first, with no-store", async () => {
  const a1 = createApproval("alice");
  const a2 = createApproval("alice", "run_2");
  createApproval("bob");
  const decided = createApproval("alice");
  getApprovalStore().resolve(decided.id, "approved");

  const res = await GET(request("/api/runtime/approvals"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { approvals: PendingApprovalView[] };
  assert.deepEqual(
    body.approvals.map((a) => a.id),
    [a1.id, a2.id],
  );
  assert.equal(body.approvals[0].runId, "run_1");
  assert.equal(body.approvals[0].toolName, "Bash");
  assert.equal(body.approvals[0].action, "rm -rf /");
  assert.ok(typeof body.approvals[0].createdAt === "number");
  assert.ok(body.approvals[0].expiresAt > body.approvals[0].createdAt);
  // No userId leaks into the view.
  assert.ok(!("userId" in body.approvals[0]));
});

test("GET filters by runId and requires auth", async () => {
  createApproval("alice", "run_1");
  createApproval("alice", "run_2");

  const filtered = (await (
    await GET(request("/api/runtime/approvals?runId=run_2"))
  ).json()) as { approvals: Array<{ runId: string }> };
  assert.equal(filtered.approvals.length, 1);
  assert.equal(filtered.approvals[0].runId, "run_2");

  assert.equal((await GET(request("/api/runtime/approvals", {}, null))).status, 401);
});

test("POST batch approve resolves all, audits each, and returns no missing", async () => {
  const a1 = createApproval("alice");
  const a2 = createApproval("alice", "run_2");

  const res = await POST(
    request("/api/runtime/approvals", {
      method: "POST",
      body: JSON.stringify({ decision: "approve", ids: [a1.id, a2.id] }),
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { ok: boolean; resolved: Array<{ id: string; status: string }>; missing: string[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.resolved, [
    { id: a1.id, status: "approved" },
    { id: a2.id, status: "approved" },
  ]);
  assert.deepEqual(body.missing, []);
  assert.equal(getApprovalStore().get(a1.id)?.status, "approved");

  const entries = readAuditEntries("alice");
  assert.deepEqual(
    entries.map((e) => [e.action, e.target]),
    [
      ["approval.approve", a2.id],
      ["approval.approve", a1.id],
    ],
  );
});

test("POST batch deny puts unknown / foreign / decided ids in missing", async () => {
  const mine = createApproval("alice");
  createApproval("bob");
  const foreign = getApprovalStore()
    .listPendingForUser("bob")[0];
  const decided = createApproval("alice");
  getApprovalStore().resolve(decided.id, "approved");

  const res = await POST(
    request("/api/runtime/approvals", {
      method: "POST",
      body: JSON.stringify({ decision: "deny", ids: [mine.id, "appr_ghost", foreign.id, decided.id, mine.id] }),
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { resolved: Array<{ id: string; status: string }>; missing: string[] };
  assert.deepEqual(body.resolved, [{ id: mine.id, status: "denied" }]);
  assert.deepEqual(body.missing, ["appr_ghost", foreign.id, decided.id]);
  const entries = readAuditEntries("alice");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "approval.deny");
});

test("POST validates decision, ids, JSON, and body size", async () => {
  const a1 = createApproval("alice");
  const post = (body: unknown, raw?: string) =>
    POST(
      request("/api/runtime/approvals", {
        method: "POST",
        body: raw ?? JSON.stringify(body),
      }),
    );

  assert.equal((await POST(request("/api/runtime/approvals", { method: "POST", body: "{}" }, null))).status, 401);
  assert.equal((await post({ decision: "maybe", ids: [a1.id] })).status, 400);
  assert.equal((await post({ decision: "approve", ids: [] })).status, 400);
  assert.equal((await post({ decision: "approve", ids: "nope" })).status, 400);
  assert.equal((await post({ decision: "approve", ids: [123, null] })).status, 400);
  assert.equal((await post({ decision: "approve", ids: Array.from({ length: 26 }, (_, i) => `appr_${i}`) })).status, 400);
  assert.equal((await post(null, "{not json")).status, 400);
  assert.equal((await post(null, JSON.stringify([1, 2]))).status, 400);

  const huge = JSON.stringify({ decision: "approve", ids: [a1.id], pad: "x".repeat(17 * 1024) });
  assert.equal((await post(null, huge)).status, 413);
  // The oversized request did not decide anything.
  assert.equal(getApprovalStore().get(a1.id)?.status, "pending");
});
