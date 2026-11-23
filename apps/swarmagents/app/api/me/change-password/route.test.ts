import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { SESSION_COOKIE, signSession, USER_HEADER, verifySession } from "../../../../lib/auth";
import {
  configureUserPaths,
  getSessionEpoch,
  signupLocalUser,
  verifyLocalUser,
} from "../../../../lib/users";
import { configureAuditPath, readAuditEntries } from "../../../../lib/audit";

const OLD_PASSWORD = "correct horse battery";
const NEW_PASSWORD = "Tr0ub4dor&3-rotated";
const UID = "local_alice@example.com";

function request(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/me/change-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function sessionCookieValue(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

let dir = "";
let previousSecret: string | undefined;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-change-password-test-"));
  configureUserPaths(path.join(dir, "users.json"));
  previousSecret = process.env.SWARM_SESSION_SECRET;
  process.env.SWARM_SESSION_SECRET = "test-secret-for-change-password-route";
});

test.afterEach(() => {
  configureUserPaths("");
  if (previousSecret === undefined) delete process.env.SWARM_SESSION_SECRET;
  else process.env.SWARM_SESSION_SECRET = previousSecret;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST requires an authenticated caller", async () => {
  const res = await POST(request({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }));
  assert.equal(res.status, 401);
});

test("POST rejects non-local identities", async () => {
  const res = await POST(
    request(
      { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
      { [USER_HEADER]: "harness" },
    ),
  );
  assert.equal(res.status, 400);
});

test("POST rejects a wrong current password with 401 and changes nothing", async () => {
  assert.equal((await signupLocalUser("alice@example.com", OLD_PASSWORD)).ok, true);
  const epochBefore = getSessionEpoch("alice@example.com");

  const res = await POST(
    request(
      { currentPassword: "not the password", newPassword: NEW_PASSWORD },
      { [USER_HEADER]: UID },
    ),
  );
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null, "no cookie is minted on failure");

  // The old password still works and no sessions were revoked.
  assert.ok(await verifyLocalUser("alice@example.com", OLD_PASSWORD));
  assert.equal(getSessionEpoch("alice@example.com"), epochBefore);
});

test("POST rejects a new password that violates the signup policy", async () => {
  assert.equal((await signupLocalUser("alice@example.com", OLD_PASSWORD)).ok, true);

  const short = await POST(
    request({ currentPassword: OLD_PASSWORD, newPassword: "short" }, { [USER_HEADER]: UID }),
  );
  assert.equal(short.status, 400);

  const missing = await POST(request({ newPassword: NEW_PASSWORD }, { [USER_HEADER]: UID }));
  assert.equal(missing.status, 400);

  assert.ok(await verifyLocalUser("alice@example.com", OLD_PASSWORD), "password unchanged");
});

test("POST rotates the password: old fails, new works, other sessions die, this one survives", async () => {
  assert.equal((await signupLocalUser("alice@example.com", OLD_PASSWORD)).ok, true);

  // A session minted before the change (another device, or a stolen copy).
  const otherDeviceToken = signSession(UID, Date.now() - 60_000);
  assert.equal(verifySession(otherDeviceToken), UID, "pre-change session is valid");

  const res = await POST(
    request({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, { [USER_HEADER]: UID }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok?: boolean };
  assert.equal(body.ok, true);

  // Old password fails login; the new one works.
  assert.equal(await verifyLocalUser("alice@example.com", OLD_PASSWORD), null);
  assert.ok(await verifyLocalUser("alice@example.com", NEW_PASSWORD));

  // The epoch advanced, so the other device's session is revoked...
  assert.ok(getSessionEpoch("alice@example.com") > 0, "epoch should advance");
  assert.equal(verifySession(otherDeviceToken), null, "other sessions are revoked");

  // ...while the re-minted cookie on this response keeps this device in.
  const currentToken = sessionCookieValue(res);
  assert.ok(currentToken, "response re-mints the session cookie");
  assert.equal(verifySession(currentToken), UID, "current session is still valid");
});

test("POST for an unknown local account fails cleanly", async () => {
  const res = await POST(
    request(
      { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
      { [USER_HEADER]: "local_nobody@example.com" },
    ),
  );
  assert.equal(res.status, 500);
});

test("POST returns Cache-Control: no-store on state-mutating responses", async () => {
  assert.equal((await signupLocalUser("alice@example.com", OLD_PASSWORD)).ok, true);

  const ok = await POST(
    request({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, { [USER_HEADER]: UID }),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");

  const unauthorized = await POST(request({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }));
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");

  const wrongCurrent = await POST(
    request({ currentPassword: "nope nope nope", newPassword: NEW_PASSWORD }, { [USER_HEADER]: UID }),
  );
  assert.equal(wrongCurrent.status, 401);
  assert.equal(wrongCurrent.headers.get("cache-control"), "no-store");
});

test("POST writes a password.change audit entry on success and failure", async () => {
  assert.equal((await signupLocalUser("alice@example.com", OLD_PASSWORD)).ok, true);
  const auditFile = path.join(dir, "audit.jsonl");
  configureAuditPath(auditFile);
  try {
    const failed = await POST(
      request({ currentPassword: "wrong password", newPassword: NEW_PASSWORD }, { [USER_HEADER]: UID }),
    );
    assert.equal(failed.status, 401);
    const ok = await POST(
      request({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, { [USER_HEADER]: UID }),
    );
    assert.equal(ok.status, 200);

    const entries = readAuditEntries(UID);
    assert.equal(entries.length, 2);
    // Newest first.
    assert.equal(entries[0].action, "password.change");
    assert.equal(entries[0].target, UID);
    assert.equal(entries[0].result, "success");
    assert.equal(entries[1].action, "password.change");
    assert.equal(entries[1].result, "failure");
  } finally {
    configureAuditPath(undefined);
  }
});
