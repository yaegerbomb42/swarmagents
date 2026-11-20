import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MASCOT_FRAME_RANGES,
  MASCOT_TOTAL_FRAMES,
  advanceMascotFrame,
  framePosition,
  frameRangeFor,
  mascotStateForRun,
  mascotStatusLabel,
  shouldBlinkPause,
  stillFrameFor,
} from "./frames";

test("state ranges match the sprite-sheet README", () => {
  assert.deepEqual(
    { start: MASCOT_FRAME_RANGES.hello.start, end: MASCOT_FRAME_RANGES.hello.end, loop: MASCOT_FRAME_RANGES.hello.loop },
    { start: 0, end: 10, loop: false },
  );
  assert.deepEqual(
    { start: MASCOT_FRAME_RANGES.idle.start, end: MASCOT_FRAME_RANGES.idle.end, loop: MASCOT_FRAME_RANGES.idle.loop },
    { start: 11, end: 15, loop: true },
  );
  assert.deepEqual(
    { start: MASCOT_FRAME_RANGES.attention.start, end: MASCOT_FRAME_RANGES.attention.end, loop: MASCOT_FRAME_RANGES.attention.loop },
    { start: 16, end: 23, loop: true },
  );
  assert.deepEqual(
    { start: MASCOT_FRAME_RANGES.working.start, end: MASCOT_FRAME_RANGES.working.end, loop: MASCOT_FRAME_RANGES.working.loop },
    { start: 24, end: 63, loop: true },
  );
});

test("every state range stays inside the 64-frame sheet", () => {
  for (const state of ["hello", "idle", "attention", "working"] as const) {
    const range = frameRangeFor(state);
    assert.ok(range.start >= 0 && range.start < MASCOT_TOTAL_FRAMES, `${state} start`);
    assert.ok(range.end >= range.start && range.end < MASCOT_TOTAL_FRAMES, `${state} end`);
  }
});

test("hello plays once and reports done on its last frame", () => {
  // Walk the whole wave: 0 -> 1 -> ... -> 10, and only then done.
  let frame = 0;
  for (let expected = 1; expected <= 10; expected += 1) {
    const step = advanceMascotFrame("hello", frame);
    assert.equal(step.frame, expected);
    assert.equal(step.done, false);
    assert.equal(step.completedLoop, false);
    frame = step.frame;
  }
  const done = advanceMascotFrame("hello", frame);
  assert.equal(done.done, true);
  assert.equal(done.frame, 10);
});

test("idle loops 11-15 and blinks occasionally", () => {
  const wrapped = advanceMascotFrame("idle", 15, 0);
  assert.equal(wrapped.frame, 11);
  assert.equal(wrapped.completedLoop, true);
  assert.equal(wrapped.pause, false, "first loop should not pause");

  assert.equal(shouldBlinkPause("idle", 1), false);
  assert.equal(shouldBlinkPause("idle", 2), false);
  assert.equal(shouldBlinkPause("idle", 3), true);
  assert.equal(shouldBlinkPause("idle", 6), true);

  const blink = advanceMascotFrame("idle", 15, 2);
  assert.equal(blink.completedLoop, true);
  assert.equal(blink.pause, true);
});

test("working and attention loop their own ranges", () => {
  const working = advanceMascotFrame("working", 63, 0);
  assert.equal(working.frame, 24);
  assert.equal(working.completedLoop, true);
  assert.equal(working.pause, false);

  const attention = advanceMascotFrame("attention", 23, 0);
  assert.equal(attention.frame, 16);
  assert.equal(attention.completedLoop, true);
  assert.equal(attention.pause, false);
});

test("advance clamps a frame from another state into the current range", () => {
  // A stale frame (say 90) must never leave the sheet or the state's range.
  const step = advanceMascotFrame("idle", 90);
  assert.equal(step.frame, 11);
  assert.ok(step.frame >= 11 && step.frame <= 15);
});

test("framePosition maps the 8x8 grid left to right, top to bottom", () => {
  assert.deepEqual(framePosition(0), { col: 0, row: 0 });
  assert.deepEqual(framePosition(7), { col: 7, row: 0 });
  assert.deepEqual(framePosition(8), { col: 0, row: 1 });
  assert.deepEqual(framePosition(15), { col: 7, row: 1 });
  assert.deepEqual(framePosition(16), { col: 0, row: 2 });
  assert.deepEqual(framePosition(63), { col: 7, row: 7 });
});

test("stillFrameFor returns the first frame of each state", () => {
  assert.equal(stillFrameFor("hello"), 0);
  assert.equal(stillFrameFor("idle"), 11);
  assert.equal(stillFrameFor("attention"), 16);
  assert.equal(stillFrameFor("working"), 24);
});

test("run state maps to the mascot state, with attention winning", () => {
  assert.equal(mascotStateForRun({ busy: true }), "working");
  assert.equal(mascotStateForRun({ busy: false }), "idle");
  assert.equal(mascotStateForRun({ busy: true, needsAttention: true }), "attention");
  assert.equal(mascotStateForRun({ busy: false, needsAttention: true }), "attention");
});

test("each state has a human-readable status label", () => {
  assert.match(mascotStatusLabel("hello"), /hello/i);
  assert.match(mascotStatusLabel("working"), /working/i);
  assert.match(mascotStatusLabel("attention"), /waiting/i);
  assert.match(mascotStatusLabel("idle"), /idle/i);
});
