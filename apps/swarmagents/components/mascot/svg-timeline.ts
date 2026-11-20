/**
 * Jimmy's procedural SVG timeline.
 *
 * public/brand/mascot/mascot-svg-reference.html is a 10 second self-contained
 * animation with three gestures: wave (0-3s), curious (3-6s), thinking
 * (6-10s). This module maps those gestures onto the four mascot states and
 * turns a state into the sub-range of the timeline that should loop.
 *
 * The reference has no dedicated rest window, so `idle` loops the calm
 * 1.3-2.9s shoulder of the opening segment and the renderer pins the arm rig
 * to its resting pose (see MascotSvg). Everything else in that window is
 * already constant, which gives a quiet breathing loop instead of a wave.
 *
 * DOM-free so the state-to-segment mapping stays unit-testable in plain
 * node:test, matching components/mascot/frames.ts.
 */

import type { MascotState } from "./frames";

export type MascotSvgState = "wave" | "curious" | "thinking" | "idle";

export interface SvgSegment {
  /** Timeline time in seconds where the loop starts (inclusive). */
  start: number;
  /** Timeline time in seconds where the loop ends (exclusive). */
  end: number;
}

/** The 10s reference timeline, split into one loop per mascot state. */
export const MASCOT_SVG_SEGMENTS: Record<MascotSvgState, SvgSegment> = {
  wave: { start: 0, end: 3 },
  curious: { start: 3, end: 6 },
  thinking: { start: 6, end: 10 },
  idle: { start: 1.3, end: 2.9 },
};

/** The reference animation's full length, kept for the provenance note. */
export const MASCOT_SVG_LOOP_SECONDS = 10;

/** Width:height ratio of the reference viewBox (540 x 640). */
export const MASCOT_SVG_ASPECT = 640 / 540;

export function segmentFor(state: MascotSvgState): SvgSegment {
  return MASCOT_SVG_SEGMENTS[state] ?? MASCOT_SVG_SEGMENTS.idle;
}

/** Length of one loop of a state's segment, in seconds. */
export function segmentSeconds(state: MascotSvgState): number {
  const segment = segmentFor(state);
  return Math.max(0, segment.end - segment.start);
}

/**
 * Wrap elapsed playback time into the state's segment. Starting a state at
 * elapsed 0 therefore shows the segment's first frame.
 */
export function timelineTimeFor(state: MascotSvgState, elapsedMs: number): number {
  const segment = segmentFor(state);
  const length = segmentSeconds(state);
  if (length <= 0) return segment.start;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) / 1000 : 0;
  return segment.start + (elapsed % length);
}

/**
 * Run states, including the two labels the product uses for "nothing is
 * running yet" (empty) and the first-load greeting. Kept as a string union so
 * callers can pass either the sprite sheet's state or a run summary word.
 */
export type MascotRunState = MascotState | "empty" | "greeting";

/**
 * Sprite-sheet state -> SVG gesture:
 *   greeting / empty -> wave
 *   waiting for the user / ask_user (attention) -> curious
 *   agent working -> thinking
 *   otherwise -> idle
 */
export function svgStateForRun(state: MascotRunState | null | undefined): MascotSvgState {
  switch (state) {
    case "hello":
    case "greeting":
    case "empty":
      return "wave";
    case "attention":
      return "curious";
    case "working":
      return "thinking";
    default:
      return "idle";
  }
}
