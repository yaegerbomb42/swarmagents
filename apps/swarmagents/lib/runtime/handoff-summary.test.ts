/**
 * handoff-summary tests (lib/runtime/handoff-summary.ts).
 *
 * The summary returned to the resuming agent must be compact, text-only and
 * never echo a credential. These tests pin the shape and the screenshot branch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildHandoffSummary } from "./handoff-summary";

function fakeShot(bytes = 4096): { bytes: Buffer; mime: string } {
  return { bytes: Buffer.alloc(bytes, 7), mime: "image/png" };
}

test("handoff summary: states the handoff and elapsed time", () => {
  const summary = buildHandoffSummary({ startedAt: 1000, resolvedAt: 13000, shot: null });
  assert.ok(summary.includes("handed the desktop back"));
  assert.ok(summary.includes("~12s"));
  assert.ok(summary.includes("screenshot could not be captured"));
});

test("handoff summary: includes the captured screenshot when present", () => {
  const summary = buildHandoffSummary({ startedAt: 0, resolvedAt: 1000, shot: fakeShot() });
  assert.ok(summary.includes("image/png"));
  assert.ok(summary.includes("4 KB"));
  assert.ok(summary.includes("screenshot of the current on-screen state"));
});

test("handoff summary: never contains a credential and is bounded", () => {
  const longDescription = "x".repeat(5000);
  const summary = buildHandoffSummary({
    startedAt: 0,
    resolvedAt: 1,
    shot: fakeShot(),
    description: longDescription,
  });
  assert.ok(summary.length <= 1200);
  assert.equal(summary.includes("password"), false);
  assert.equal(summary.includes("token"), false);
  assert.equal(summary.includes("secret"), false);
});
