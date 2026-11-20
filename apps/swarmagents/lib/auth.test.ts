import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bumpSessionEpoch, configureUserPaths, signupLocalUser } from "./users.js";
import {
  assertServerModeSecret,
  hostAllowed,
  isAllowed,
  isLoopbackHost,
  requestHostname,
  requestUser,
  safeNextPath,
  serverMode,
  serverModeSecretError,
  sessionCookieOptions,
  sessionMaxAgeSec,
  signSession,
  verifySession,
  USER_HEADER,
} from "./auth.js";

/** 64-char session-secret fixture: long enough to pass the boot length check. */
const LONG_TEST_SECRET = "0123456789abcdef".repeat(4);

/** Mint a legacy-format cookie (`<userId>.<hmac(userId)>`, no issued-at). */
function legacySignSession(userId: string): string {
  const secret = process.env.SWARM_SESSION_SECRET ?? "";
  return `${userId}.${createHmac("sha256", secret).update(userId).digest("hex")}`;
}

/** Return `token` with its issued-at segment replaced (v2 format only). */
function withIssuedAt(token: string, issuedAtSec: number): string {
  const parts = token.split(".");
  parts[parts.length - 2] = String(issuedAtSec);
  return parts.join(".");
}

function serverEnv() {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_SESSION_SECRET = "test-secret";
}

function req(headers: Record<string, string>, cookie?: string) {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    cookies: cookie ? { get: (name: string) => (name === "swarm_session" ? { value: cookie } : undefined) } : undefined,
  };
}

let usersDir = "";

/** Point the user store at a fresh temp file so epoch tests are isolated. */
function setupUsersStore() {
  usersDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-auth-users-"));
  configureUserPaths(path.join(usersDir, "users.json"));
}

function teardownUsersStore() {
  configureUserPaths("");
  fs.rmSync(usersDir, { recursive: true, force: true });
  usersDir = "";
}

test("hostAllowed: local mode trusts loopback only", () => {
  process.env.SWARM_SERVER_MODE = "0";
  assert.equal(hostAllowed(req({ host: "127.0.0.1:3777" })), true);
  assert.equal(hostAllowed(req({ host: "localhost" })), true);
  assert.equal(hostAllowed(req({ host: "evil.example.com" })), false);
});

test("hostAllowed: local mode trusts only explicitly configured VM callback hosts", () => {
  const previous = {
    approval: process.env.SWARM_VM_APPROVAL_BASE_URL,
    llm: process.env.SWARM_VM_LLM_BASE_URL,
  };
  try {
    process.env.SWARM_SERVER_MODE = "0";
    process.env.SWARM_VM_APPROVAL_BASE_URL = "http://host.docker.internal:3777";
    process.env.SWARM_VM_LLM_BASE_URL = "http://172.17.0.1:3777";
    assert.equal(hostAllowed(req({ host: "host.docker.internal:3777" })), true);
    assert.equal(hostAllowed(req({ host: "172.17.0.1:3777" })), true);
    assert.equal(hostAllowed(req({ host: "evil.example.com" })), false);
  } finally {
    if (previous.approval === undefined) delete process.env.SWARM_VM_APPROVAL_BASE_URL;
    else process.env.SWARM_VM_APPROVAL_BASE_URL = previous.approval;
    if (previous.llm === undefined) delete process.env.SWARM_VM_LLM_BASE_URL;
    else process.env.SWARM_VM_LLM_BASE_URL = previous.llm;
  }
});

test("hostAllowed: server mode consults SWARM_ALLOWED_HOSTS", () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_ALLOWED_HOSTS = "swarm.example.com";
  assert.equal(hostAllowed(req({ host: "swarm.example.com" })), true);
  assert.equal(hostAllowed(req({ host: "127.0.0.1" })), false);
});

test("isLoopbackHost: matches loopback names with ports and IPv6 brackets", () => {
  for (const host of ["", "localhost", "localhost:3777", "127.0.0.1", "127.0.0.1:3777", "[::1]", "[::1]:3777"]) {
    assert.equal(isLoopbackHost(req({ host })), true, `${host} must be loopback`);
  }
  for (const host of ["swarm.example.com", "evil.example.com:3777", "10.0.0.1:3777"]) {
    assert.equal(isLoopbackHost(req({ host })), false, `${host} must not be loopback`);
  }
});

test("requestUser: local mode returns the local user", () => {
  process.env.SWARM_SERVER_MODE = "0";
  assert.deepEqual(requestUser(req({})), { id: "local", email: "local@swarmagents.local" });
});

test("requestUser: server mode rejects no credentials", () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_SESSION_SECRET = "test-secret";
  assert.equal(requestUser(req({})), null);
});

test("requestUser: server mode accepts harness bearer token", () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_SESSION_SECRET = "test-secret";
  const user = requestUser(req({ authorization: "Bearer harness-token" }));
  assert.equal(user?.id, "harness");
  assert.equal(requestUser(req({ authorization: "Bearer wrong" })), null);
});

test("requestUser: server mode accepts signed session cookie, rejects tampered", () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_SESSION_SECRET = "test-secret";
  const good = signSession("alice");
  assert.equal(requestUser(req({}, good))?.id, "alice");
  assert.equal(requestUser(req({}, good + "x")), null);
});

test("requestUser: local account sessions report their real email", () => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_SESSION_SECRET = "test-secret";
  const user = requestUser(req({}, signSession("local_alice@example.com")));
  assert.deepEqual(user, { id: "local_alice@example.com", email: "alice@example.com" });
});

test("sessionMaxAgeSec: defaults to 7 days, honors SWARM_SESSION_MAX_AGE_SEC", () => {
  delete process.env.SWARM_SESSION_MAX_AGE_SEC;
  assert.equal(sessionMaxAgeSec(), 7 * 24 * 60 * 60);
  process.env.SWARM_SESSION_MAX_AGE_SEC = "3600";
  assert.equal(sessionMaxAgeSec(), 3600);
  process.env.SWARM_SESSION_MAX_AGE_SEC = "bogus";
  assert.equal(sessionMaxAgeSec(), 7 * 24 * 60 * 60);
  process.env.SWARM_SESSION_MAX_AGE_SEC = "0";
  assert.equal(sessionMaxAgeSec(), 7 * 24 * 60 * 60);
  process.env.SWARM_SESSION_MAX_AGE_SEC = "-5";
  assert.equal(sessionMaxAgeSec(), 7 * 24 * 60 * 60);
});

test("requestUser: v2 sessions expire after SWARM_SESSION_MAX_AGE_SEC", () => {
  serverEnv();
  process.env.SWARM_SESSION_MAX_AGE_SEC = "60";
  const now = Math.floor(Date.now() / 1000);
  assert.equal(requestUser(req({}, signSession("alice", now - 30)))?.id, "alice");
  // Just inside the limit is still valid (59s, not 60, so a clock tick cannot flake it).
  assert.equal(requestUser(req({}, signSession("alice", now - 59)))?.id, "alice");
  // One second past the limit is expired.
  assert.equal(requestUser(req({}, signSession("alice", now - 61))), null);
  // Well past the limit is expired.
  assert.equal(requestUser(req({}, signSession("alice", now - 8 * 24 * 60 * 60))), null);
});

test("requestUser: v2 sessions reject tampered issued-at and future issued-at", () => {
  serverEnv();
  process.env.SWARM_SESSION_MAX_AGE_SEC = "60";
  const now = Math.floor(Date.now() / 1000);
  const good = signSession("alice", now - 30);
  assert.equal(requestUser(req({}, good))?.id, "alice");
  // Rewriting issued-at without re-signing breaks the MAC.
  assert.equal(requestUser(req({}, withIssuedAt(good, now - 10))), null);
  // A session issued in the future is not trustworthy, even if re-signed.
  assert.equal(requestUser(req({}, signSession("alice", now + 3600))), null);
});

test("requestUser: legacy-format cookies without issued-at are rejected", () => {
  serverEnv();
  delete process.env.SWARM_SESSION_MAX_AGE_SEC;
  // Legacy cookies carry no issued-at, so they can never expire. After the
  // security fix they are rejected outright instead of being accepted forever.
  const legacy = legacySignSession("alice");
  assert.equal(requestUser(req({}, legacy)), null);
  assert.equal(requestUser(req({}, legacy + "x")), null);
  // A legacy user id that looks like a v2 token is not a real v2 token.
  assert.equal(requestUser(req({}, legacySignSession("v2.x.123"))), null);
  // A dotted legacy user id is rejected too.
  assert.equal(requestUser(req({}, legacySignSession("alice.smith"))), null);
});

test("requestUser: v2 sessions work for dotted user ids", () => {
  serverEnv();
  delete process.env.SWARM_SESSION_MAX_AGE_SEC;
  const now = Math.floor(Date.now() / 1000);
  assert.equal(requestUser(req({}, signSession("alice.smith", now)))?.id, "alice.smith");
  assert.equal(requestUser(req({}, signSession("alice.smith", now - 8 * 24 * 60 * 60))), null);
});

test("requestUser: bumping the session epoch revokes that user's v2 sessions only", async () => {
  serverEnv();
  setupUsersStore();
  try {
    delete process.env.SWARM_SESSION_MAX_AGE_SEC;
    assert.equal((await signupLocalUser("alice@example.com", "correct horse battery")).ok, true);
    assert.equal((await signupLocalUser("bob@example.com", "another strong secret")).ok, true);

    const now = Math.floor(Date.now() / 1000);
    // Both sessions issued a while ago (still within the 7-day TTL).
    const aliceOld = signSession("local_alice@example.com", now - 3600);
    const bobOld = signSession("local_bob@example.com", now - 3600);
    // A session issued in this very second, just before the revocation.
    const aliceSameSecond = signSession("local_alice@example.com");

    // Before revocation both sessions are accepted.
    assert.equal(requestUser(req({}, aliceOld))?.id, "local_alice@example.com");
    assert.equal(requestUser(req({}, bobOld))?.id, "local_bob@example.com");
    assert.equal(requestUser(req({}, aliceSameSecond))?.id, "local_alice@example.com");

    // Revoke alice's sessions (the "Sign out everywhere" action).
    assert.equal(await bumpSessionEpoch("alice@example.com"), true);

    // Alice's previously-issued session is now rejected…
    assert.equal(requestUser(req({}, aliceOld)), null);
    // …including the one issued in the same second as the revocation —
    // the millisecond epoch closes the same-second bypass…
    assert.equal(requestUser(req({}, aliceSameSecond)), null);
    // …but Bob's identical-age session still works (per-user revocation).
    assert.equal(requestUser(req({}, bobOld))?.id, "local_bob@example.com");

    // A fresh session minted for Alice after the bump is accepted — but
    // only from the next second onward: the millisecond epoch also rejects
    // a session minted in the remainder of the same second as the
    // revocation, so wait for the second boundary first.
    await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 5));
    const aliceFresh = signSession("local_alice@example.com");
    assert.equal(requestUser(req({}, aliceFresh))?.id, "local_alice@example.com");
  } finally {
    teardownUsersStore();
  }
});

test("isAllowed: local mode honors the loopback host gate; server mode also requires auth", () => {
  process.env.SWARM_SERVER_MODE = "0";
  assert.equal(isAllowed(req({})), true);
  assert.equal(isAllowed(req({ host: "127.0.0.1:3777" })), true);
  // b8: local mode must still refuse a request aimed at a non-loopback Host.
  assert.equal(isAllowed(req({ host: "evil.example.com" })), false);

  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_SESSION_SECRET = "test-secret";
  process.env.SWARM_ALLOWED_HOSTS = "swarm.example.com";
  // A disallowed Host is refused even with valid credentials.
  assert.equal(isAllowed(req({ host: "evil.example.com", authorization: "Bearer harness-token" })), false);
  // An allowed Host without credentials is refused.
  assert.equal(isAllowed(req({ host: "swarm.example.com" })), false);
  // An allowed Host with credentials is allowed.
  assert.equal(isAllowed(req({ host: "swarm.example.com", authorization: "Bearer harness-token" })), true);
});

test("serverModeSecretError: server mode without a secret fails boot, local mode does not", () => {
  const previous = {
    mode: process.env.SWARM_SERVER_MODE,
    secret: process.env.SWARM_SESSION_SECRET,
  };
  try {
    // Server mode, secret missing entirely.
    process.env.SWARM_SERVER_MODE = "1";
    delete process.env.SWARM_SESSION_SECRET;
    const missing = serverModeSecretError();
    assert.ok(missing, "missing secret must produce an error");
    assert.ok(missing?.includes("SWARM_SESSION_SECRET"), `error must name the variable: ${missing}`);

    // Server mode, secret blank or whitespace-only: same failure.
    for (const blank of ["", "   "]) {
      process.env.SWARM_SESSION_SECRET = blank;
      assert.ok(serverModeSecretError(), `blank secret ${JSON.stringify(blank)} must fail`);
    }

    // Server mode, secret present and long enough: no error.
    process.env.SWARM_SESSION_SECRET = LONG_TEST_SECRET;
    assert.equal(serverModeSecretError(), null);

    // Local mode never needs a secret, even when it is missing.
    process.env.SWARM_SERVER_MODE = "0";
    delete process.env.SWARM_SESSION_SECRET;
    assert.equal(serverModeSecretError(), null);
    delete process.env.SWARM_SERVER_MODE;
    assert.equal(serverModeSecretError(), null);
  } finally {
    if (previous.mode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.SWARM_SESSION_SECRET;
    else process.env.SWARM_SESSION_SECRET = previous.secret;
  }
});

test("serverModeSecretError: server mode rejects a short or zero-entropy secret", () => {
  const previous = {
    mode: process.env.SWARM_SERVER_MODE,
    secret: process.env.SWARM_SESSION_SECRET,
  };
  try {
    process.env.SWARM_SERVER_MODE = "1";
    // Short secrets (including the old "test-secret" fixture) fail boot:
    // the HMAC key for every session cookie must be at least 32 chars.
    for (const short of ["test-secret", "x".repeat(31)]) {
      process.env.SWARM_SESSION_SECRET = short;
      const err = serverModeSecretError();
      assert.ok(err, `short secret ${JSON.stringify(short)} must fail boot`);
      assert.ok(err?.includes("too short"), `error must say too short: ${err}`);
    }
    // A long secret made of one repeated character has no entropy.
    process.env.SWARM_SESSION_SECRET = "a".repeat(64);
    const uniform = serverModeSecretError();
    assert.ok(uniform, "uniform secret must fail boot");
    assert.ok(uniform?.includes("no entropy"), `error must say no entropy: ${uniform}`);
    // Exactly 32 varied characters is the minimum and passes.
    process.env.SWARM_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    assert.equal(serverModeSecretError(), null);
    // Local mode never validates the secret, even a short one.
    process.env.SWARM_SERVER_MODE = "0";
    process.env.SWARM_SESSION_SECRET = "test-secret";
    assert.equal(serverModeSecretError(), null);
  } finally {
    if (previous.mode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.SWARM_SESSION_SECRET;
    else process.env.SWARM_SESSION_SECRET = previous.secret;
  }
});

test("hostAllowed: server mode denies by default when SWARM_ALLOWED_HOSTS is unset", () => {
  const previous = {
    mode: process.env.SWARM_SERVER_MODE,
    allowed: process.env.SWARM_ALLOWED_HOSTS,
  };
  try {
    process.env.SWARM_SERVER_MODE = "1";
    delete process.env.SWARM_ALLOWED_HOSTS;
    // Unset no longer means allow-all: every Host is refused until the
    // operator names the deployment's hosts.
    assert.equal(hostAllowed(req({ host: "swarm.example.com" })), false);
    assert.equal(hostAllowed(req({ host: "127.0.0.1" })), false);
    process.env.SWARM_ALLOWED_HOSTS = "swarm.example.com";
    assert.equal(hostAllowed(req({ host: "swarm.example.com" })), true);
    assert.equal(hostAllowed(req({ host: "evil.example.com" })), false);
  } finally {
    if (previous.mode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = previous.mode;
    if (previous.allowed === undefined) delete process.env.SWARM_ALLOWED_HOSTS;
    else process.env.SWARM_ALLOWED_HOSTS = previous.allowed;
  }
});

test("assertServerModeSecret throws in server mode without a secret and passes otherwise", () => {
  const previous = {
    mode: process.env.SWARM_SERVER_MODE,
    secret: process.env.SWARM_SESSION_SECRET,
  };
  try {
    process.env.SWARM_SERVER_MODE = "1";
    delete process.env.SWARM_SESSION_SECRET;
    assert.throws(() => assertServerModeSecret(), /SWARM_SESSION_SECRET/);
    process.env.SWARM_SESSION_SECRET = LONG_TEST_SECRET;
    assert.doesNotThrow(() => assertServerModeSecret());
    process.env.SWARM_SERVER_MODE = "0";
    delete process.env.SWARM_SESSION_SECRET;
    assert.doesNotThrow(() => assertServerModeSecret());
  } finally {
    if (previous.mode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.SWARM_SESSION_SECRET;
    else process.env.SWARM_SESSION_SECRET = previous.secret;
  }
});

test("USER_HEADER is set", () => {
  assert.equal(USER_HEADER, "x-swarm-user");
  assert.equal(serverMode(), process.env.SWARM_SERVER_MODE === "1");
});

test("verifySession round-trips signSession and rejects tampering", () => {
  process.env.SWARM_SESSION_SECRET = "test-secret";
  const token = signSession("alice");
  assert.equal(verifySession(token), "alice");
  assert.equal(verifySession(token + "x"), null);
  assert.equal(verifySession("alice."), null);
  assert.equal(verifySession(""), null);
  assert.equal(verifySession("no-dot"), null);
});

test("signSession throws when SWARM_SESSION_SECRET is unset or blank", () => {
  const previous = process.env.SWARM_SESSION_SECRET;
  try {
    delete process.env.SWARM_SESSION_SECRET;
    assert.throws(() => signSession("alice"), /SWARM_SESSION_SECRET/);
    process.env.SWARM_SESSION_SECRET = "";
    assert.throws(() => signSession("alice"), /SWARM_SESSION_SECRET/);
    process.env.SWARM_SESSION_SECRET = "   ";
    assert.throws(() => signSession("alice"), /SWARM_SESSION_SECRET/);
  } finally {
    if (previous === undefined) delete process.env.SWARM_SESSION_SECRET;
    else process.env.SWARM_SESSION_SECRET = previous;
  }
});

test("verifySession returns null without SWARM_SESSION_SECRET", () => {
  delete process.env.SWARM_SESSION_SECRET;
  assert.equal(verifySession("v2.alice.123.deadbeef"), null);
});

test("requestHostname normalizes trailing dots and validates numeric ports", () => {
  // Trailing dots are stripped from the hostname part, in both plain hosts
  // and hosts with a port.
  assert.equal(requestHostname(req({ host: "example.com." })), "example.com");
  assert.equal(requestHostname(req({ host: "example.com.." })), "example.com");
  assert.equal(requestHostname(req({ host: "EXAMPLE.COM.:443" })), "example.com");
  assert.equal(requestHostname(req({ host: "swarm.example.com." })), "swarm.example.com");

  // Valid ports are accepted; the hostname is what comes back.
  assert.equal(requestHostname(req({ host: "example.com:1" })), "example.com");
  assert.equal(requestHostname(req({ host: "example.com:443" })), "example.com");
  assert.equal(requestHostname(req({ host: "example.com:65535" })), "example.com");

  // Invalid numeric ports are rejected outright.
  for (const host of [
    "example.com:0",
    "example.com:65536",
    "example.com:99999",
    "example.com:abc",
    "example.com:80a",
    "example.com:",
    "example.com:1:2",
    ":3777",
    "example.com..:3777.x",
  ]) {
    assert.equal(requestHostname(req({ host })), null, `${host} must be rejected`);
  }

  // IPv6 literals keep their brackets and take the same port rules.
  assert.equal(requestHostname(req({ host: "[::1]" })), "[::1]");
  assert.equal(requestHostname(req({ host: "[::1]:3777" })), "[::1]");
  assert.equal(requestHostname(req({ host: "[::1]:abc" })), null);
  assert.equal(requestHostname(req({ host: "[::1]:65536" })), null);
  assert.equal(requestHostname(req({ host: "[::1" })), null);

  // A host that is only dots is malformed rather than empty.
  assert.equal(requestHostname(req({ host: "..." })), null);
  // A genuinely missing Host header stays "" (the loopback convention).
  assert.equal(requestHostname(req({})), "");
});

test("hostAllowed matches a trailing-dot FQDN against the allowlist", () => {
  const previous = {
    mode: process.env.SWARM_SERVER_MODE,
    allowed: process.env.SWARM_ALLOWED_HOSTS,
  };
  try {
    process.env.SWARM_SERVER_MODE = "1";
    process.env.SWARM_ALLOWED_HOSTS = "swarm.example.com";
    assert.equal(hostAllowed(req({ host: "swarm.example.com" })), true);
    // The FQDN trailing dot used to fall off the allowlist match.
    assert.equal(hostAllowed(req({ host: "swarm.example.com." })), true);
    assert.equal(hostAllowed(req({ host: "swarm.example.com.:443" })), true);
    assert.equal(hostAllowed(req({ host: "evil.example.com." })), false);
  } finally {
    if (previous.mode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = previous.mode;
    if (previous.allowed === undefined) delete process.env.SWARM_ALLOWED_HOSTS;
    else process.env.SWARM_ALLOWED_HOSTS = previous.allowed;
  }
});

test("isAllowed refuses an invalid numeric port instead of crashing", () => {
  process.env.SWARM_SERVER_MODE = "0";
  assert.equal(isAllowed(req({ host: "127.0.0.1:abc" })), false);
  assert.equal(isAllowed(req({ host: "127.0.0.1:65536" })), false);
  assert.equal(isAllowed(req({ host: "127.0.0.1:3777" })), true);
});

test("sessionCookieOptions default to HttpOnly+Secure+SameSite=Lax, overridable for plain HTTP", () => {
  delete process.env.SWARM_COOKIE_SECURE;
  assert.deepEqual(sessionCookieOptions(), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: sessionMaxAgeSec(),
  });
  process.env.SWARM_COOKIE_SECURE = "0";
  assert.equal(sessionCookieOptions().secure, false);
  process.env.SWARM_COOKIE_SECURE = "false";
  assert.equal(sessionCookieOptions().secure, false);
  delete process.env.SWARM_COOKIE_SECURE;
});

test("safeNextPath only allows same-origin absolute paths", () => {
  assert.equal(safeNextPath("/runs"), "/runs");
  assert.equal(safeNextPath("/runs?tab=log&x=1"), "/runs?tab=log&x=1");
  assert.equal(safeNextPath(" /runs "), "/runs");
  assert.equal(safeNextPath("/"), "/");
  assert.equal(safeNextPath(undefined), "/");
  assert.equal(safeNextPath(""), "/");
  assert.equal(safeNextPath("//evil.example.com"), "/");
  assert.equal(safeNextPath("https://evil.example.com"), "/");
  assert.equal(safeNextPath("javascript:alert(1)"), "/");
  assert.equal(safeNextPath("\\evil.example.com"), "/");
  assert.equal(safeNextPath("/\\evil.example.com"), "/");
  assert.equal(safeNextPath("\nLocation: https://evil.example.com"), "/");
  assert.equal(safeNextPath("/x".repeat(3000)), "/");
  assert.equal(safeNextPath(42), "/");
  assert.equal(safeNextPath({ toString: () => "/" }), "/");
});
