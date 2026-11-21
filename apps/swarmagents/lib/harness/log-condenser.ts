/**
 * Pure log condenser ported from vendor/claude-code-mini/src/logCondenser.ts.
 *
 * Only the deterministic pieces are extracted here: noise-frame stripping,
 * failure-line retention (capped at {@link MAX_FAILURE_LINES}), and a
 * head/tail fallback. There is no LLM step and no wiring into the runner,
 * oracle, or report — this module just turns a noisy build/test log into a
 * bounded, readable extract (wiring is a separate decision).
 */

// Internal runtime boilerplate frames that carry no diagnostic value.
const NOISE_FRAME = [/node:internal/i, /node_modules/i, /at async Promise/i];

// Lines that hint at an actual failure worth surfacing.
const FAILURE_CLUE = [
  /fail/i,
  /error/i,
  /expected/i,
  /received/i,
  /assert/i,
  /syntax/i,
  /uncaught/i,
  /critical failure/i,
];

/** Max failure-clue lines kept in the condensed output. */
export const MAX_FAILURE_LINES = 40;
const FALLBACK_HEAD_LINES = 10;
const FALLBACK_TAIL_LINES = 15;
const SNIPPED = "...[SNIPPED]...";

/**
 * Condense a build/test log to its signal without calling any model.
 *
 * - Logs that already fit within the failure cap pass through unchanged.
 * - Otherwise internal runtime frames are stripped and failure-clue lines are
 *   kept, capped at {@link MAX_FAILURE_LINES}.
 * - When no failure clues are found, a deterministic head/tail splice keeps the
 *   extract bounded (errors usually live at the tail).
 * - Empty input returns ""; any input is reduced to a finite string and never
 *   throws.
 */
export function condenseLog(raw: string): string {
  if (raw.trim().length === 0) {
    return "";
  }

  const lines = raw.split("\n");

  // Small logs pass through unchanged — nothing to slice if it is already short.
  if (lines.length <= MAX_FAILURE_LINES) {
    return raw;
  }

  const failures: string[] = [];
  for (const line of lines) {
    if (NOISE_FRAME.some((pattern) => pattern.test(line))) {
      continue;
    }
    if (FAILURE_CLUE.some((pattern) => pattern.test(line))) {
      failures.push(line);
    }
  }

  if (failures.length > 0) {
    return failures.slice(0, MAX_FAILURE_LINES).join("\n");
  }

  // Deterministic fallback: head + tail where errors usually live.
  return [
    ...lines.slice(0, FALLBACK_HEAD_LINES),
    SNIPPED,
    ...lines.slice(-FALLBACK_TAIL_LINES),
  ].join("\n");
}
