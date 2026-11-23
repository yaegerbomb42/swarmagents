import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { SESSION_COOKIE, sessionCookieOptions, signSession, verifySession } from "../../../lib/auth";
import { configureUserPaths, getSessionEpoch, signupLocalUser } from "../../../lib/users";
import { configureAuditPath, readAuditEntries } from "../../../lib/audit";

function request(cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers["cookie"] = `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`;
  return new NextRequest("http://localhost/api/logout", { method: "POST", headers });
}

let dir = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-logout-test-"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
});

test.afterEach(() => {
  configureUserPaths("");
  delete process.env.SWARM_SESSION_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /api/logout clears the session cookie and returns ok", async () => {
  assert.equal((await signupLocalUser("alice@example.com", "correct horse battery")).ok, true);
  const token = signSession("local_alice@example.com");

  const res = await POST(request(token));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok?: boolean };
  assert.equal(body.ok, true);

  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie.toLowerCase(), /swarm_session=;/);
  assert.match(setCookie.toLowerCase(), /age=0/);
});

test("POST /api/logout clears the cookie even with no/expired session (public route)", async () => {
  const res = await POST(request());
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie.toLowerCase(), /swarm_session=;/);
  assert.match(setCookie.toLowerCase(), /age=0/);
});

test("POST /api/logout does NOT bump the session epoch (single-device)", async () => {
  assert.equal((await signupLocalUser("alice@example.com", "correct horse battery")).ok, true);
  const token = signSession("local_alice@example.com");
  assert.equal(getSessionEpoch("alice@example.com"), 0);

  const res = await POST(request(token));
  assert.equal(res.status, 200);
  // Epoch unchanged → other devices (which rely on the same epoch) stay signed in.
  assert.equal(getSessionEpoch("alice@example.com"), 0);
  assert.equal(verifySession(token), "local_alice@example.com");
});

test("POST /api/logout writes a session.logout audit entry for a valid session", async () => {
  assert.equal((await signupLocalUser("alice@example.com", "correct horse battery")).ok, true);
  const auditFile = path.join(dir, "audit.jsonl");
  configureAuditPath(auditFile);
  try {
    const token = signSession("local_alice@example.com");
    const res = await POST(request(token));
    assert.equal(res.status, 200);

    const alice = readAuditEntries("local_alice@example.com");
    assert.equal(alice.length, 1);
    assert.equal(alice[0].action, "session.logout");
    assert.equal(alice[0].target, "local_alice@example.com");
    assert.equal(alice[0].result, "success");
  } finally {
    configureAuditPath(undefined);
  }
});

test("POST /api/logout writes no audit entry without a valid session", async () => {
  const auditFile = path.join(dir, "audit.jsonl");
  configureAuditPath(auditFile);
  try {
    await POST(request());
    await POST(request("garbage-token"));
    assert.deepEqual(readAuditEntries("local_alice@example.com"), []);
  } finally {
    configureAuditPath(undefined);
  }
});

test("POST /api/logout returns Cache-Control: no-store", async () => {
  const res = await POST(request());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
});
