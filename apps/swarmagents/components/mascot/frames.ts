/**
 * Jimmy's sprite-sheet model.
 *
 * mascot-sheet.png is an 8x8 transparent sheet of 192x153 frames (64 total),
 * read left to right, top to bottom, at ~160ms per frame:
 *
 *   frames  0-10  wave (hello) — plays once
 *   frames 11-15  idle — loops, with an occasional blink-length pause
 *   frames 16-23  lean with an alert mark (attention)
 *   frames 24-63  thinking and fidgeting (working)
 *
 * This module is DOM-free so the state-to-frame mapping and the run-state
 * handoff stay unit-testable in plain node:test.
 */

export type MascotState = "hello" | "idle" | "working" | "attention";

export interface MascotFrameRange {
  /** First frame of the loop/sequence (inclusive). */
  start: number;
  /** Last frame of the loop/sequence (inclusive). */
  end: number;
  /** True when the range repeats; false means it plays once and settles. */
  loop: boolean;
  /**
   * Insert a blink-length hold after every Nth completed loop. Only idle
   * uses this — it keeps the resting loop from feeling mechanical.
   */
  pauseEveryLoops?: number;
}

export const MASCOT_FRAME_MS = 160;
export const MASCOT_COLUMNS = 8;
export const MASCOT_ROWS = 8;
export const MASCOT_FRAME_WIDTH = 192;
export const MASCOT_FRAME_HEIGHT = 153;
export const MASCOT_TOTAL_FRAMES = 64;
export const MASCOT_SHEET = "/brand/mascot/mascot-sheet.png";

export const MASCOT_FRAME_RANGES: Record<MascotState, MascotFrameRange> = {
  hello: { start: 0, end: 10, loop: false },
  idle: { start: 11, end: 15, loop: true, pauseEveryLoops: 3 },
  attention: { start: 16, end: 23, loop: true },
  working: { start: 24, end: 63, loop: true },
};

/** How long a full hello wave takes (11 frames at the sheet's frame rate). */
export const MASCOT_HELLO_MS =
  (MASCOT_FRAME_RANGES.hello.end - MASCOT_FRAME_RANGES.hello.start + 1) * MASCOT_FRAME_MS;

/** The range a state plays, clamped into the sheet's 64 frames. */
export function frameRangeFor(state: MascotState): MascotFrameRange {
  const range = MASCOT_FRAME_RANGES[state] ?? MASCOT_FRAME_RANGES.idle;
  return {
    ...range,
    start: Math.max(0, Math.min(MASCOT_TOTAL_FRAMES - 1, range.start)),
    end: Math.max(0, Math.min(MASCOT_TOTAL_FRAMES - 1, range.end)),
  };
}

/** The single frame shown when motion is reduced (first frame of the state). */
export function stillFrameFor(state: MascotState): number {
  return frameRangeFor(state).start;
}

/** Column/row of a frame in the 8x8 sheet. */
export function framePosition(frame: number): { col: number; row: number } {
  const safe = Math.max(0, Math.min(MASCOT_TOTAL_FRAMES - 1, Math.trunc(frame)));
  return { col: safe % MASCOT_COLUMNS, row: Math.floor(safe / MASCOT_COLUMNS) };
}

export interface MascotFrameStep {
  /** Frame to render after this step. */
  frame: number;
  /** True when this step wrapped back to the start of a loop range. */
  completedLoop: boolean;
  /** True when a one-shot sequence finished and should settle. */
  done: boolean;
  /** True when the next frame should be held for a blink-length pause. */
  pause: boolean;
}

/**
 * Advance one frame within a state's range. One-shot ranges (hello) report
 * `done` at their last frame; looping ranges wrap and report the completed
 * loop count so the caller can schedule an occasional blink-length pause.
 */
export function advanceMascotFrame(
  state: MascotState,
  currentFrame: number,
  completedLoops = 0,
): MascotFrameStep {
  const range = frameRangeFor(state);
  const frame = Math.max(range.start, Math.min(range.end, Math.trunc(currentFrame)));

  if (frame < range.end) {
    return { frame: frame + 1, completedLoop: false, done: false, pause: false };
  }
  if (!range.loop) {
    return { frame: range.end, completedLoop: false, done: true, pause: false };
  }
  return {
    frame: range.start,
    completedLoop: true,
    done: false,
    pause: shouldBlinkPause(state, completedLoops + 1),
  };
}

/** Idle rests for an extra beat every few loops, like a blink. */
export function shouldBlinkPause(state: MascotState, completedLoops: number): boolean {
  const every = frameRangeFor(state).pauseEveryLoops;
  return Boolean(every && completedLoops > 0 && completedLoops % every === 0);
}

export interface RunMascotInput {
  /** The agent run is active. */
  busy: boolean;
  /** The run needs a human: an ask_user question, approval, pause or error. */
  needsAttention?: boolean;
}

/** Pick the mascot state from the run state. Attention always wins. */
export function mascotStateForRun({ busy, needsAttention = false }: RunMascotInput): MascotState {
  if (needsAttention) return "attention";
  if (busy) return "working";
  return "idle";
}

/** Visually hidden status line for assistive tech. */
export function mascotStatusLabel(state: MascotState): string {
  switch (state) {
    case "hello":
      return "Jimmy waves hello.";
    case "working":
      return "Jimmy is working.";
    case "attention":
      return "Jimmy is waiting for you.";
    default:
      return "Jimmy is idle.";
  }
}
