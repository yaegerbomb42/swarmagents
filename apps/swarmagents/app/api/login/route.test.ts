import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { configureUserPaths, signupLocalUser } from "../../../lib/users";
import { verifySession } from "../../../lib/auth";
import { configureAuditPath, readAuditEntries, auditLoginFailureTarget } from "../../../lib/audit";

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function setCookieValue(res: Response): string {
  const sc = res.headers.get("set-cookie");
  assert.ok(sc, "expected a Set-Cookie header");
  const m = /^swarm_session=([^;]+)/.exec(sc);
  assert.ok(m, `expected swarm_session cookie, got: ${sc}`);
  // Next percent-encodes the cookie value on the wire; the runtime cookie
  // parser decodes it before verifySession, so mirror that here.
  return decodeURIComponent(m[1]);
}

let dir = "";

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-login-test-"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
  await signupLocalUser("alice@example.com", "correct horse battery staple");
});

test.afterEach(() => {
  configureUserPaths("");
  delete process.env.SWARM_SESSION_SECRET;
  delete process.env.SWARM_SCRYPT_MAX_CONCURRENCY;
  delete process.env.SWARM_SCRYPT_MAX_QUEUE;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /api/login signs a session cookie with hardened attributes", async () => {
  const res = await POST(request({ email: "ALICE@example.com", password: "correct horse battery staple" }));
  assert.equal(res.status, 200);

  const json = (await res.json()) as { ok: boolean; user: { id: string }; next: string };
  assert.equal(json.ok, true);
  assert.equal(json.user.id, "local_alice@example.com");
  assert.equal(json.next, "/");

  // The cookie is signed and verifies to the same user, and carries the
  // required flags: HttpOnly, Secure, SameSite=Lax, site-wide Path.
  // (Next serializes SameSite as lowercase `lax`; match case-insensitively.)
  const sc = res.headers.get("set-cookie") ?? "";
  assert.ok(sc.includes("HttpOnly"), `expected HttpOnly in Set-Cookie: ${sc}`);
  assert.ok(sc.includes("Secure"), `expected Secure in Set-Cookie: ${sc}`);
  assert.ok(/SameSite=lax/i.test(sc), `expected SameSite=Lax in Set-Cookie: ${sc}`);
  assert.ok(sc.includes("Path=/"), `expected Path=/ in Set-Cookie: ${sc}`);
  assert.ok(/Max-Age=\d+/.test(sc), `expected Max-Age in Set-Cookie: ${sc}`);
  assert.equal(verifySession(setCookieValue(res)), "local_alice@example.com");
});

test("a second login does not invalidate an earlier session", async () => {
  const first = await POST(
    request({ email: "alice@example.com", password: "correct horse battery staple" })
  );
  assert.equal(first.status, 200);
  const firstCookie = setCookieValue(first);

  const second = await POST(
    request({ email: "alice@example.com", password: "correct horse battery staple" })
  );
  assert.equal(second.status, 200);
  const secondCookie = setCookieValue(second);

  // Sessions are stateless HMAC tokens: issuing a new one must not revoke the
  // old cookie. A future server-side revocation store would need to change
  // this test intentionally.
  assert.equal(verifySession(firstCookie), "local_alice@example.com");
  assert.equal(verifySession(secondCookie), "local_alice@example.com");
});

test("POST /api/login refuses wrong password and unknown email the same way", async () => {
  const wrongPw = await POST(request({ email: "alice@example.com", password: "nope" }));
  assert.equal(wrongPw.status, 401);
  assert.deepEqual(await wrongPw.json(), { error: "Invalid credentials." });

  const unknown = await POST(request({ email: "nobody@example.com", password: "whatever" }));
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), { error: "Invalid credentials." });
});

test("POST /api/login validates the next param and never reflects an open redirect", async () => {
  const ok = await POST(request({ email: "alice@example.com", password: "correct horse battery staple", next: "/runs?x=1" }));
  assert.equal((await ok.json()).next, "/runs?x=1");

  const evil: unknown[] = [
    "//evil.example.com",
    "https://evil.example.com",
    "javascript:alert(1)",
    "\\evil.example.com",
    "/\\evil.example.com",
    "\nLocation: https://evil.example.com",
    "/x".repeat(3000),
    null,
    42,
    { toString: () => "/" },
  ];
  for (const n of evil) {
    const res = await POST(request({ email: "alice@example.com", password: "correct horse battery staple", next: n }));
    assert.equal(res.status, 200, `next=${JSON.stringify(n)} should still log in`);
    assert.equal((await res.json()).next, "/", `next=${JSON.stringify(n)} must fall back to /`);
  }
});

test("POST /api/login rejects malformed bodies", async () => {
  // An empty object reaches the credential check and fails the same generic
  // way as a wrong password (no oracle for which field is missing).
  assert.equal((await POST(request({}))).status, 401);
  assert.equal((await POST(request([]))).status, 400);
  assert.equal((await POST(request("not json"))).status, 400);
  assert.equal((await POST(request({ email: "alice@example.com" }))).status, 401);
  assert.equal((await POST(request({ email: "alice@example.com", password: "x".repeat(2000) }))).status, 401);
});

test("POST /api/login returns 429 when the scrypt concurrency cap is saturated", async () => {
  process.env.SWARM_SCRYPT_MAX_CONCURRENCY = "1";
  process.env.SWARM_SCRYPT_MAX_QUEUE = "0";

  const holder = signupLocalUser("holder@example.com", "long enough password");
  try {
    const res = await POST(request({ email: "alice@example.com", password: "correct horse battery staple" }));
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("Retry-After")) > 0);
  } finally {
    await holder;
  }
});

test("POST /api/login refuses to run without SWARM_SESSION_SECRET", async () => {
  delete process.env.SWARM_SESSION_SECRET;
  const res = await POST(request({ email: "alice@example.com", password: "correct horse battery staple" }));
  assert.equal(res.status, 500);
});

test("auditLoginFailureTarget normalizes, strips controls, and caps length", () => {
  assert.equal(auditLoginFailureTarget(undefined), "unknown");
  assert.equal(auditLoginFailureTarget(""), "unknown");
  assert.equal(auditLoginFailureTarget("  Alice@Example.COM  "), "alice@example.com");
  assert.equal(auditLoginFailureTarget("bad\nemail\u0000@x.com"), "bademail@x.com");
  const huge = `a@${"b".repeat(400)}.com`;
  const capped = auditLoginFailureTarget(huge);
  assert.equal(capped.length, 254);
  assert.ok(capped.startsWith("a@bbb"));
});

test("POST /api/login writes a sanitized login.failure audit target", async () => {
  const auditFile = path.join(dir, "audit.jsonl");
  configureAuditPath(auditFile);
  try {
    const res = await POST(
      request({ email: `Evil\n@x.com${"Z".repeat(400)}`, password: "nope" }),
    );
    assert.equal(res.status, 401);
    const entries = readAuditEntries("anonymous");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "login.failure");
    assert.equal(entries[0].result, "failure");
    assert.ok(typeof entries[0].target === "string");
    assert.ok(entries[0].target.length <= 254);
    assert.ok(!entries[0].target.includes("\n"));
    assert.ok(!/[A-Z]/.test(entries[0].target));
  } finally {
    configureAuditPath(undefined);
  }
});

test("POST /api/login rejects an oversized body with 413", async () => {
  const res = await POST(
    request(JSON.stringify({ email: "alice@example.com", password: "x", pad: "x".repeat(17 * 1024) })),
  );
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "Request body too large." });
});

test("POST /api/login measures the body cap in UTF-8 bytes, not characters", async () => {
  // "é" is 2 bytes but 1 char: this body is under the 16 KiB cap in
  // characters yet over it in bytes, so the old text.length check would have
  // let it through to a 401. The byte cap must fire with a 413.
  const over = JSON.stringify({ email: "alice@example.com", password: "x", pad: "é".repeat(9000) });
  assert.ok(over.length < 16 * 1024, `chars ${over.length}`);
  assert.ok(Buffer.byteLength(over, "utf8") > 16 * 1024);
  assert.equal((await POST(request(over))).status, 413);

  // And a body that fits in bytes still reaches the credential check.
  const fits = JSON.stringify({ email: "alice@example.com", password: "wrong", pad: "é".repeat(7000) });
  assert.ok(Buffer.byteLength(fits, "utf8") < 16 * 1024);
  assert.equal((await POST(request(fits))).status, 401);
});

