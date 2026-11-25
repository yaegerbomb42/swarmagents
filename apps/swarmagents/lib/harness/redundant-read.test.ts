import test from "node:test";
import assert from "node:assert/strict";
import {
  RedundantReadTracker,
  VerificationCoalescer,
  normalizeVerifyCommand,
  readSliceKey,
} from "./redundant-read";

test("RedundantReadTracker flags duplicate reads until invalidated", () => {
  const tracker = new RedundantReadTracker();
  const key = readSliceKey("lib/foo.ts", 1, 50, true);
  assert.equal(key, "lib/foo.ts:1-50:a");
  assert.equal(tracker.record("lib/foo.ts", key), false);
  assert.equal(tracker.record("lib/foo.ts", key), true);
  tracker.noteSavedTokens(420);
  assert.deepEqual(tracker.snapshot(), { redundantReads: 1, tokensSaved: 420 });

  tracker.invalidate(["lib/foo.ts"]);
  assert.equal(tracker.record("lib/foo.ts", key), false);

  tracker.invalidate();
  assert.equal(tracker.record("lib/foo.ts", key), false);
});

test("VerificationCoalescer skips immediate identical checks only when clean", () => {
  const coalescer = new VerificationCoalescer();
  assert.equal(normalizeVerifyCommand("  npx   vitest  run "), "vitest run");
  assert.equal(coalescer.decide("npx vitest run", 1, 0), "run");
  assert.equal(coalescer.decide("vitest run", 2, 0), "skip");
  // Mutation occurred at seq 2 before seq 3 -> must run.
  assert.equal(coalescer.decide("vitest run", 3, 2), "run");
  coalescer.invalidate();
  assert.equal(coalescer.decide("vitest run", 4, 2), "run");
});
