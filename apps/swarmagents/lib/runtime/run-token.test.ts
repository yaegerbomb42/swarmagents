/**
 * Unit tests for per-run LLM proxy tokens: scoping to user+run, expiry,
 * revocation, and tamper resistance (lib/runtime/run-token.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  clearRevokedRunTokens,
  isRunTokenRevoked,
  revokeRunToken,
  runTokenTtlSec,
  signRunToken,
  verifyRunToken,
} from "./run-token";

const ENV: Record<string, string | undefined> = { SWARM_SESSION_SECRET: "test-session-secret" };
const USER = "user-1";
const RUN = "run_abc123";

function mint(overrides: { now?: number; ttlSec?: number } = {}): string {
  return signRunToken(USER, RUN, { env: ENV, now: 300, ...overrides });
}

test.afterEach(() => {
  clearRevokedRunTokens();
});

test("signRunToken/verifyRunToken round-trips for the right user+run", () => {
  const token = mint();
  const verified = verifyRunToken(token, { env: ENV, now: 300 });
  assert.deepEqual(verified, { userId: USER, runId: RUN, expiresAt: 300 + 12 * 60 * 60 });
  assert.ok(verified !== null);
});

test("verifyRunToken enforces the expected user scope", () => {
  const token = mint();
  assert.ok(verifyRunToken(token, { env: ENV, userId: USER, now: 300 }), "matching user ok");
  assert.equal(verifyRunToken(token, { env: ENV, userId: "other-user", now: 300 }), null);
});

test("verifyRunToken enforces the expected run scope", () => {
  const token = mint();
  assert.ok(verifyRunToken(token, { env: ENV, runId: RUN, now: 300 }));
  assert.equal(verifyRunToken(token, { env: ENV, runId: "run_other", now: 300 }), null);
});

test("expired tokens are rejected", () => {
  const token = mint({ ttlSec: 60 });
  // 61 seconds after minting (now=300 -> expires 360).
  assert.equal(verifyRunToken(token, { env: ENV, now: 361 }), null);
  // Still valid just before expiry.
  assert.ok(verifyRunToken(token, { env: ENV, now: 359 }));
});

test("revoked tokens are rejected, and revocation is sticky", () => {
  const token = mint();
  assert.ok(verifyRunToken(token, { env: ENV, now: 300 }));
  revokeRunToken(RUN);
  assert.equal(verifyRunToken(token, { env: ENV, now: 300 }), null);
  assert.equal(isRunTokenRevoked(RUN), true);
  // Another run's token is unaffected.
  const other = signRunToken(USER, "run_other", { env: ENV });
  assert.ok(verifyRunToken(other, { env: ENV, now: 300 }));
});

test("tampered tokens are rejected", () => {
  const token = mint();
  // Flip one character in the payload section.
  const parts = token.split(".");
  const flipped = parts[0] + "." + (parts[1][0] === "A" ? "B" + parts[1].slice(1) : "A" + parts[1].slice(1)) + "." + parts[2];
  assert.equal(verifyRunToken(flipped, { env: ENV, now: 300 }), null);
  // Corrupt the signature.
  const badSig = parts[0] + "." + parts[1] + "." + (parts[2][0] === "0" ? "1" + parts[2].slice(1) : "0" + parts[2].slice(1));
  assert.equal(verifyRunToken(badSig, { env: ENV, now: 300 }), null);
  // Garbage token.
  assert.equal(verifyRunToken("not-a-token", { env: ENV, now: 300 }), null);
  assert.equal(verifyRunToken(`rt1.${"A".repeat(50)}.deadbeef`, { env: ENV, now: 300 }), null);
});

test("missing session secret fails loudly when minting", () => {
  assert.throws(() => signRunToken(USER, RUN, { env: {} }), /SWARM_SESSION_SECRET/);
});

test("runTokenTtlSec respects the env override and defaults", () => {
  assert.equal(runTokenTtlSec({}), 12 * 60 * 60);
  assert.equal(runTokenTtlSec({ SWARM_RUN_TOKEN_TTL_SEC: "60" }), 60);
  assert.equal(runTokenTtlSec({ SWARM_RUN_TOKEN_TTL_SEC: "bogus" }), 12 * 60 * 60);
});
