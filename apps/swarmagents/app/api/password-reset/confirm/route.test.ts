import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  configureUserPaths,
  issuePasswordResetToken,
  signupLocalUser,
  verifyLocalUser,
} from "../../../../lib/users";
import { signSession, verifySession } from "../../../../lib/auth";
import { configureAuditPath, readAuditEntries } from "../../../../lib/audit";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/password-reset/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let dir = "";

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-reset-confirm-test-"));
  configureUserPaths(path.join(dir, "users.json"));
  configureAuditPath(path.join(dir, "audit.jsonl"));
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
  await signupLocalUser("alice@example.com", "correct horse battery staple");
});

test.afterEach(() => {
  configureUserPaths("");
  configureAuditPath(undefined);
  delete process.env.SWARM_SESSION_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /api/password-reset/confirm resets the password and revokes prior sessions", async () => {
  // A session minted before the reset is valid...
  const priorSession = signSession("local_alice@example.com", Date.now() - 60_000);
  assert.equal(verifySession(priorSession), "local_alice@example.com");

  const token = await issuePasswordResetToken("alice@example.com");
  assert.ok(token);

  const res = await POST(request({ token, password: "a brand new password" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("cache-control"), "no-store");

  // Old password fails, new password works.
  assert.equal(await verifyLocalUser("alice@example.com", "correct horse battery staple"), null);
  assert.ok(await verifyLocalUser("alice@example.com", "a brand new password"));

  // ...and the pre-reset session is revoked by the epoch bump.
  assert.equal(verifySession(priorSession), null, "prior sessions die with the old password");

  // The reset is audited under the account.
  const entries = readAuditEntries("local_alice@example.com").filter((e) => e.action === "password.reset");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result, "success");
});

test("POST /api/password-reset/confirm rejects reused, expired and garbage tokens identically", async () => {
  const token = await issuePasswordResetToken("alice@example.com");
  assert.ok(token);
  assert.equal((await POST(request({ token, password: "a brand new password" }))).status, 200);

  const reused = await POST(request({ token, password: "another new password" }));
  assert.equal(reused.status, 400);
  const reusedBody = await reused.json();

  // Expired: issued an hour ago with a 1ms TTL.
  const stale = await issuePasswordResetToken("alice@example.com", { now: Date.now() - 3_600_000, ttlMs: 1 });
  assert.ok(stale);
  const expired = await POST(request({ token: stale, password: "another new password" }));
  assert.equal(expired.status, 400);
  assert.deepEqual(await expired.json(), reusedBody, "expired and reused are indistinguishable");

  const garbage = await POST(request({ token: "pr1.garbage", password: "another new password" }));
  assert.equal(garbage.status, 400);
  assert.deepEqual(await garbage.json(), reusedBody, "garbage tokens get the same answer");

  // None of the failed attempts changed the password.
  assert.ok(await verifyLocalUser("alice@example.com", "a brand new password"));
});

test("POST /api/password-reset/confirm enforces the password policy without consuming the token", async () => {
  const token = await issuePasswordResetToken("alice@example.com");
  assert.ok(token);

  const short = await POST(request({ token, password: "short" }));
  assert.equal(short.status, 400);
  assert.match((await short.json()).error, /at least 8 characters/);

  // The token survives the policy rejection: a valid retry still works.
  const ok = await POST(request({ token, password: "a brand new password" }));
  assert.equal(ok.status, 200);
  assert.ok(await verifyLocalUser("alice@example.com", "a brand new password"));
});

test("POST /api/password-reset/confirm rejects malformed bodies", async () => {
  assert.equal((await POST(request("not json"))).status, 400);
  assert.equal((await POST(request([]))).status, 400);
  // Missing fields: policy error for the missing password, never a 500.
  assert.equal((await POST(request({}))).status, 400);
});
