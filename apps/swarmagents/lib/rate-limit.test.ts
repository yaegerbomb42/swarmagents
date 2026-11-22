import test from "node:test";
import assert from "node:assert/strict";
import {
  TokenBucket,
  trustProxy,
  clientIp,
  isIpAddress,
  rateLimitKey,
  rateLimitCheck,
  rateLimitResponse,
  checkCompleteRateLimit,
  checkProviderProbeRateLimit,
  resetBuckets,
  resetRateLimitWarnings,
  UNIDENTIFIED_KEY,
} from "./rate-limit.js";
import type { AuthUser } from "./auth.js";

function mockReq(headers: Record<string, string>, ip?: string) {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    ip,
  } as any;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("TokenBucket allows requests within capacity", () => {
  const bucket = new TokenBucket(5, 1_000);
  for (let i = 0; i < 5; i++) {
    const r = bucket.consume("key");
    assert.equal(r.allowed, true);
    assert.equal(r.retryAfter, 0);
  }
});

test("TokenBucket reports remaining tokens and reset seconds", () => {
  const bucket = new TokenBucket(4, 1_000);
  assert.equal(bucket.consume("key").remaining, 3);
  assert.equal(bucket.consume("key").remaining, 2);
  // Reset is seconds until the bucket refills to capacity (2/4 of 1s → 1s).
  assert.equal(bucket.consume("key").remaining, 1);
  assert.equal(bucket.consume("key").reset, 1);
  assert.equal(bucket.consume("key").remaining, 0);
  assert.equal(bucket.consume("key").reset, 1);
});

test("TokenBucket rejects when exhausted", () => {
  const bucket = new TokenBucket(3, 1_000);
  bucket.consume("key");
  bucket.consume("key");
  bucket.consume("key");
  const r = bucket.consume("key");
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfter > 0);
});

test("TokenBucket refills over time", async () => {
  const bucket = new TokenBucket(2, 100);
  bucket.consume("key");
  bucket.consume("key");
  assert.equal(bucket.consume("key").allowed, false);
  await sleep(60);
  assert.equal(bucket.consume("key").allowed, true);
});

test("TokenBucket tracks keys independently", () => {
  const bucket = new TokenBucket(2, 1_000);
  assert.equal(bucket.consume("a").allowed, true);
  assert.equal(bucket.consume("a").allowed, true);
  assert.equal(bucket.consume("a").allowed, false);
  assert.equal(bucket.consume("b").allowed, true);
});

test("trustProxy returns true for 1, true, yes", () => {
  const vals = ["1", "true", "yes"];
  for (const v of vals) {
    process.env.SWARM_TRUST_PROXY = v;
    assert.equal(trustProxy(), true, `expected true for ${v}`);
  }
  delete process.env.SWARM_TRUST_PROXY;
});

test("trustProxy returns false otherwise", () => {
  process.env.SWARM_TRUST_PROXY = "0";
  assert.equal(trustProxy(), false);
  delete process.env.SWARM_TRUST_PROXY;
  assert.equal(trustProxy(), false);
});

test("clientIp trusts X-Forwarded-For with hop counting when SWARM_TRUST_PROXY=1", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  process.env.SWARM_TRUSTED_PROXY_HOPS = "1";
  const req = mockReq({ "x-forwarded-for": "203.0.113.1, 10.0.0.5" });
  assert.equal(clientIp(req), "203.0.113.1");
  delete process.env.SWARM_TRUST_PROXY;
  delete process.env.SWARM_TRUSTED_PROXY_HOPS;
});

test("clientIp uses configured trusted proxy hops from rightmost", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  process.env.SWARM_TRUSTED_PROXY_HOPS = "2";
  const req = mockReq({ "x-forwarded-for": "198.51.100.7, 203.0.113.1, 10.0.0.5" });
  assert.equal(clientIp(req), "198.51.100.7");
  delete process.env.SWARM_TRUST_PROXY;
  delete process.env.SWARM_TRUSTED_PROXY_HOPS;
});

test("clientIp falls back to X-Real-IP when proxy trusted and no XFF", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  const req = mockReq({ "x-real-ip": "198.51.100.9" });
  assert.equal(clientIp(req), "198.51.100.9");
  delete process.env.SWARM_TRUST_PROXY;
});

test("clientIp ignores X-Forwarded-For when SWARM_TRUST_PROXY is not set", () => {
  delete process.env.SWARM_TRUST_PROXY;
  const req = mockReq({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "10.0.0.1" });
  assert.equal(clientIp(req), "10.0.0.1");
});

test("clientIp uses peer/proxy-set X-Real-IP when SWARM_TRUST_PROXY is off", () => {
  delete process.env.SWARM_TRUST_PROXY;
  const req = mockReq({ "x-real-ip": "192.0.2.55" }, "10.0.0.1");
  assert.equal(clientIp(req), "192.0.2.55");
});

test("clientIp falls back to req.ip when proxy not trusted", () => {
  delete process.env.SWARM_TRUST_PROXY;
  const req = mockReq({}, "192.168.1.1");
  assert.equal(clientIp(req), "192.168.1.1");
});

test("clientIp returns null when no identity can be established", () => {
  delete process.env.SWARM_TRUST_PROXY;
  const req = mockReq({});
  assert.equal(clientIp(req), null);
});

test("clientIp rejects placeholder identities so clients never share one key", () => {
  delete process.env.SWARM_TRUST_PROXY;
  assert.equal(clientIp(mockReq({ "x-real-ip": "unknown" })), null);
  assert.equal(clientIp(mockReq({ "x-real-ip": "-" })), null);
  assert.equal(clientIp(mockReq({ "x-real-ip": "999.1.1.1" })), null);
  assert.equal(clientIp(mockReq({ "x-real-ip": "not an ip" })), null);
});

test("clientIp ignores a spoofed X-Forwarded-For even when proxy trust is on but the address is bogus", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  delete process.env.SWARM_TRUSTED_PROXY_HOPS;
  const req = mockReq({ "x-forwarded-for": "unknown", "x-real-ip": "203.0.113.4" });
  assert.equal(clientIp(req), "203.0.113.4");
  delete process.env.SWARM_TRUST_PROXY;
});

test("isIpAddress accepts IPv4 and IPv6 literals only", () => {
  assert.equal(isIpAddress("203.0.113.7"), true);
  assert.equal(isIpAddress("::1"), true);
  assert.equal(isIpAddress("::ffff:203.0.113.7"), true);
  assert.equal(isIpAddress("2001:db8::1"), true);
  assert.equal(isIpAddress("unknown"), false);
  assert.equal(isIpAddress(""), false);
  assert.equal(isIpAddress(null), false);
  assert.equal(isIpAddress("203.0.113.300"), false);
});

test("rateLimitKey uses user id when authenticated", () => {
  const user: AuthUser = { id: "alice" };
  const req = mockReq({});
  assert.equal(rateLimitKey(req, user), "user:alice");
});

test("rateLimitKey uses ip when unauthenticated and identity available", () => {
  delete process.env.SWARM_TRUST_PROXY;
  const req = mockReq({ "x-real-ip": "10.0.0.1" });
  assert.equal(rateLimitKey(req, null), "ip:10.0.0.1");
});

test("two anonymous clients with different addresses get independent login buckets", () => {
  resetBuckets();
  resetRateLimitWarnings();
  delete process.env.SWARM_TRUST_PROXY;
  const a = mockReq({ "x-real-ip": "203.0.113.10" });
  const b = mockReq({ "x-real-ip": "203.0.113.11" });
  for (let i = 0; i < 5; i++) {
    assert.equal(rateLimitCheck("/api/login", rateLimitKey(a, null))!.allowed, true);
    assert.equal(rateLimitCheck("/api/login", rateLimitKey(b, null))!.allowed, true);
  }
  assert.equal(rateLimitCheck("/api/login", rateLimitKey(a, null))!.allowed, false);
  assert.equal(rateLimitCheck("/api/login", rateLimitKey(b, null))!.allowed, false);
});

test("spoofed XFF is ignored when trust is off", () => {
  delete process.env.SWARM_TRUST_PROXY;
  resetBuckets();
  resetRateLimitWarnings();
  const req = mockReq({ "x-forwarded-for": "198.51.100.99", "x-real-ip": "10.0.0.7" });
  assert.equal(rateLimitKey(req, null), "ip:10.0.0.7");
});

test("warning emitted once when no identity and strict mode used", () => {
  delete process.env.SWARM_TRUST_PROXY;
  resetBuckets();
  resetRateLimitWarnings();
  const warnings: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const req = mockReq({});
    const k1 = rateLimitKey(req, null);
    const k2 = rateLimitKey(req, null);
    assert.equal(k1, UNIDENTIFIED_KEY);
    assert.equal(k2, UNIDENTIFIED_KEY);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /no client identity/i);
  } finally {
    console.warn = orig;
  }
});

test("unidentified clients use the strict bucket, never the shared app-wide bucket", () => {
  delete process.env.SWARM_TRUST_PROXY;
  resetBuckets();
  resetRateLimitWarnings();
  const req = mockReq({});
  const key = rateLimitKey(req, null);
  assert.equal(key, UNIDENTIFIED_KEY);
  // The strict bucket is far smaller than the 300/min app-wide bucket.
  let last = rateLimitCheck("/api/runtime/tasks", key)!;
  for (let i = 0; i < 20; i++) last = rateLimitCheck("/api/runtime/tasks", key)!;
  assert.equal(last.allowed, false);
  assert.ok(last.limit < 300, `strict bucket must be tighter than the app-wide bucket, got ${last.limit}`);
  // The identified app-wide bucket is untouched by unidentified traffic.
  const identified = rateLimitCheck("/api/runtime/tasks", "ip:203.0.113.20")!;
  assert.equal(identified.allowed, true);
  assert.equal(identified.limit, 300);
});

test("rateLimitCheck returns null for non-api paths", () => {
  assert.equal(rateLimitCheck("/login", "key"), null);
  assert.equal(rateLimitCheck("/", "key"), null);
});

test("rateLimitCheck applies stricter login bucket for /api/login", () => {
  resetBuckets();
  const key = "test-login-" + Date.now();
  for (let i = 0; i < 5; i++) {
    const r = rateLimitCheck("/api/login", key);
    assert.ok(r);
    assert.equal(r!.allowed, true);
  }
  const r = rateLimitCheck("/api/login", key);
  assert.ok(r);
  assert.equal(r!.allowed, false);
  assert.ok(r!.retryAfter > 0);
});

test("rateLimitCheck applies api bucket for other api routes", () => {
  resetBuckets();
  const key = "test-api-" + Date.now();
  for (let i = 0; i < 300; i++) {
    const r = rateLimitCheck("/api/runtime/tasks", key);
    assert.ok(r);
    assert.equal(r!.allowed, true);
  }
  const r = rateLimitCheck("/api/runtime/tasks", key);
  assert.ok(r);
  assert.equal(r!.allowed, false);
  assert.ok(r!.retryAfter > 0);
});

test("rateLimitCheck applies the stricter signup bucket for /api/signup", () => {
  resetBuckets();
  const key = "test-signup-" + Date.now();
  for (let i = 0; i < 5; i++) {
    const r = rateLimitCheck("/api/signup", key);
    assert.ok(r);
    assert.equal(r!.allowed, true, `signup attempt ${i + 1} should be allowed`);
    assert.equal(r!.limit, 5);
  }
  const r = rateLimitCheck("/api/signup", key);
  assert.ok(r);
  assert.equal(r!.allowed, false);
  assert.equal(r!.limit, 5);
  assert.ok(r!.retryAfter > 0);

  // Signup and login budgets are independent: exhausting signups must not
  // throttle a sign-in, even for the same client identity.
  assert.equal(rateLimitCheck("/api/login", key)!.allowed, true);
});

test("signup buckets are per client identity", () => {
  resetBuckets();
  for (let i = 0; i < 5; i++) assert.equal(rateLimitCheck("/api/signup", "ip:203.0.113.31")!.allowed, true);
  assert.equal(rateLimitCheck("/api/signup", "ip:203.0.113.31")!.allowed, false);
  // A different client still has its full budget.
  assert.equal(rateLimitCheck("/api/signup", "ip:203.0.113.32")!.allowed, true);
});

test("rateLimitResponse returns 429 with Retry-After and rate-limit headers", () => {
  const res = rateLimitResponse({ allowed: false, retryAfter: 42, limit: 300, remaining: 0, reset: 60 });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "42");
  assert.equal(res.headers.get("X-RateLimit-Limit"), "300");
  assert.equal(res.headers.get("X-RateLimit-Remaining"), "0");
  assert.equal(res.headers.get("X-RateLimit-Reset"), "60");
});

test("rateLimitCheck reports limit/remaining/reset for the matching bucket", () => {
  resetBuckets();
  const key = "test-report-" + Date.now();
  const r = rateLimitCheck("/api/runtime/tasks", key);
  assert.ok(r);
  assert.equal(r!.allowed, true);
  assert.equal(r!.limit, 300);
  assert.equal(r!.remaining, 299);
  assert.ok(r!.reset >= 0);
});

test("rateLimitCheck gives the swarm board its own larger bucket and exempts /api/health", () => {
  resetBuckets();
  const key = "test-board-" + Date.now();
  for (let i = 0; i < 1200; i++) assert.equal(rateLimitCheck("/api/mcp/swarm-board", key)!.allowed, true);
  assert.equal(rateLimitCheck("/api/mcp/swarm-board", key)!.allowed, false);
  assert.equal(rateLimitCheck("/api/health", key), null);
});

test("rateLimitCheck throttles public share pages with their own bucket", () => {
  resetBuckets();
  const key = "test-share-" + Date.now();
  const first = rateLimitCheck("/share/" + "a".repeat(48), key);
  assert.ok(first);
  assert.equal(first!.allowed, true);
  assert.equal(first!.limit, 60);
  // The share bucket is its own: the general API bucket is untouched.
  for (let i = 0; i < first!.limit - 1; i++) {
    assert.equal(rateLimitCheck("/share/" + "a".repeat(48), key)!.allowed, true);
  }
  const blocked = rateLimitCheck("/share/" + "a".repeat(48), key);
  assert.ok(blocked);
  assert.equal(blocked!.allowed, false);
  assert.ok(blocked!.retryAfter > 0);
  // Another IP still gets its own budget.
  assert.equal(rateLimitCheck("/share/" + "a".repeat(48), "other-key")!.allowed, true);
});

test("checkCompleteRateLimit allows 60/min per user, independently", () => {
  resetBuckets();
  for (let i = 0; i < 60; i++) {
    assert.equal(checkCompleteRateLimit("alice").allowed, true);
  }
  const denied = checkCompleteRateLimit("alice");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfter > 0);
  assert.equal(checkCompleteRateLimit("bob").allowed, true, "budgets are per user");
});

test("checkProviderProbeRateLimit allows 30/min per user, independently", () => {
  resetBuckets();
  for (let i = 0; i < 30; i++) {
    assert.equal(checkProviderProbeRateLimit("alice").allowed, true);
  }
  const denied = checkProviderProbeRateLimit("alice");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfter > 0);
  assert.equal(checkProviderProbeRateLimit("bob").allowed, true, "budgets are per user");
});

test("rateLimitCheck gives password-reset endpoints their own strict bucket (FIX-39)", () => {
  resetBuckets();
  const key = "test-reset-" + Date.now();
  const first = rateLimitCheck("/api/password-reset/request", key);
  assert.ok(first);
  assert.equal(first!.allowed, true);
  assert.equal(first!.limit, 5, "reset requests get the login-class budget, not the general 300/min");

  // Request and confirm share the reset bucket...
  for (let i = 0; i < 4; i++) {
    assert.equal(rateLimitCheck("/api/password-reset/confirm", key)!.allowed, true);
  }
  const blocked = rateLimitCheck("/api/password-reset/request", key);
  assert.ok(blocked);
  assert.equal(blocked!.allowed, false);
  assert.ok(blocked!.retryAfter > 0);

  // ...but the login bucket and the general API bucket are untouched.
  assert.equal(rateLimitCheck("/api/login", key)!.allowed, true);
  assert.equal(rateLimitCheck("/api/runtime/tasks", key)!.allowed, true);
  // Another identity still gets its own reset budget.
  assert.equal(rateLimitCheck("/api/password-reset/request", "other-key")!.allowed, true);
});

test("rateLimitCheck routes email-verification endpoints into the strict reset bucket (FIX-44)", () => {
  resetBuckets();
  const key = "test-verify-" + Date.now();
  // Confirm + resend share the password-reset bucket's 5/min budget.
  for (let i = 0; i < 5; i++) {
    const path = i % 2 === 0 ? "/api/email-verification/confirm" : "/api/email-verification/resend";
    assert.equal(rateLimitCheck(path, key)!.allowed, true, `attempt ${i + 1} should be allowed`);
  }
  const blocked = rateLimitCheck("/api/email-verification/confirm", key);
  assert.ok(blocked);
  assert.equal(blocked!.allowed, false);
  assert.ok(blocked!.retryAfter > 0);
  // The reset endpoints share the same (now exhausted) budget...
  assert.equal(rateLimitCheck("/api/password-reset/request", key)!.allowed, false);
  // ...while another identity is unaffected.
  assert.equal(rateLimitCheck("/api/email-verification/resend", "other-key")!.allowed, true);
});
