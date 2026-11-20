import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelayMs, DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_MAX_MS } from "./backoff";

test("doubles from the base with each attempt", () => {
  assert.equal(backoffDelayMs(0), 500);
  assert.equal(backoffDelayMs(1), 1000);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(3), 4000);
  assert.equal(backoffDelayMs(4), 8000);
  assert.equal(backoffDelayMs(5), 16_000);
});

test("caps the delay at the maximum", () => {
  assert.equal(backoffDelayMs(6), 30_000);
  assert.equal(backoffDelayMs(7), 30_000);
  assert.equal(backoffDelayMs(50), 30_000);
  assert.equal(backoffDelayMs(10_000), 30_000);
});

test("never returns Infinity even for absurd attempt counts", () => {
  assert.ok(Number.isFinite(backoffDelayMs(Number.MAX_SAFE_INTEGER)));
});

test("honours custom base and cap", () => {
  assert.equal(backoffDelayMs(0, { baseMs: 100 }), 100);
  assert.equal(backoffDelayMs(2, { baseMs: 100 }), 400);
  assert.equal(backoffDelayMs(5, { baseMs: 100, maxMs: 900 }), 900);
  assert.equal(backoffDelayMs(0, { baseMs: 100, maxMs: 50 }), 100); // cap >= base
});

test("treats negative and fractional attempts as the first retry", () => {
  assert.equal(backoffDelayMs(-3), DEFAULT_BACKOFF_BASE_MS);
  assert.equal(backoffDelayMs(1.9), 1000);
});

test("defaults match the documented 500ms/30s schedule", () => {
  assert.equal(DEFAULT_BACKOFF_BASE_MS, 500);
  assert.equal(DEFAULT_BACKOFF_MAX_MS, 30_000);
});
