import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ONE_DAY_MS, parseRateLimitHeaders } from "./rolling-window";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");

describe("parseRateLimitHeaders Retry-After hardening", () => {
  it("ignores a non-finite numeric Retry-After instead of excluding forever", () => {
    for (const raw of ["Infinity", "1e309", "-Infinity"]) {
      const parsed = parseRateLimitHeaders({ "retry-after": raw }, NOW);
      assert.equal(parsed.retryAfterMs, undefined, `retry-after: ${raw}`);
    }
  });

  it("clamps an absurd numeric Retry-After to one day", () => {
    const parsed = parseRateLimitHeaders({ "retry-after": "999999999" }, NOW);
    assert.equal(parsed.retryAfterMs, ONE_DAY_MS);
  });

  it("clamps an absurd duration-string Retry-After to one day", () => {
    for (const raw of ["999999999h", `${"9".repeat(400)}h`, "100000000m"]) {
      const parsed = parseRateLimitHeaders({ "retry-after": raw }, NOW);
      assert.equal(parsed.retryAfterMs, ONE_DAY_MS, `retry-after: ${raw.slice(0, 24)}…`);
    }
  });

  it("passes sane Retry-After values through unchanged", () => {
    assert.equal(parseRateLimitHeaders({ "retry-after": "30" }, NOW).retryAfterMs, 30_000);
    assert.equal(parseRateLimitHeaders({ "retry-after": "1.5" }, NOW).retryAfterMs, 1_500);
    assert.equal(parseRateLimitHeaders({ "retry-after": "500ms" }, NOW).retryAfterMs, 500);
    assert.equal(parseRateLimitHeaders({ "retry-after": "2m30s" }, NOW).retryAfterMs, 150_000);
    assert.equal(parseRateLimitHeaders({ "retry-after": "12s" }, NOW).retryAfterMs, 12_000);
  });

  it("clamps a far-future HTTP-date Retry-After to one day", () => {
    const parsed = parseRateLimitHeaders(
      { "retry-after": "Wed, 01 Jan 2098 00:00:00 GMT" },
      NOW,
    );
    assert.equal(parsed.retryAfterMs, ONE_DAY_MS);
  });

  it("a past HTTP-date Retry-After is zero", () => {
    const parsed = parseRateLimitHeaders(
      { "retry-after": "Sun, 22 Nov 2026 11:00:00 GMT" },
      NOW,
    );
    assert.equal(parsed.retryAfterMs, 0);
  });

  it("ignores a non-finite x-ratelimit-reset", () => {
    for (const raw of ["Infinity", "1e309"]) {
      const parsed = parseRateLimitHeaders({ "x-ratelimit-reset": raw }, NOW);
      assert.equal(parsed.resetAtMs, undefined, `x-ratelimit-reset: ${raw}`);
    }
  });

  it("clamps a far-future x-ratelimit-reset epoch to one day out", () => {
    const parsed = parseRateLimitHeaders(
      { "x-ratelimit-reset": String(NOW + 30 * ONE_DAY_MS) },
      NOW,
    );
    assert.equal(parsed.resetAtMs, NOW + ONE_DAY_MS);
  });

  it("keeps the seconds-from-now reset reading", () => {
    const parsed = parseRateLimitHeaders({ "x-ratelimit-reset": "30" }, NOW);
    assert.equal(parsed.resetAtMs, NOW + 30_000);
  });

  it("keeps the epoch-seconds reset reading", () => {
    const epochSeconds = Math.floor(NOW / 1000) + 60;
    const parsed = parseRateLimitHeaders({ "x-ratelimit-reset": String(epochSeconds) }, NOW);
    assert.equal(parsed.resetAtMs, epochSeconds * 1000);
  });
});
