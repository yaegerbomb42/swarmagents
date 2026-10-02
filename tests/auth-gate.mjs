// Auth-gate regression tests (lane G3). Pure-node, no server boot:
// exercises lib/auth.ts — the single gate behind middleware.ts and the upload route.
// Run: node --experimental-strip-types tests/auth-gate.mjs
import {
  AUTH_COOKIE,
  authEnabled,
  checkToken,
  clientIp,
  hostAllowed,
  isAllowed,
  isAuthorized,
  misconfigured,
  serverMode,
} from "../lib/auth.ts";

let pass = 0,
  fail = 0;
const ok = (cond, name) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name}`);
  }
};
// Minimal Request surface: only headers.get is used.
const req = (headers = {}) =>
  new Request("http://x/", { headers: new Headers(headers) });
const withHost = (host, extra = {}) => req({ host, ...extra });

function resetEnv() {
  delete process.env.SWARM_AUTH_TOKEN;
  delete process.env.SWARM_MODE;
  delete process.env.SWARM_ALLOWED_HOSTS;
}

// ---- Local mode (no token): locality is the whole gate ----
resetEnv();
ok(!authEnabled(), "local: auth disabled without token");
ok(!serverMode(), "local: not server mode");
ok(!misconfigured(), "local: not misconfigured");
ok(isAllowed(withHost("127.0.0.1:3777")), "local: 127.0.0.1 allowed");
ok(isAllowed(withHost("localhost:3777")), "local: localhost allowed");
ok(!isAllowed(withHost("evil.com")), "local: foreign host rejected");
ok(
  !isAllowed(withHost("127.0.0.1:3777", { origin: "http://evil.com" })),
  "local: cross-origin page rejected (CSRF/rebinding)",
);
ok(
  isAllowed(withHost("127.0.0.1:3777", { origin: "http://127.0.0.1:3777" })),
  "local: same-origin page allowed",
);

// ---- Server mode, no token: fail closed ----
resetEnv();
process.env.SWARM_MODE = "server";
ok(misconfigured(), "misconfigured: server without token");
ok(!isAllowed(withHost("127.0.0.1:3400")), "misconfigured: nothing allowed");

// ---- Server mode with token: token is everything, locality grants nothing ----
resetEnv();
process.env.SWARM_MODE = "server";
process.env.SWARM_AUTH_TOKEN = "owner-secret";
ok(authEnabled(), "server: auth enabled with token");
ok(!misconfigured(), "server: configured with token");
const bearer = withHost("swarmagents.codes", {
  authorization: "Bearer owner-secret",
});
ok(isAllowed(bearer), "server: correct Bearer allowed");
ok(
  !isAllowed(withHost("swarmagents.codes")),
  "server: anonymous rejected",
);
ok(
  !isAllowed(
    withHost("swarmagents.codes", { authorization: "Bearer wrong" }),
  ),
  "server: wrong token rejected",
);
ok(
  !isAllowed(withHost("127.0.0.1:3400")),
  "server: locality without token grants nothing",
);
ok(
  isAllowed(withHost("127.0.0.1:3400", { authorization: "Bearer owner-secret" })),
  "server: Bearer works even locally (healthchecks use /login instead)",
);
ok(
  isAllowed(
    withHost("h", { cookie: `${AUTH_COOKIE}=owner-secret` }),
  ),
  "server: auth cookie allowed (browser UI + SSE)",
);
ok(
  !isAllowed(
    withHost("swarmagents.codes", {
      authorization: "Bearer owner-secret",
      origin: "http://evil.com",
    }),
  ),
  "server: cross-origin Bearer rejected",
);
ok(checkToken("owner-secret"), "checkToken: exact match");
ok(!checkToken("owner-secre"), "checkToken: length mismatch rejected");
ok(!checkToken(""), "checkToken: empty rejected");

// ---- Host allowlist ----
resetEnv();
process.env.SWARM_ALLOWED_HOSTS = "swarmagents.codes";
ok(hostAllowed(withHost("swarmagents.codes")), "allowlist: listed host passes");
ok(
  hostAllowed(withHost("swarmagents.codes:8085")),
  "allowlist: port stripped before match",
);
ok(!hostAllowed(withHost("evil.com")), "allowlist: unlisted host blocked");
ok(
  !isAllowed(
    withHost("evil.com", { authorization: "Bearer owner-secret" }),
  ),
  "allowlist: token does not override host block",
);

// ---- clientIp: only the trusted tail of XFF is infrastructure-written ----
{
  delete process.env.SWARM_TRUSTED_PROXY_HOPS;
  ok(
    clientIp(req({ "x-forwarded-for": "1.2.3.4" })) === "1.2.3.4",
    "clientIp: single hop returns the client",
  );
  ok(
    clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" })) === "1.2.3.4",
    "clientIp: forged left entries ignored, rightmost kept",
  );
  ok(
    clientIp(req({ "x-forwarded-for": "9.9.9.9" })) === "9.9.9.9",
    "clientIp: lone entry is the client, not 'local'",
  );
  ok(
    clientIp(req({ "x-real-ip": "5.6.7.8" })) === "5.6.7.8",
    "clientIp: falls back to x-real-ip without XFF",
  );
  ok(clientIp(req()) === "local", "clientIp: falls back to 'local'");
  process.env.SWARM_TRUSTED_PROXY_HOPS = "2";
  ok(
    clientIp(req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4, 10.0.0.1" })) === "1.2.3.4",
    "clientIp: 2 hops takes second from right",
  );
  ok(
    clientIp(req({ "x-forwarded-for": "1.2.3.4" })) === "local",
    "clientIp: too-short XFF is untrusted, falls back",
  );
  delete process.env.SWARM_TRUSTED_PROXY_HOPS;

  // ---- hash-only server token ----
  resetEnv();
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update("owner-secret").digest("hex");
  process.env.SWARM_MODE = "server";
  process.env.SWARM_AUTH_TOKEN_SHA256 = digest;
  ok(authEnabled(), "sha256: auth enabled by digest env");
  ok(checkToken("owner-secret"), "sha256: correct token verifies");
  ok(!checkToken("wrong"), "sha256: wrong token rejected");
  resetEnv();
}

console.log(`\nauth-gate: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
