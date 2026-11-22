/**
 * Pure log condenser ported from vendor/claude-code-mini/src/logCondenser.ts.
 *
 * Only the deterministic pieces are extracted here: CRLF/ANSI normalization,
 * noise-frame stripping, failure-line retention (capped at {@link MAX_FAILURE_LINES}),
 * head+tail failure preservation, and a hard output-size cap. There is no LLM
 * step and no wiring into the runner, oracle, or report — this module just turns
 * a noisy build/test log into a bounded, readable extract (wiring is a separate
 * decision).
 */

// Internal runtime boilerplate frames that carry no diagnostic value.
const NOISE_FRAME = [/node:internal/i, /node_modules/i, /at async Promise/i];

// Lines that hint at an actual failure worth surfacing.
const FAILURE_CLUE = [
  /fail/i,
  /fatal/i,
  /crash/i,
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
const TRUNCATED = "...[TRUNCATED]...";
/** Default ceiling on the number of characters returned. */
export const DEFAULT_MAX_CHARS = 20_000;

// Lines that look like failure clues but actually report zero failures
// (a test summary such as "0 failed", "# fail 0" or "0 errors") must not
// be kept as failure evidence.
const SUCCESS_SUMMARY =
  /(\b0\s+(failed|failures?|errors?)\b|#\s*fail\s+0\b|\b(?:failed|errors?)\s*:\s*0\b)/i;

// CSI (colour/cursor, e.g. SGR "\x1b[31m") and OSC (title/hyperlink) sequences.
// Stripping them before matching stops escape codes from hiding failure clues
// and keeps the extract readable. Built from char codes so the source contains
// no literal control characters (Sonar S6324).
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const ANSI_ESCAPE = new RegExp(
  String.raw`${ESC}(?:\[[0-?]*[ -/]*[@-~]|\][^${BEL}]*(?:${BEL}|${ESC}\\))`,
  "g",
);

export interface CondenseOptions {
  /** Hard cap on the condensed output length, in characters. */
  maxChars?: number;
}

function capChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= TRUNCATED.length) return value.slice(0, maxChars);
  return value.slice(0, maxChars - TRUNCATED.length) + TRUNCATED;
}

/** Keep the first and last slices so root causes at the tail are not lost. */
function headTail<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return [...items.slice(0, head), ...items.slice(-tail)];
}

/**
 * Condense a build/test log to its signal without calling any model.
 *
 * - CRLF/CR line endings are normalized and ANSI escape sequences are stripped
 *   before any matching.
 * - Logs that already fit within the failure cap pass through unchanged.
 * - Otherwise internal runtime frames are stripped, repeated failure lines are
 *   deduplicated, and failure-clue lines are kept (capped at
 *   {@link MAX_FAILURE_LINES} with head+tail preservation). Lines that only
 *   report zero failures ("0 failed", "0 errors") are not failure clues.
 * - When no failure clues are found, a deterministic head/tail splice keeps the
 *   extract bounded (errors usually live at the tail).
 * - The result is always capped at `maxChars`, including a single huge line.
 * - Empty input returns ""; any input is reduced to a finite string and never
 *   throws.
 */
export function condenseLog(raw: string, options: CondenseOptions = {}): string {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
  // Normalize line endings first, then strip terminal escape codes.
  const normalized = raw.replace(/\r\n?/g, "\n").replace(ANSI_ESCAPE, "");
  if (normalized.trim().length === 0) {
    return "";
  }

  const lines = normalized.split("\n");

  const result =
    lines.length <= MAX_FAILURE_LINES
      ? normalized // small logs pass through (still bounded by maxChars below)
      : extractSignal(lines, maxChars);

  return capChars(result, maxChars);
}

/**
 * Extract the signal lines from a log too large to pass through: drop noise
 * frames, dedupe repeated failure lines, and keep the head+tail of what
 * remains. Falls back to a deterministic head/tail splice when nothing
 * failure-like is found.
 */
function extractSignal(lines: string[], maxChars: number): string {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (NOISE_FRAME.some((pattern) => pattern.test(line))) {
      continue;
    }
    if (FAILURE_CLUE.some((pattern) => pattern.test(line)) && !SUCCESS_SUMMARY.test(line)) {
      const key = line.trim();
      if (seen.has(key)) continue; // dedupe repeated failure lines
      seen.add(key);
      failures.push(line);
    }
  }

  if (failures.length > 0) {
    return headTail(failures, MAX_FAILURE_LINES).map((line) => capChars(line, maxChars)).join("\n");
  }

  // Deterministic fallback: head + tail where errors usually live.
  return [
    ...lines.slice(0, FALLBACK_HEAD_LINES),
    SNIPPED,
    ...lines.slice(-FALLBACK_TAIL_LINES),
  ].join("\n");
}
