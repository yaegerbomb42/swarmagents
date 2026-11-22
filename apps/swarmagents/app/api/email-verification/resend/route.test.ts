/**
 * Route tests for POST /api/email-verification/resend (FIX-44):
 * signed-in unverified accounts get a fresh link emailed; verified
 * accounts get the same 200 with no mail; anonymous callers get 401.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { USER_HEADER } from "../../../../lib/auth";
import { configureUserPaths, signupLocalUser } from "../../../../lib/users";
import { setMailTransportForTests, type MailMessage } from "../../../../lib/mailer";

function request(userId?: string): NextRequest {
  return new NextRequest("http://localhost/api/email-verification/resend", {
    method: "POST",
    headers: userId ? { [USER_HEADER]: userId } : {},
  });
}

let dir = "";
let sent: MailMessage[] = [];

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-verify-resend-test-"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = "test-secret-for-verification";
  sent = [];
  setMailTransportForTests(async (message) => {
    sent.push(message);
    return { ok: true };
  });
});

test.afterEach(() => {
  configureUserPaths("");
  setMailTransportForTests(null);
  delete process.env.SWARM_SESSION_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resend: unverified signed-in account gets a fresh verification email", async () => {
  await signupLocalUser("resend@example.com", "correct horse battery");
  const res = await POST(request("local_resend@example.com"));
  assert.equal(res.status, 200);
  // The send is fire-and-forget; let the microtask/timer queue drain.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "resend@example.com");
  assert.ok(sent[0].text.includes("/verify-email?token=ev1."), "email carries the verify link");
});

test("resend: anonymous is 401 and non-local identities are 400, no mail either way", async () => {
  assert.equal((await POST(request())).status, 401);
  assert.equal((await POST(request("harness"))).status, 400);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 0);
});
