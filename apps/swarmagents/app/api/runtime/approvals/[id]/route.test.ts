import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { USER_HEADER } from "../../../../../lib/auth";
import {
  ApprovalStore,
  getApprovalStore,
  setApprovalStoreForTesting,
} from "../../../../../lib/harness/approvals";
import { configureAuditPath } from "../../../../../lib/audit";

const USER = "local_alice@example.com";

let dir = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-approvals-route-"));
  configureAuditPath(path.join(dir, "audit.jsonl"));
  setApprovalStoreForTesting(new ApprovalStore());
});

test.afterEach(() => {
  setApprovalStoreForTesting(null);
  configureAuditPath(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

function post(
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/runtime/approvals/${id}`, {
    method: "POST",
    headers: { [USER_HEADER]: USER, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

test("POST approve resolves the approval and returns Cache-Control: no-store", async () => {
  const approval = getApprovalStore().create({
    runId: "run_abc123",
    userId: USER,
    toolName: "Bash",
    action: "rm -rf /tmp/work",
    reason: "test approval",
  });

  const res = await post(approval.id, { decision: "approve" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { ok?: boolean; status?: string };
  assert.equal(body.ok, true);
  assert.equal(body.status, "approved");
});

test("POST error responses carry Cache-Control: no-store", async () => {
  // Unknown approval -> 404
  const missing = await post("appr_does-not-exist", { decision: "deny" });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");

  // Invalid decision -> 400
  const bad = await post("appr_anything", { decision: "maybe" });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("cache-control"), "no-store");

  // Unauthenticated -> 401
  const anon = new NextRequest("http://localhost/api/runtime/approvals/x", {
    method: "POST",
    body: JSON.stringify({ decision: "approve" }),
  });
  const unauthorized = await POST(anon, { params: Promise.resolve({ id: "x" }) });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");
});
