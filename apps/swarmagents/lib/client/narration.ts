/**
 * narration.ts — pure model for the one-line, character-by-character narration
 * row between the computer screen and the composer.
 *
 * The narration target is the newest activity sentence (see activity.ts).
 * While a tool streams, that sentence can change on every event — e.g.
 * "Running: npm test 41/52" → "Running: npm test 42/52". Retyping the whole
 * line on every change would flicker and reset the reader's eye. Instead we
 * keep the common prefix that is already on screen and only stream the
 * changed tail:
 *
 *   target changes → shown = min(shown, commonPrefixLength(old, new))
 *   each tick      → shown = min(target.length, shown + step)
 *
 * Under `prefers-reduced-motion: reduce` the whole target is returned at
 * once — no streaming at all.
 *
 * DOM-free so it unit-tests with plain node:test (narration.test.ts).
 */

export interface NarrationState {
  /** The full sentence we are streaming towards. */
  target: string;
  /** How many characters of `target` are currently visible. */
  shown: number;
}

export const EMPTY_NARRATION: NarrationState = { target: "", shown: 0 };

/** Length of the longest common prefix of `a` and `b`. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

/**
 * Point the narration at a new target. Characters shared with the previous
 * target stay visible; only the changed tail re-streams. Returning the same
 * object when the target is unchanged keeps the animation effect idle.
 */
export function narrationOnTarget(prev: NarrationState, target: string): NarrationState {
  if (prev.target === target) return prev;
  const keep = Math.min(prev.shown, commonPrefixLength(prev.target, target));
  return { target, shown: keep };
}

/** Advance the visible characters by `step` (clamped to the target). */
export function narrationAdvance(state: NarrationState, step = 2): NarrationState {
  const advance = Math.max(1, Math.floor(step));
  const shown = Math.min(state.target.length, state.shown + advance);
  return shown === state.shown ? state : { ...state, shown };
}

/** True while more characters remain to stream. */
export function narrationStreaming(state: NarrationState): boolean {
  return state.shown < state.target.length;
}

/**
 * The text to render. Reduced motion shows the complete target immediately.
 * The state itself is untouched so turning reduced motion off mid-run can
 * resume from a sane position.
 */
export function narrationShown(state: NarrationState, reduceMotion = false): string {
  if (reduceMotion) return state.target;
  return state.target.slice(0, Math.min(state.shown, state.target.length));
}
