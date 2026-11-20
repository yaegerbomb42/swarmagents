import test from "node:test";
import assert from "node:assert/strict";
import { cspValue, securityHeaders, NONCE_HEADER } from "./security-headers.js";

const NONCE = "kFVVvXcoGXzN+lck0ME6Gw==";

function scriptSrc(csp: string): string {
  const directive = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src"));
  assert.ok(directive, "script-src directive must exist");
  return directive!;
}

test("securityHeaders includes every required hardening header", () => {
  const h = securityHeaders(NONCE);
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.equal(h["x-frame-options"], "DENY");
  assert.equal(h["referrer-policy"], "strict-origin-when-cross-origin");
  assert.ok(h["permissions-policy"].length > 0, "Permissions-Policy must be set");
  assert.ok(h["content-security-policy"].includes(`'nonce-${NONCE}'`), "CSP must carry the nonce");
});

test("csp forbids inline scripts except the nonce", () => {
  const csp = cspValue(NONCE);
  const src = scriptSrc(csp);
  assert.ok(src.includes(`'nonce-${NONCE}'`), "nonce source must be present");
  assert.ok(!src.includes("'unsafe-inline'"), "script-src must never allow inline scripts without a nonce");
  assert.ok(!src.includes("'unsafe-eval'"), "eval must not be allowed outside dev");
});

test("csp allows eval in dev so the webpack HMR runtime keeps working", () => {
  const src = scriptSrc(cspValue(NONCE, { dev: true }));
  assert.ok(src.includes("'unsafe-eval'"));
});

test("csp blocks framing, plugins, and base-uri hijacking", () => {
  const csp = cspValue(NONCE);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("preview framing variant allows same-origin framing and nothing else", () => {
  const h = securityHeaders(NONCE, { frameAncestors: "'self'" });
  assert.match(h["content-security-policy"], /frame-ancestors 'self'/);
  assert.equal(h["x-frame-options"], "SAMEORIGIN");
  // The default is untouched by the variant.
  const d = securityHeaders(NONCE);
  assert.match(d["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(d["x-frame-options"], "DENY");
});

test("csp permits the connection types the app needs", () => {
  assert.match(cspValue(NONCE), /connect-src 'self' https: wss: ws:/);
});

test("NONCE_HEADER is the header Next uses for nonce forwarding", () => {
  assert.equal(NONCE_HEADER, "x-nonce");
});
