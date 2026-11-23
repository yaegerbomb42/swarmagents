import test from "node:test";
import assert from "node:assert/strict";
import { isCrossSite } from "./request-policy.js";

/**
 * Minimal NextRequest stand-in: isCrossSite only reads headers and nextUrl.
 * The default URL is the internal proxy-to-app address (http), which is
 * what a TLS-terminating proxy hands the app.
 */
function mockReq(headers: Record<string, string>, url = "http://127.0.0.1:3777/api/login") {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    nextUrl: new URL(url),
  } as any;
}

function clearEnv() {
  delete process.env.SWARM_TRUST_PROXY;
  delete process.env.SWARM_ALLOWED_HOSTS;
}

test("proxied same-site POST passes with trust on and no forwarded host (B12)", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  process.env.SWARM_ALLOWED_HOSTS = "swarmagents.codes";
  // Shipped nginx shape: Host + X-Forwarded-Proto, no X-Forwarded-Host.
  // Browser Origin is https; the internal URL is http.
  const req = mockReq({
    origin: "https://swarmagents.codes",
    host: "swarmagents.codes",
    "x-forwarded-proto": "https",
  });
  assert.equal(isCrossSite(req), false);
  clearEnv();
});

test("proxied same-site POST passes with trust on and a forwarded host", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  process.env.SWARM_ALLOWED_HOSTS = "swarmagents.codes";
  const req = mockReq({
    origin: "https://swarmagents.codes",
    host: "127.0.0.1:3777",
    "x-forwarded-host": "swarmagents.codes",
    "x-forwarded-proto": "https",
  });
  assert.equal(isCrossSite(req), false);
  clearEnv();
});

test("forwarded proto chain uses the first value", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  process.env.SWARM_ALLOWED_HOSTS = "swarmagents.codes";
  const req = mockReq({
    origin: "https://swarmagents.codes",
    host: "swarmagents.codes",
    "x-forwarded-proto": "https, http",
  });
  assert.equal(isCrossSite(req), false);
  clearEnv();
});

test("genuinely cross-site Origin is still blocked with trust on", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  process.env.SWARM_ALLOWED_HOSTS = "swarmagents.codes";
  const req = mockReq({
    origin: "https://evil.example",
    host: "swarmagents.codes",
    "x-forwarded-proto": "https",
  });
  assert.equal(isCrossSite(req), true);
  clearEnv();
});

test("forwarded host outside the allowlist is blocked with trust on", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  process.env.SWARM_ALLOWED_HOSTS = "swarmagents.codes";
  const req = mockReq({
    origin: "https://evil.example",
    host: "swarmagents.codes",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
  });
  assert.equal(isCrossSite(req), true);
  clearEnv();
});

test("invalid forwarded proto falls back to the internal scheme (fail closed)", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  process.env.SWARM_ALLOWED_HOSTS = "swarmagents.codes";
  const req = mockReq({
    origin: "https://swarmagents.codes",
    host: "swarmagents.codes",
    "x-forwarded-proto": "ftp",
  });
  // Falls back to the internal http scheme, so the https Origin mismatches.
  assert.equal(isCrossSite(req), true);
  clearEnv();
});

test("trust off ignores x-forwarded-proto entirely", () => {
  clearEnv();
  const req = mockReq({
    origin: "https://swarmagents.codes",
    host: "swarmagents.codes",
    "x-forwarded-proto": "https",
  });
  // Byte-identical to pre-fix behavior: https Origin vs http expected origin.
  assert.equal(isCrossSite(req), true);
});

test("trust off ignores a spoofed forwarded host", () => {
  clearEnv();
  const req = mockReq({
    origin: "https://evil.example",
    host: "swarmagents.codes",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
  });
  assert.equal(isCrossSite(req), true);
});

test("direct same-site http request is unchanged with trust on", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  const req = mockReq(
    { origin: "http://swarmagents.codes", host: "swarmagents.codes" },
    "http://swarmagents.codes/api/login",
  );
  assert.equal(isCrossSite(req), false);
  clearEnv();
});

test("no Origin header is allowed for non-browser clients", () => {
  process.env.SWARM_TRUST_PROXY = "1";
  const req = mockReq({ host: "swarmagents.codes", "x-forwarded-proto": "https" });
  assert.equal(isCrossSite(req), false);
  clearEnv();
});

test("sec-fetch-site cross-site is blocked without an Origin header", () => {
  clearEnv();
  const req = mockReq({ host: "swarmagents.codes", "sec-fetch-site": "cross-site" });
  assert.equal(isCrossSite(req), true);
});
