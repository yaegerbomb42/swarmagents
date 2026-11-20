import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commonPrefixLength,
  EMPTY_NARRATION,
  narrationAdvance,
  narrationOnTarget,
  narrationShown,
  narrationStreaming,
} from "./narration";

test("commonPrefixLength finds the shared head", () => {
  assert.equal(commonPrefixLength("Running npm test 41/52", "Running npm test 42/52"), 18);
  assert.equal(commonPrefixLength("same", "same"), 4);
  assert.equal(commonPrefixLength("abc", "xyz"), 0);
  assert.equal(commonPrefixLength("", "abc"), 0);
});

test("a target change keeps the common prefix and only re-streams the tail", () => {
  const first = { target: "Running npm test 41/52", shown: 22 };
  const next = narrationOnTarget(first, "Running npm test 42/52");
  // Only the digit after "…test 4" is new; the rest stays on screen.
  assert.equal(next.shown, 18);
  assert.equal(narrationShown(next), "Running npm test 4");
  assert.equal(narrationShown(narrationAdvance(next, 2)), "Running npm test 42/");
  assert.equal(narrationShown(narrationAdvance(narrationAdvance(next, 2), 2)), "Running npm test 42/52");
});

test("a completely different target restarts the stream from zero", () => {
  const prev = { target: "Running: ls -la", shown: 15 };
  const next = narrationOnTarget(prev, "Editing src/App.tsx");
  assert.equal(next.shown, 0);
  assert.equal(narrationShown(next), "");
});

test("unchanged target returns the same state object", () => {
  const prev = { target: "VM ready", shown: 3 };
  assert.equal(narrationOnTarget(prev, "VM ready"), prev);
});

test("advance is clamped to the target and never goes backwards", () => {
  const short = narrationAdvance({ target: "abc", shown: 1 }, 10);
  assert.equal(short.shown, 3);
  assert.equal(narrationShown(short), "abc");
  assert.equal(narrationStreaming(short), false);
  assert.equal(narrationAdvance(short, 2), short);
});

test("empty narration streams from the first character", () => {
  const s = narrationOnTarget(EMPTY_NARRATION, "Run started");
  assert.equal(s.shown, 0);
  assert.equal(narrationStreaming(s), true);
  assert.equal(narrationShown(narrationAdvance(s, 2)), "Ru");
});

test("reduced motion shows the whole sentence immediately", () => {
  const s = { target: "Running: npm test", shown: 4 };
  assert.equal(narrationShown(s, true), "Running: npm test");
  // The state is preserved, so turning animation back on resumes mid-stream.
  assert.equal(narrationShown(s, false), "Runn");
});
