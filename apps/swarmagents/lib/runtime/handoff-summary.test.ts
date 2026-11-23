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

test("handoff summary: merges the takeover handback summary", () => {
  const summary = buildHandoffSummary({
    startedAt: 0,
    resolvedAt: 30_000,
    shot: fakeShot(),
    takeoverSummary: {
      text: "Human drove for 30s. Windows: Editor — notes.txt. Modified files: notes.txt.",
      tokenCount: 20,
      windowTitles: ["Editor — notes.txt"],
      modifiedFiles: ["notes.txt"],
      lastFrameCaption: "",
      durationMs: 30_000,
      inputEventsCount: 42,
      generatedAt: 30_000,
    },
  });
  assert.ok(summary.includes("Human drove for 30s"));
  assert.ok(summary.includes("notes.txt"));
  // The framing lines survive around the merged text.
  assert.ok(summary.includes("handed the desktop back"));
  assert.ok(summary.includes("Continue the task"));
  assert.ok(summary.length <= 1200);
});

test("handoff summary: takeover text is redacted and truncated to the budget", () => {
  const summary = buildHandoffSummary({
    startedAt: 0,
    resolvedAt: 1,
    shot: null,
    takeoverSummary: {
      text: `Window: sk-${"a".repeat(48)} ${"filler ".repeat(400)}`,
      tokenCount: 300,
      windowTitles: [],
      modifiedFiles: [],
      lastFrameCaption: "",
      durationMs: 1,
      inputEventsCount: 1,
      generatedAt: 1,
    },
  });
  assert.ok(summary.length <= 1200);
  assert.ok(!summary.includes(`sk-${"a".repeat(48)}`), "key-shaped text is redacted");
  assert.ok(summary.includes("[REDACTED]"));
  assert.ok(summary.includes("Continue the task"), "closing instructions are not amputated");
});

test("handoff summary: a null takeover summary changes nothing", () => {
  const withNull = buildHandoffSummary({ startedAt: 0, resolvedAt: 1000, shot: null, takeoverSummary: null });
  const without = buildHandoffSummary({ startedAt: 0, resolvedAt: 1000, shot: null });
  assert.equal(withNull, without);
});
