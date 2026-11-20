/**
 * Library moderation identity and the per-account publish rate limit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isLibraryAdmin } from "./admin";
import { consumePublishRate, publishLimitPerHour, resetPublishRateLimit } from "./rate";

const savedEnv = { ...process.env };

test.afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  resetPublishRateLimit();
});

// ---- admin identity --------------------------------------------------------

test("isLibraryAdmin ignores an empty user", () => {
  assert.equal(isLibraryAdmin("", {}), false);
});

test("in local mode the single 'local' owner is an admin unless configured", () => {
  delete process.env.SWARM_SERVER_MODE;
  assert.equal(isLibraryAdmin("local", {}), true);
  assert.equal(isLibraryAdmin("bob", {}), false);
  assert.equal(isLibraryAdmin("Local", {}), false, "the local owner id is exact");

  process.env.SWARM_SERVER_MODE = "1";
  assert.equal(isLibraryAdmin("local", {}), false, "server mode has no implicit admin");
});

test("SWARM_ADMIN_USERS matches case-insensitively and understands local_ ids", () => {
  const env = { SWARM_ADMIN_USERS: " Admin@Swarm.Test , ops@swarm.test " };
  assert.equal(isLibraryAdmin("admin@swarm.test", env), true);
  assert.equal(isLibraryAdmin("ADMIN@SWARM.TEST", env), true);
  assert.equal(isLibraryAdmin("local_admin@swarm.test", env), true);
  assert.equal(isLibraryAdmin("ops@swarm.test", env), true);
  assert.equal(isLibraryAdmin("local_ops@swarm.test", env), true);
  assert.equal(isLibraryAdmin("bob", env), false);
});

test("an explicit admin list overrides the local-mode default", () => {
  delete process.env.SWARM_SERVER_MODE;
  assert.equal(isLibraryAdmin("local", { SWARM_ADMIN_USERS: "someone@swarm.test" }), false);
  assert.equal(isLibraryAdmin("local", { SWARM_ADMIN_USERS: "   " }), true, "blank config is not configured");
});

test("a local_ admin entry also matches the bare email and vice versa", () => {
  assert.equal(isLibraryAdmin("someone@swarm.test", { SWARM_ADMIN_USERS: "local_someone@swarm.test" }), true);
  assert.equal(isLibraryAdmin("local_someone@swarm.test", { SWARM_ADMIN_USERS: "someone@swarm.test" }), true);
});

// ---- publish rate limit ----------------------------------------------------

test("publishLimitPerHour falls back to 10 for invalid values", () => {
  assert.equal(publishLimitPerHour({}), 10);
  assert.equal(publishLimitPerHour({ SWARM_LIBRARY_PUBLISH_PER_HOUR: "3" }), 3);
  assert.equal(publishLimitPerHour({ SWARM_LIBRARY_PUBLISH_PER_HOUR: "2.9" }), 2);
  for (const value of ["0", "-2", "abc", "", "Infinity"]) {
    assert.equal(publishLimitPerHour({ SWARM_LIBRARY_PUBLISH_PER_HOUR: value }), 10, `value ${value}`);
  }
});

test("consumePublishRate allows the budget then reports retryAfter", () => {
  resetPublishRateLimit();
  const now = 1_000_000;
  const env = { SWARM_LIBRARY_PUBLISH_PER_HOUR: "2" };
  assert.deepEqual(consumePublishRate("alice", now, env), {
    allowed: true,
    retryAfter: 0,
    limit: 2,
    remaining: 1,
  });
  assert.deepEqual(consumePublishRate("alice", now + 1, env), {
    allowed: true,
    retryAfter: 0,
    limit: 2,
    remaining: 0,
  });
  const limited = consumePublishRate("alice", now + 2, env);
  assert.equal(limited.allowed, false);
  assert.equal(limited.remaining, 0);
  assert.equal(limited.limit, 2);
  assert.ok(limited.retryAfter > 0 && limited.retryAfter <= 3600);
});

test("consumePublishRate is per account and resets when the window rolls over", () => {
  resetPublishRateLimit();
  const now = 2_000_000;
  const env = { SWARM_LIBRARY_PUBLISH_PER_HOUR: "1" };
  assert.equal(consumePublishRate("alice", now, env).allowed, true);
  assert.equal(consumePublishRate("alice", now + 1, env).allowed, false);
  assert.equal(consumePublishRate("bob", now + 1, env).allowed, true, "separate budget");

  const nextWindow = now + 60 * 60 * 1000;
  const reset = consumePublishRate("alice", nextWindow, env);
  assert.equal(reset.allowed, true);
  assert.equal(reset.remaining, 0);
});

test("the default budget is ten publishes per hour", () => {
  resetPublishRateLimit();
  const now = 3_000_000;
  for (let index = 0; index < 10; index += 1) {
    const decision = consumePublishRate("alice", now + index, {});
    assert.equal(decision.allowed, true, `publish ${index + 1}`);
    assert.equal(decision.remaining, 9 - index);
  }
  assert.equal(consumePublishRate("alice", now + 10, {}).allowed, false);
});
