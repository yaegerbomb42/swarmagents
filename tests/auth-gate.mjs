// Auth-gate regression tests (lane G3). Pure-node, no server boot.
//
// The gate is now account-based: lib/auth.ts resolves the caller from a session token in the
// users DB (lib/users.ts), gated first by the host allowlist and a same-origin check. The old
// owner-token-era API (authEnabled/checkToken/isAuthorized/misconfigured) is gone; this file was
// rewritten against what lib/auth.ts exports today. checkOwnerToken() still exists for the
// bootstrap/login flow and is covered here.
//
// Run: npx tsx tests/auth-gate.mjs   (npm run test:auth)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Hermetic home so the users DB is never the developer's real one.
process.env.SWARM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-auth-gate-"));

const { AUTH_COOKIE, checkOwnerToken, clientIp, hostAllowed, isAllowed, isLocalRequest, requestUser, sameOrigin, serverMode } =
  await import("../lib/auth.ts");

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) {
    pass++;
    console.log("  ok", name);
  } else {
    fail++;
    console.error("  FAIL:", name);
  }
};

const req = (headers = {}) => new Request("http://x/", { headers: new Headers(headers) });
const withHost = (host, extra = {}) => req({ host, ...extra });

function resetEnv() {
  delete process.env.SWARM_AUTH_TOKEN;
  delete process.env.SWARM_AUTH_TOKEN_SHA256;
  delete process.env.SWARM_MODE;
  delete process.env.SWARM_ALLOWED_HOSTS;
}

// ---- Local mode: locality is the whole gate ----
resetEnv();
ok(!serverMode(), "local: not server mode");
ok(isAllowed(withHost("127.0.0.1:3777")), "local: 127.0.0.1 allowed");
ok(isAllowed(withHost("localhost:3777")), "local: localhost allowed");
ok(!isAllowed(withHost("evil.com")), "local: foreign host rejected");
ok(!isLocalRequest(withHost("127.0.0.1:3777", { origin: "http://evil.com" })), "local: cross-origin page rejected (CSRF/rebinding)");
ok(isLocalRequest(withHost("127.0.0.1:3777", { origin: "http://127.0.0.1:3777" })), "local: same-origin page allowed");

// ---- Server mode, no token: fail closed, locality grants nothing ----
resetEnv();
process.env.SWARM_MODE = "server";
ok(serverMode(), "server: server mode on");
ok(requestUser(withHost("127.0.0.1:3400")) === null, "server: anonymous is nobody");
ok(!isAllowed(withHost("127.0.0.1:3400")), "server: locality without a session grants nothing");
ok(!isAllowed(withHost("swarmagents.codes")), "server: anonymous rejected on a public host");
ok(!isAllowed(withHost("swarmagents.codes", { cookie: `${AUTH_COOKIE}=not-a-real-session` })), "server: unknown session token rejected");
ok(!isAllowed(withHost("swarmagents.codes", { authorization: "Bearer nope" })), "server: unknown bearer rejected");

// ---- Host allowlist ----
resetEnv();
process.env.SWARM_ALLOWED_HOSTS = "swarmagents.codes";
ok(hostAllowed(withHost("swarmagents.codes")), "allowlist: listed host passes");
ok(hostAllowed(withHost("swarmagents.codes:8085")), "allowlist: port stripped before match");
ok(!hostAllowed(withHost("evil.com")), "allowlist: unlisted host blocked");
ok(!isAllowed(withHost("evil.com")), "allowlist: host block wins");
ok(!isAllowed(withHost("evil.com", { authorization: "Bearer owner-secret" })), "allowlist: credentials do not override host block");

// ---- same-origin: a browser Origin must match the host it talks to ----
resetEnv();
ok(sameOrigin(withHost("swarmagents.codes")), "sameOrigin: no Origin (curl/SSE) passes");
ok(sameOrigin(withHost("swarmagents.codes", { origin: "https://swarmagents.codes" })), "sameOrigin: matching Origin passes");
ok(!sameOrigin(withHost("swarmagents.codes", { origin: "http://evil.com" })), "sameOrigin: cross-origin rejected");
ok(sameOrigin(withHost("swarmagents.codes", { origin: "http://swarmagents.codes" })), "sameOrigin: scheme-agnostic host match");

// ---- clientIp: only the trusted tail of XFF is infrastructure-written ----
{
  delete process.env.SWARM_TRUSTED_PROXY_HOPS;
  ok(clientIp(req({ "x-forwarded-for": "1.2.3.4" })) === "1.2.3.4", "clientIp: single hop returns the client");
  ok(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" })) === "1.2.3.4", "clientIp: forged left entries ignored, rightmost kept");
  ok(clientIp(req({ "x-forwarded-for": "9.9.9.9" })) === "9.9.9.9", "clientIp: lone entry is the client, not 'local'");
  ok(clientIp(req({ "x-real-ip": "5.6.7.8" })) === "5.6.7.8", "clientIp: falls back to x-real-ip without XFF");
  ok(clientIp(req()) === "local", "clientIp: falls back to 'local'");
  process.env.SWARM_TRUSTED_PROXY_HOPS = "2";
  ok(clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4, 10.0.0.1" })) === "1.2.3.4", "clientIp: 2 hops takes second from right");
  ok(clientIp(req({ "x-forwarded-for": "1.2.3.4" })) === "local", "clientIp: too-short XFF is untrusted, falls back");
  delete process.env.SWARM_TRUSTED_PROXY_HOPS;
}

// ---- Owner token (bootstrap/login flow): constant-time digest compare ----
{
  resetEnv();
  process.env.SWARM_AUTH_TOKEN = "owner-secret";
  ok(checkOwnerToken("owner-secret"), "ownerToken: exact match");
  ok(!checkOwnerToken("owner-secre"), "ownerToken: length mismatch rejected");
  ok(!checkOwnerToken(""), "ownerToken: empty rejected");
  ok(!checkOwnerToken("wrong"), "ownerToken: wrong rejected");

  resetEnv();
  const { createHash } = await import("node:crypto");
  process.env.SWARM_AUTH_TOKEN_SHA256 = createHash("sha256").update("owner-secret").digest("hex");
  ok(checkOwnerToken("owner-secret"), "ownerToken sha256: correct token verifies");
  ok(!checkOwnerToken("wrong"), "ownerToken sha256: wrong token rejected");
  resetEnv();
}

console.log(`\nauth-gate: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);