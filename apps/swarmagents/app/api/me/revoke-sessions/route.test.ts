import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { USER_HEADER } from "../../../../lib/auth";
import { configureUserPaths, getSessionEpoch, signupLocalUser } from "../../../../lib/users";
import { configureAuditPath, readAuditEntries } from "../../../../lib/audit";

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/me/revoke-sessions", { method: "POST", headers });
}

let dir = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-revoke-test-"));
  configureUserPaths(path.join(dir, "users.json"));
});

test.afterEach(() => {
  configureUserPaths("");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST requires an authenticated caller", async () => {
  const res = await POST(request());
  assert.equal(res.status, 401);
});

test("POST rejects non-local identities", async () => {
  const res = await POST(request({ [USER_HEADER]: "harness" }));
  assert.equal(res.status, 400);
});

test("POST bumps the epoch and clears this device's cookie", async () => {
  assert.equal((await signupLocalUser("alice@example.com", "correct horse battery")).ok, true);
  const before = getSessionEpoch("alice@example.com");
  assert.equal(before, 0);

  const res = await POST(request({ [USER_HEADER]: "local_alice@example.com" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok?: boolean };
  assert.equal(body.ok, true);
  assert.ok(getSessionEpoch("alice@example.com") > before, "epoch should advance");

  // The current device's session cookie is cleared immediately.
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie.toLowerCase(), /swarm_session=;/);
  assert.match(setCookie.toLowerCase(), /age=0/);
});

test("POST for an unknown local account fails cleanly", async () => {
  const res = await POST(request({ [USER_HEADER]: "local_nobody@example.com" }));
  assert.equal(res.status, 500);
});

test("POST returns Cache-Control: no-store on state-mutating responses", async () => {
  assert.equal((await signupLocalUser("alice@example.com", "correct horse battery")).ok, true);

  const ok = await POST(request({ [USER_HEADER]: "local_alice@example.com" }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");

  const unauthorized = await POST(request());
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");

  const nonLocal = await POST(request({ [USER_HEADER]: "harness" }));
  assert.equal(nonLocal.status, 400);
  assert.equal(nonLocal.headers.get("cache-control"), "no-store");
});

test("POST writes a session.revoke audit entry on success and failure", async () => {
  assert.equal((await signupLocalUser("alice@example.com", "correct horse battery")).ok, true);
  const auditFile = path.join(dir, "audit.jsonl");
  configureAuditPath(auditFile);
  try {
    const ok = await POST(request({ [USER_HEADER]: "local_alice@example.com" }));
    assert.equal(ok.status, 200);
    const failed = await POST(request({ [USER_HEADER]: "local_nobody@example.com" }));
    assert.equal(failed.status, 500);

    const alice = readAuditEntries("local_alice@example.com");
    assert.equal(alice.length, 1);
    assert.equal(alice[0].action, "session.revoke");
    assert.equal(alice[0].target, "local_alice@example.com");
    assert.equal(alice[0].result, "success");

    const nobody = readAuditEntries("local_nobody@example.com");
    assert.equal(nobody.length, 1);
    assert.equal(nobody[0].action, "session.revoke");
    assert.equal(nobody[0].result, "failure");
  } finally {
    configureAuditPath(undefined);
  }
});
