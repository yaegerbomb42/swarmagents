import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { SESSION_COOKIE, signSession } from "./auth";
import { resetBuckets } from "./rate-limit";

function req(url: string, headers: Record<string, string> = {}, method = "GET"): NextRequest {
  return new NextRequest(url, { headers, method });
}

/** Signed session cookie for "alice"; must be minted after beforeEach sets SWARM_SESSION_SECRET. */
function cookie(): string {
  return `${SESSION_COOKIE}=${signSession("alice")}`;
}

const HARNESS = "Bearer harness-token";
const STATE_CHANGING = ["POST", "PUT", "PATCH", "DELETE"];

test.beforeEach(() => {
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_ALLOWED_HOSTS = "swarm.example.com";
  process.env.SWARM_HARNESS_TOKEN = "harness-token";
  process.env.SWARM_SESSION_SECRET = "test-session-secret";
  resetBuckets();
});

test.afterEach(() => {
  delete process.env.SWARM_SERVER_MODE;
  delete process.env.SWARM_ALLOWED_HOSTS;
  delete process.env.SWARM_HARNESS_TOKEN;
  delete process.env.SWARM_SESSION_SECRET;
  delete process.env.SWARM_ALLOW_GUEST_UI;
  resetBuckets();
});

test("redirects unauthenticated document navigations to /login with the target as next", () => {
  const res = middleware(req("http://swarm.example.com/runs?tab=log", { host: "swarm.example.com" }));
  assert.equal(res.status, 303);
  const loc = res.headers.get("location") ?? "";
  assert.ok(loc.startsWith("http://swarm.example.com/login?next="), `unexpected location: ${loc}`);
  assert.equal(new URL(loc).searchParams.get("next"), "/runs?tab=log");
});

test("returns 401 JSON for unauthenticated API calls instead of redirecting", async () => {
  const res = middleware(req("http://swarm.example.com/api/providers/health", { host: "swarm.example.com" }));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Sign in required." });
});

test("passes authenticated requests through with a valid session cookie", () => {
  const res = middleware(req("http://swarm.example.com/app", { host: "swarm.example.com", cookie: cookie() }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null, "authenticated requests must not redirect");
});

test("rejects cross-site state-changing API requests with 403 JSON", async () => {
  for (const method of STATE_CHANGING) {
    const res = middleware(
      req(
        "http://swarm.example.com/api/providers/health",
        { host: "swarm.example.com", origin: "http://evil.example.com", cookie: cookie() },
        method,
      ),
    );
    assert.equal(res.status, 403, `${method} cross-site must be rejected`);
    assert.deepEqual(await res.json(), { error: "Cross-site request blocked." }, `${method} must return the 403 JSON error`);
  }
});

test("rejects cross-site requests from a same-site subdomain (SameSite=Lax loophole)", async () => {
  // A sibling subdomain is same-site, so SameSite=Lax sends the cookie; only the
  // Origin/Host comparison can tell this request is cross-origin.
  const res = middleware(
    req(
      "http://swarm.example.com/api/providers/health",
      { host: "swarm.example.com", origin: "http://sub.swarm.example.com", cookie: cookie() },
      "POST",
    ),
  );
  assert.equal(res.status, 403);
});

test("allows same-origin state-changing API requests", async () => {
  for (const method of STATE_CHANGING) {
    const res = middleware(
      req(
        "http://swarm.example.com/api/providers/health",
        { host: "swarm.example.com", origin: "http://swarm.example.com", cookie: cookie() },
        method,
      ),
    );
    assert.equal(res.status, 200, `${method} same-origin must pass`);
  }
});

test("rejects cross-site state-changing requests in local mode", () => {
  delete process.env.SWARM_SERVER_MODE;
  delete process.env.SWARM_ALLOWED_HOSTS;
  const res = middleware(
    req(
      "http://127.0.0.1:3777/api/runtime/vm/exec",
      { host: "127.0.0.1:3777", origin: "http://evil.example.com" },
      "POST",
    ),
  );
  assert.equal(res.status, 403);
});

test("rejects origins with a different scheme or port", () => {
  for (const origin of ["https://swarm.example.com", "http://swarm.example.com:444"]) {
    const res = middleware(
      req(
        "http://swarm.example.com/api/runtime/vm/exec",
        { host: "swarm.example.com", origin, cookie: cookie() },
        "POST",
      ),
    );
    assert.equal(res.status, 403, origin);
  }
});

test("allows the forwarded public origin used by a reverse proxy", () => {
  // Only when proxy trust is explicitly enabled: with SWARM_TRUST_PROXY=1
  // the proxy is expected to set x-forwarded-host/proto, so the forwarded
  // origin defines the expected origin.
  process.env.SWARM_TRUST_PROXY = "1";
  try {
    const res = middleware(
      req(
        "http://swarm.example.com/api/runtime/tasks",
        {
          host: "swarm.example.com",
          "x-forwarded-host": "swarm.example.com",
          "x-forwarded-proto": "https",
          origin: "https://swarm.example.com",
          cookie: cookie(),
        },
        "POST",
      ),
    );
    assert.equal(res.status, 200);
  } finally {
    delete process.env.SWARM_TRUST_PROXY;
  }
});

test("ignores a spoofed X-Forwarded-Host when proxy trust is off", () => {
  // Trust is off (the beforeEach default): a malicious page's
  // text/plain POST can carry X-Forwarded-Host: evil.com, but the
  // forwarded headers must not define the expected origin — the direct
  // Host header does, so the evil origin is cross-site and blocked.
  const res = middleware(
    req(
      "http://swarm.example.com/api/runtime/tasks",
      {
        host: "swarm.example.com",
        "x-forwarded-host": "evil.example.com",
        "x-forwarded-proto": "https",
        origin: "https://evil.example.com",
        cookie: cookie(),
      },
      "POST",
    ),
  );
  assert.equal(res.status, 403);
});

test("ignores a forwarded host outside SWARM_ALLOWED_HOSTS even when proxy trust is on", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  try {
    const res = middleware(
      req(
        "http://swarm.example.com/api/runtime/tasks",
        {
          host: "swarm.example.com",
          "x-forwarded-host": "evil.example.com",
          "x-forwarded-proto": "https",
          origin: "https://evil.example.com",
          cookie: cookie(),
        },
        "POST",
      ),
    );
    assert.equal(res.status, 403);
  } finally {
    delete process.env.SWARM_TRUST_PROXY;
  }
});

test("rejects state-changing API requests whose Content-Type is not JSON", async () => {
  // A cross-site simple request (form / text/plain fetch) cannot set
  // application/json, so a non-JSON body is refused even with no Origin
  // header to trip the cross-site gate.
  const json = (ct: string) =>
    middleware(
      req(
        "http://swarm.example.com/api/providers/health",
        { host: "swarm.example.com", cookie: cookie(), "content-type": ct },
        "POST",
      ),
    );
  for (const bad of ["text/plain", "application/x-www-form-urlencoded", "text/html; charset=utf-8"]) {
    const res = json(bad);
    assert.equal(res.status, 415, `${bad} must be rejected`);
    assert.deepEqual(await res.json(), { error: "Content-Type must be application/json." });
  }
  assert.equal(json("application/json").status, 200);
  assert.equal(json("application/json; charset=utf-8").status, 200);
  // Multipart uploads keep working (the file-upload routes).
  assert.equal(json("multipart/form-data; boundary=----x").status, 200);
  // A bodyless state-changing request carries no Content-Type and stays allowed.
  assert.equal(
    middleware(
      req("http://swarm.example.com/api/providers/health", { host: "swarm.example.com", cookie: cookie() }, "POST"),
    ).status,
    200,
  );
});

test("the Content-Type gate does not apply to the swarm-board endpoint", async () => {
  // The board's JSON-RPC clients are gated separately by the Tier 1 board
  // auth (session or harness bearer), so the gate exempts it.
  const res = middleware(
    req(
      "http://swarm.example.com/api/mcp/swarm-board",
      { host: "swarm.example.com", cookie: cookie(), "content-type": "text/plain" },
      "POST",
    ),
  );
  assert.equal(res.status, 200);
});

test("early-bypass routes never forward a client-supplied x-swarm-user header", () => {
  // The LLM proxy and the approval hook return before the auth gate; the
  // forged header must be stripped before those returns. Next surfaces the
  // forwarded request headers as x-middleware-request-*, and the override
  // list is exactly the headers middleware passed on — a surviving forged
  // value would appear in both, so asserting its absence is the regression
  // test (pre-fix, the list contained x-swarm-user).
  for (const path of ["/api/runtime/llm/chat", "/api/runtime/approvals/hook"]) {
    const res = middleware(
      req(`http://swarm.example.com${path}`, { host: "swarm.example.com", "x-swarm-user": "mallory" }, "POST"),
    );
    assert.equal(res.status, 200, `${path} must pass through`);
    const overridden = (res.headers.get("x-middleware-override-headers") ?? "")
      .split(",")
      .map((h) => h.trim());
    assert.ok(!overridden.includes("x-swarm-user"), `${path} must not forward x-swarm-user: ${overridden}`);
    assert.equal(res.headers.get("x-middleware-request-x-swarm-user"), null, `${path} must not forward x-swarm-user`);
  }
});

test("authenticated requests forward the real user id, never a forged one", () => {
  const res = middleware(
    req("http://swarm.example.com/api/providers/health", {
      host: "swarm.example.com",
      cookie: cookie(),
      "x-swarm-user": "mallory",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-middleware-request-x-swarm-user"), "alice");
});

test("allows bearer-authenticated requests without an Origin header", async () => {
  // Server-to-server harness calls carry no Origin; they are exempt from the gate.
  const res = middleware(req("http://swarm.example.com/api/runtime/tasks", { host: "swarm.example.com", authorization: HARNESS }, "POST"));
  assert.equal(res.status, 200);
});

test("does not gate cross-site GET requests", () => {
  const res = middleware(
    req("http://swarm.example.com/api/providers/health", {
      host: "swarm.example.com",
      origin: "http://evil.example.com",
      cookie: cookie(),
    }),
  );
  assert.equal(res.status, 200);
});

test("board endpoint requires auth in server mode: unauthenticated reads and writes get 401", async () => {
  // GET (read-only listing) and POST (writes) both need a session or a
  // harness bearer in server mode; the board is no longer public.
  const get = middleware(req("http://swarm.example.com/api/mcp/swarm-board", { host: "swarm.example.com" }));
  assert.equal(get.status, 401);
  assert.deepEqual(await get.json(), { error: "Sign in required." });
  for (const method of STATE_CHANGING) {
    const res = middleware(
      req("http://swarm.example.com/api/mcp/swarm-board", { host: "swarm.example.com" }, method),
    );
    assert.equal(res.status, 401, `${method} unauthenticated must get 401`);
  }
});

test("board endpoint passes authenticated session and harness-bearer calls", async () => {
  const session = middleware(
    req("http://swarm.example.com/api/mcp/swarm-board", { host: "swarm.example.com", cookie: cookie() }, "POST"),
  );
  assert.equal(session.status, 200);
  const harness = middleware(
    req("http://swarm.example.com/api/mcp/swarm-board", { host: "swarm.example.com", authorization: HARNESS }, "POST"),
  );
  assert.equal(harness.status, 200);
  const read = middleware(req("http://swarm.example.com/api/mcp/swarm-board", { host: "swarm.example.com", cookie: cookie() }));
  assert.equal(read.status, 200);
});

test("board endpoint is no longer exempt from the cross-site gate", async () => {
  // A cross-site state-changing call with a valid session cookie is blocked
  // like every other API route; only harness bearer calls are exempt.
  const res = middleware(
    req(
      "http://swarm.example.com/api/mcp/swarm-board",
      { host: "swarm.example.com", origin: "http://evil.example.com", cookie: cookie() },
      "POST",
    ),
  );
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Cross-site request blocked." });
});

test("board endpoint stays open in local mode (single trusted user on loopback)", () => {
  delete process.env.SWARM_SERVER_MODE;
  delete process.env.SWARM_ALLOWED_HOSTS;
  for (const method of ["GET", ...STATE_CHANGING]) {
    const res = middleware(req("http://127.0.0.1:3777/api/mcp/swarm-board", { host: "127.0.0.1:3777" }, method));
    assert.equal(res.status, 200, `${method} in local mode must pass`);
  }
});

test("rejects non-allowlisted hosts before any auth or redirect logic", () => {
  const res = middleware(req("http://evil.example.com/app", { host: "evil.example.com" }));
  assert.equal(res.status, 403);
});

test("allows the loopback healthcheck through the server-mode host gate", () => {
  // The Docker healthcheck connects to 127.0.0.1, which is not in
  // SWARM_ALLOWED_HOSTS; without this exemption the container reports unhealthy
  // even though the public /api/health endpoint works.
  for (const host of ["127.0.0.1:3777", "localhost:3777", "[::1]:3777"]) {
    const res = middleware(req(`http://${host}/api/health`, { host }));
    assert.equal(res.status, 200, `${host} must reach /api/health`);
  }
});

test("loopback does not bypass the host gate for non-health paths", () => {
  for (const path of ["/app", "/api/providers/health", "/api/health/extra"]) {
    const res = middleware(req(`http://127.0.0.1:3777${path}`, { host: "127.0.0.1:3777" }));
    assert.equal(res.status, 403, `${path} must stay host-gated`);
  }
});

test("the public health probe passes middleware signed out (liveness and readiness)", () => {
  // Deploy checks, uptime monitors and the SiteFooter version fetch hit
  // /api/health without a session, so it must reach the route on the public
  // host: no 303 redirect to /login and no 401 JSON. The query string is not
  // part of the pathname, so the readiness variant (?ready=1) matches the
  // same PUBLIC entry — this host is not loopback, so the PUBLIC set (not the
  // loopback bypass) is what lets the request through.
  for (const url of ["http://swarm.example.com/api/health", "http://swarm.example.com/api/health?ready=1"]) {
    const res = middleware(req(url, { host: "swarm.example.com" }));
    assert.equal(res.status, 200, `${url} must pass middleware unauthenticated`);
    assert.equal(res.headers.get("location"), null, `${url} must not redirect to /login`);
  }
});

test("lookalike health paths stay behind the auth gate", async () => {
  // Only the exact /api/health pathname is public; prefixed variants must
  // still demand a session (401 JSON for API paths, never the route itself).
  for (const path of ["/api/healthz", "/api/health/extra", "/api/health/snapshot"]) {
    const res = middleware(req(`http://swarm.example.com${path}`, { host: "swarm.example.com" }));
    assert.equal(res.status, 401, `${path} must not be public`);
    assert.deepEqual(await res.json(), { error: "Sign in required." });
  }
});

test("redirect origin never follows an untrusted X-Forwarded-Host", () => {
  // Not in the allowlist: ignored, fall back to the Host header.
  let res = middleware(
    req("http://swarm.example.com/run/1", { host: "swarm.example.com", "x-forwarded-host": "evil.example.com" }),
  );
  let loc = res.headers.get("location") ?? "";
  assert.ok(loc.startsWith("http://swarm.example.com/login?next="), `unexpected location: ${loc}`);

  // Malformed (contains path/junk): ignored.
  res = middleware(
    req("http://swarm.example.com/run/1", { host: "swarm.example.com", "x-forwarded-host": "swarm.example.com/@evil" }),
  );
  loc = res.headers.get("location") ?? "";
  assert.ok(loc.startsWith("http://swarm.example.com/login?next="), `unexpected location: ${loc}`);

  // Allowlisted forwarded host is honored (still within the allowlist).
  res = middleware(
    req("http://swarm.example.com/run/1", { host: "swarm.example.com", "x-forwarded-host": "swarm.example.com" }),
  );
  loc = res.headers.get("location") ?? "";
  assert.ok(loc.startsWith("http://swarm.example.com/login?next="), `unexpected location: ${loc}`);
  assert.equal(new URL(loc).hostname, "swarm.example.com");
});

test("the next param derived from a hostile URL stays a same-origin path", () => {
  // A client cannot make middleware embed anything but the request path.
  const res = middleware(
    req("http://swarm.example.com/login?next=https%3A%2F%2Fevil.example.com", { host: "swarm.example.com" }),
  );
  // /login is public, so this should pass through — and the next param is
  // only ever interpreted by the login page/API through safeNextPath.
  assert.equal(res.status, 200);
});

test("allowed API responses carry X-RateLimit-* headers", () => {
  const cookie = `${SESSION_COOKIE}=${signSession("alice")}`;
  const res = middleware(
    req("http://swarm.example.com/api/providers/health", { host: "swarm.example.com", cookie }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-RateLimit-Limit"), "300");
  assert.equal(res.headers.get("X-RateLimit-Remaining"), "299");
  const reset = Number(res.headers.get("X-RateLimit-Reset"));
  assert.ok(Number.isFinite(reset) && reset >= 0, `reset should be a non-negative number, got ${reset}`);
});

test("429 responses carry Retry-After and rate-limit headers (login bucket)", () => {
  let res;
  for (let i = 0; i < 5; i++) {
    res = middleware(req("http://swarm.example.com/api/login", { host: "swarm.example.com", "x-real-ip": "203.0.113.50" }));
    assert.equal(res.status, 200, `attempt ${i + 1} should be allowed`);
  }
  res = middleware(req("http://swarm.example.com/api/login", { host: "swarm.example.com", "x-real-ip": "203.0.113.50" }));
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("Retry-After")) > 0);
  assert.equal(res.headers.get("X-RateLimit-Limit"), "5");
  assert.equal(res.headers.get("X-RateLimit-Remaining"), "0");
  assert.ok(Number(res.headers.get("X-RateLimit-Reset")) >= 0);
});

test("signup has its own strict bucket and 429s after the threshold", () => {
  const signup = () =>
    middleware(req("http://swarm.example.com/api/signup", { host: "swarm.example.com", "x-real-ip": "203.0.113.80" }, "POST"));
  for (let i = 0; i < 5; i++) {
    const res = signup();
    assert.equal(res.status, 200, `signup attempt ${i + 1} should be allowed`);
    assert.equal(res.headers.get("X-RateLimit-Limit"), "5");
  }
  const res = signup();
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("Retry-After")) > 0);
  assert.equal(res.headers.get("X-RateLimit-Remaining"), "0");
  // The login budget for the same identity is untouched.
  assert.equal(
    middleware(req("http://swarm.example.com/api/login", { host: "swarm.example.com", "x-real-ip": "203.0.113.80" }, "POST")).status,
    200,
  );
});

test("two anonymous clients from different addresses have independent login buckets", () => {
  // Client A exhausts its login bucket; client B must not be throttled by it.
  const login = (ip: string) =>
    middleware(req("http://swarm.example.com/api/login", { host: "swarm.example.com", "x-real-ip": ip }, "POST"));
  for (let i = 0; i < 5; i++) {
    assert.equal(login("203.0.113.60").status, 200, `client A attempt ${i + 1} should be allowed`);
  }
  assert.equal(login("203.0.113.60").status, 429, "client A must be throttled");
  assert.equal(login("203.0.113.61").status, 200, "client B must not be throttled by client A");
});

test("a spoofed X-Forwarded-For does not create a fresh bucket while proxy trust is off", () => {
  // Trust is off in this deployment: the client-supplied XFF is ignored, so the
  // bucket is keyed by the proxy-set address and rotating XFF cannot bypass it.
  const login = (xff: string) =>
    middleware(req("http://swarm.example.com/api/login", { host: "swarm.example.com", "x-real-ip": "203.0.113.70", "x-forwarded-for": xff }, "POST"));
  for (let i = 0; i < 5; i++) {
    assert.equal(login(`198.51.100.${i}`).status, 200, `attempt ${i + 1} should be allowed`);
  }
  assert.equal(login("198.51.100.99").status, 429, "rotating XFF must not reset the bucket");
});

test("public share pages are rate limited per IP and answer 429 past the threshold", () => {
  const token = "a".repeat(48);
  const view = () => middleware(req(`http://swarm.example.com/share/${token}`, { host: "swarm.example.com", "x-real-ip": "203.0.113.80" }));
  const first = view();
  assert.equal(first.status, 200, "the first share view is served");
  const limit = Number(first.headers.get("X-RateLimit-Limit"));
  assert.ok(Number.isFinite(limit) && limit > 0, "the share page must advertise its limit");
  assert.equal(limit, 60, "share pages have their own bucket");

  for (let i = 1; i < limit; i++) {
    const res = view();
    assert.equal(res.status, 200, `attempt ${i + 1} should be allowed`);
  }
  const blocked = view();
  assert.equal(blocked.status, 429, "a scanner minting tokens must be throttled");
  assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  assert.equal(blocked.headers.get("X-RateLimit-Remaining"), "0");
});

test("the share rate limit is per IP, so one scanner cannot lock out everyone", () => {
  resetBuckets();
  process.env.SWARM_TRUST_PROXY = "1";
  try {
    const token = "b".repeat(48);
    const limit = Number(
      middleware(
        req(`http://swarm.example.com/share/${token}`, {
          host: "swarm.example.com",
          "x-forwarded-for": "1.2.3.4",
        }),
      ).headers.get("X-RateLimit-Limit"),
    );
    for (let i = 0; i < limit; i++) {
      middleware(
        req(`http://swarm.example.com/share/${token}`, {
          host: "swarm.example.com",
          "x-forwarded-for": "1.2.3.4",
        }),
      );
    }
    const blocked = middleware(
      req(`http://swarm.example.com/share/${token}`, {
        host: "swarm.example.com",
        "x-forwarded-for": "1.2.3.4",
      }),
    );
    assert.equal(blocked.status, 429);
    // A different visitor still has their own budget.
    const other = middleware(
      req(`http://swarm.example.com/share/${token}`, {
        host: "swarm.example.com",
        "x-forwarded-for": "5.6.7.8",
      }),
    );
    assert.equal(other.status, 200);
  } finally {
    delete process.env.SWARM_TRUST_PROXY;
  }

});

test("token-gated preview links are public, share-rate-limited, and same-origin frameable", () => {
  const token = "c".repeat(48);
  const view = () =>
    middleware(
      req(`http://swarm.example.com/preview/share/${token}/3000/`, {
        host: "swarm.example.com",
        "x-real-ip": "203.0.113.81",
      }),
    );
  const first = view();
  assert.equal(first.status, 200, "a share link needs no session");
  assert.equal(first.headers.get("X-RateLimit-Limit"), "60", "preview shares use the share bucket");
  assert.match(first.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  assert.equal(first.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("session preview routes need a session but allow same-origin framing", () => {
  const anon = middleware(
    req("http://swarm.example.com/preview/3000/", { host: "swarm.example.com" }),
  );
  assert.equal(anon.status, 303, "unauthenticated preview navigations go to /login");
  assert.match(anon.headers.get("location") ?? "", /\/login\?next=/);

  const authed = middleware(
    req("http://swarm.example.com/preview/3000/", { host: "swarm.example.com", cookie: cookie() }),
  );
  assert.equal(authed.status, 200);
  assert.match(authed.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  assert.equal(authed.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("non-preview pages keep frame-ancestors 'none'", () => {
  const res = middleware(
    req("http://swarm.example.com/app", { host: "swarm.example.com", cookie: cookie() }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("SWARM_ALLOW_GUEST_UI=1 allows unauthenticated GET / while keeping APIs 401", async () => {
  const prev = process.env.SWARM_ALLOW_GUEST_UI;
  process.env.SWARM_ALLOW_GUEST_UI = "1";
  try {
    const landing = middleware(req("http://swarm.example.com/", { host: "swarm.example.com" }));
    assert.equal(landing.status, 200);

    const api = middleware(req("http://swarm.example.com/api/providers/health", { host: "swarm.example.com" }));
    assert.equal(api.status, 401);
  } finally {
    if (prev === undefined) delete process.env.SWARM_ALLOW_GUEST_UI;
    else process.env.SWARM_ALLOW_GUEST_UI = prev;
  }
});
// Guest-optional landing (v2-worker-5): SWARM_ALLOW_GUEST_UI=1 opens an
// unauthenticated GET / so guests can see the workspace shell. Nothing else
// opens: other pages still redirect, other methods on / still redirect, and
// every /api/* mutation stays 401 without a session.
test("guest flag allows unauthenticated GET /", () => {
  process.env.SWARM_ALLOW_GUEST_UI = "1";
  const res = middleware(req("http://swarm.example.com/", { host: "swarm.example.com" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null, "a guest landing must not redirect to /login");
});

test("guest flag keeps every unauthenticated API mutation at 401", async () => {
  process.env.SWARM_ALLOW_GUEST_UI = "1";
  for (const method of STATE_CHANGING) {
    const res = middleware(
      req("http://swarm.example.com/api/runs", { host: "swarm.example.com" }, method),
    );
    assert.equal(res.status, 401, `${method} /api/runs must stay 401 for a guest`);
    assert.deepEqual(await res.json(), { error: "Sign in required." }, `${method} must return the 401 JSON error`);
  }
});

test("guest flag opens nothing but an exact GET /", () => {
  process.env.SWARM_ALLOW_GUEST_UI = "1";
  const otherPage = middleware(req("http://swarm.example.com/runs", { host: "swarm.example.com" }));
  assert.equal(otherPage.status, 303, "other pages still redirect a guest to /login");
  assert.match(otherPage.headers.get("location") ?? "", /\/login\?next=/);
  const postRoot = middleware(req("http://swarm.example.com/", { host: "swarm.example.com" }, "POST"));
  assert.equal(postRoot.status, 303, "only GET / is opened; POST / still redirects");
});

test("GET / redirects to /login when the guest flag is off", () => {
  const res = middleware(req("http://swarm.example.com/", { host: "swarm.example.com" }));
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location") ?? "", /\/login\?next=%2F/);
});
