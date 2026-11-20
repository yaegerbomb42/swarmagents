import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MASCOT_SVG_LOOP_SECONDS,
  MASCOT_SVG_SEGMENTS,
  segmentFor,
  segmentSeconds,
  svgStateForRun,
  timelineTimeFor,
  type MascotSvgState,
} from "./svg-timeline";

const STATES: MascotSvgState[] = ["wave", "curious", "thinking", "idle"];

test("each state loops its own segment of the 10s reference timeline", () => {
  assert.deepEqual(MASCOT_SVG_SEGMENTS, {
    wave: { start: 0, end: 3 },
    curious: { start: 3, end: 6 },
    thinking: { start: 6, end: 10 },
    idle: { start: 1.3, end: 2.9 },
  });
  assert.equal(MASCOT_SVG_LOOP_SECONDS, 10);
  // Every segment is non-empty and inside the reference loop.
  for (const state of STATES) {
    const segment = segmentFor(state);
    assert.ok(segment.end > segment.start, `${state} has a positive length`);
    assert.ok(segment.start >= 0 && segment.end <= MASCOT_SVG_LOOP_SECONDS, `${state} stays in range`);
  }
  // The gesture states tile the whole loop without overlapping.
  assert.equal(segmentFor("wave").end, segmentFor("curious").start);
  assert.equal(segmentFor("curious").end, segmentFor("thinking").start);
  assert.equal(segmentFor("thinking").end, MASCOT_SVG_LOOP_SECONDS);
});

test("elapsed time wraps within the selected segment, not the whole loop", () => {
  const close = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~= ${expected}`);

  close(segmentSeconds("wave"), 3);
  close(segmentSeconds("curious"), 3);
  close(segmentSeconds("thinking"), 4);
  close(segmentSeconds("idle"), 1.6);

  assert.equal(timelineTimeFor("wave", 0), 0);
  assert.equal(timelineTimeFor("wave", 1500), 1.5);
  assert.equal(timelineTimeFor("wave", 3000), 0, "wave loops after 3s");
  assert.equal(timelineTimeFor("wave", 7500), 1.5, "7.5s is midway through the second wave");

  assert.equal(timelineTimeFor("curious", 0), 3);
  assert.equal(timelineTimeFor("curious", 1500), 4.5);
  assert.equal(timelineTimeFor("curious", 3000), 3, "curious loops after 3s");

  assert.equal(timelineTimeFor("thinking", 0), 6);
  assert.equal(timelineTimeFor("thinking", 2000), 8);
  assert.equal(timelineTimeFor("thinking", 4000), 6, "thinking loops after 4s");

  assert.equal(timelineTimeFor("idle", 0), 1.3, "idle starts at the calm shoulder");
  close(timelineTimeFor("idle", 9999), 1.3 + (9999 % 1600) / 1000);
});

test("negative or non-finite elapsed time cannot leave the segment", () => {
  assert.equal(timelineTimeFor("thinking", -500), 6);
  assert.equal(timelineTimeFor("thinking", Number.NaN), 6);
  assert.equal(timelineTimeFor("thinking", Number.POSITIVE_INFINITY), 6);
});

test("run states map to the right gesture (m1 parity)", () => {
  assert.equal(svgStateForRun("hello"), "wave");
  assert.equal(svgStateForRun("greeting"), "wave");
  assert.equal(svgStateForRun("empty"), "wave");
  assert.equal(svgStateForRun("attention"), "curious", "waiting for the user / ask_user");
  assert.equal(svgStateForRun("working"), "thinking", "agent working");
  assert.equal(svgStateForRun("idle"), "idle");
  assert.equal(svgStateForRun(null), "idle");
  assert.equal(svgStateForRun(undefined), "idle");
});
