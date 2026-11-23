/**
 * Route tests for POST /api/email-verification/confirm (FIX-44): a
 * genuine token flips the account to verified; unknown/expired/reused
 * tokens get one generic 400 and change nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import {
  configureUserPaths,
  isEmailVerified,
  issueEmailVerificationToken,
  signupLocalUser,
} from "../../../../lib/users";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/email-verification/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let dir = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-verify-confirm-test-"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = "test-secret-for-verification";
});

test.afterEach(() => {
  configureUserPaths("");
  delete process.env.SWARM_SESSION_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("confirm: valid token verifies the account; replay and bad tokens get the generic 400", async () => {
  await signupLocalUser("confirm@example.com", "correct horse battery");
  assert.equal(isEmailVerified("confirm@example.com"), false);
  const token = await issueEmailVerificationToken("confirm@example.com");
  assert.ok(token);

  const ok = await POST(request({ token }));
  assert.equal(ok.status, 200);
  assert.equal(isEmailVerified("confirm@example.com"), true);

  const replay = await POST(request({ token }));
  assert.equal(replay.status, 400);

  const bogus = await POST(request({ token: "ev1.not-a-real-token" }));
  assert.equal(bogus.status, 400);
  const replayBody = (await replay.json()) as { error: string };
  const bogusBody = (await bogus.json()) as { error: string };
  assert.equal(replayBody.error, bogusBody.error, "unknown/expired/reused are indistinguishable");
});

test("confirm: malformed body is a 400 and verifies nothing", async () => {
  await signupLocalUser("malformed@example.com", "correct horse battery");
  assert.equal((await POST(request("not json"))).status, 400);
  assert.equal((await POST(request({}))).status, 400);
  assert.equal(isEmailVerified("malformed@example.com"), false);
});
