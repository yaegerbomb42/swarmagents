import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { configureUserPaths, isEmailVerified, signupLocalUser } from "../../../lib/users";
import { verifySession } from "../../../lib/auth";
import { setMailTransportForTests, type MailMessage } from "../../../lib/mailer";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let dir = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-signup-test-"));
  configureUserPaths(path.join(dir, "users.json"));
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
});

test.afterEach(() => {
  configureUserPaths("");
  delete process.env.SWARM_SESSION_SECRET;
  delete process.env.SWARM_SERVER_MODE;
  delete process.env.SWARM_ALLOW_SIGNUP;
  delete process.env.SWARM_SCRYPT_MAX_CONCURRENCY;
  delete process.env.SWARM_SCRYPT_MAX_QUEUE;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POST /api/signup creates a user and signs a hardened session cookie", async () => {
  const res = await POST(request({ email: "Bob@Example.COM", password: "a very long password" }));
  assert.equal(res.status, 201);
  const json = (await res.json()) as { ok: boolean; user: { uid: string; email: string } };
  assert.equal(json.ok, true);
  assert.equal(json.user.email, "bob@example.com");
  assert.equal(json.user.uid, "local_bob@example.com");

  const sc = res.headers.get("set-cookie") ?? "";
  assert.ok(sc.includes("HttpOnly"), `expected HttpOnly: ${sc}`);
  assert.ok(sc.includes("Secure"), `expected Secure: ${sc}`);
  assert.ok(/SameSite=lax/i.test(sc), `expected SameSite=Lax: ${sc}`);
  assert.ok(sc.includes("Path=/"), `expected Path=/: ${sc}`);
  const m = /^swarm_session=([^;]+)/.exec(sc);
  assert.ok(m, `expected swarm_session cookie, got: ${sc}`);
  // Next percent-encodes the cookie value on the wire; the runtime cookie
  // parser decodes it before verifySession, so mirror that here.
  assert.equal(verifySession(decodeURIComponent(m[1])), "local_bob@example.com");
});

test("POST /api/signup rejects duplicates, invalid input, and non-JSON", async () => {
  assert.equal((await POST(request({ email: "a@example.com", password: "long enough password" }))).status, 201);
  assert.equal((await POST(request({ email: "A@EXAMPLE.COM", password: "another long password" }))).status, 409);
  assert.equal((await POST(request({ email: "not-an-email", password: "long enough password" }))).status, 400);
  assert.equal((await POST(request({ email: "a@example.com", password: "short" }))).status, 400);
  assert.equal((await POST(request({ email: "a@example.com" }))).status, 400);
  assert.equal((await POST(request({}))).status, 400);
  assert.equal((await POST(request("not json"))).status, 400);
  assert.equal((await POST(request([]))).status, 400);
});

test("POST /api/signup returns 429 when the scrypt concurrency cap is saturated", async () => {
  process.env.SWARM_SCRYPT_MAX_CONCURRENCY = "1";
  process.env.SWARM_SCRYPT_MAX_QUEUE = "0";

  // Hold the only derivation slot, then hit the route: it must shed load with
  // a 429 rather than pile another hash onto the libuv pool.
  const holder = signupLocalUser("holder@example.com", "long enough password");
  try {
    const res = await POST(request({ email: "blocked@example.com", password: "long enough password" }));
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("Retry-After")) > 0);
    const json = (await res.json()) as { error: string };
    assert.match(json.error, /too many sign-up attempts/i);
  } finally {
    await holder;
  }
});

test("POST /api/signup refuses to run without SWARM_SESSION_SECRET", async () => {
  delete process.env.SWARM_SESSION_SECRET;
  const res = await POST(request({ email: "a@example.com", password: "long enough password" }));
  assert.equal(res.status, 500);
});

test("POST /api/signup is closed in production unless SWARM_ALLOW_SIGNUP is set", async () => {
  const env = process.env as Record<string, string | undefined>;
  const prev = env.NODE_ENV;
  env.NODE_ENV = "production";
  delete env.SWARM_ALLOW_SIGNUP;
  try {
    const res = await POST(request({ email: "closed@example.com", password: "long-enough-pw" }));
    assert.equal(res.status, 403);
  } finally {
    env.NODE_ENV = prev;
  }
});

test("POST /api/signup is closed in server mode in non-production unless SWARM_ALLOW_SIGNUP is set", async () => {
  // A staging/test server-mode deployment used to allow open signup (the
  // old rule only closed it when NODE_ENV=production). Local mode stays
  // open: only loopback can reach it, and creating the first local account
  // is the intended local flow.
  const env = process.env as Record<string, string | undefined>;
  const prevNodeEnv = env.NODE_ENV;
  env.NODE_ENV = "test";
  env.SWARM_SERVER_MODE = "1";
  delete env.SWARM_ALLOW_SIGNUP;
  try {
    const closed = await POST(request({ email: "closed@example.com", password: "long-enough-pw" }));
    assert.equal(closed.status, 403);

    env.SWARM_ALLOW_SIGNUP = "1";
    const open = await POST(request({ email: "open@example.com", password: "long-enough-pw" }));
    assert.equal(open.status, 201);
  } finally {
    env.NODE_ENV = prevNodeEnv;
  }
});

/* ------------------------------------------------------------------ */
/* Email verification + bot check (FIX-44)                             */
/* ------------------------------------------------------------------ */

test("POST /api/signup sends a verification email and the account starts unverified", async () => {
  const sent: MailMessage[] = [];
  setMailTransportForTests(async (message) => {
    sent.push(message);
    return { ok: true };
  });
  try {
    const res = await POST(request({ email: "verifyme@example.com", password: "a very long password" }));
    assert.equal(res.status, 201);
    const json = (await res.json()) as { emailVerification?: string };
    assert.equal(json.emailVerification, "pending");
    assert.equal(isEmailVerified("verifyme@example.com"), false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "verifyme@example.com");
    assert.ok(sent[0].text.includes("/verify-email?token=ev1."), "email carries the verify link");
  } finally {
    setMailTransportForTests(null);
  }
});

test("POST /api/signup rejects when the configured bot check fails, creating nothing", async () => {
  process.env.SWARM_TURNSTILE_SECRET = "test-turnstile-secret";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch;
  try {
    const res = await POST(
      request({ email: "bot@example.com", password: "a very long password", botToken: "bad-token" }),
    );
    assert.equal(res.status, 400);
    // No account was created: the same email can still sign up afterwards.
    const created = await signupLocalUser("bot@example.com", "a very long password");
    assert.equal(created.ok, true);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SWARM_TURNSTILE_SECRET;
  }
});

test("POST /api/signup accepts a passing bot check", async () => {
  process.env.SWARM_TURNSTILE_SECRET = "test-turnstile-secret";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch;
  setMailTransportForTests(async () => ({ ok: true }));
  try {
    const res = await POST(
      request({ email: "human@example.com", password: "a very long password", botToken: "good-token" }),
    );
    assert.equal(res.status, 201);
  } finally {
    globalThis.fetch = realFetch;
    setMailTransportForTests(null);
    delete process.env.SWARM_TURNSTILE_SECRET;
  }
});
