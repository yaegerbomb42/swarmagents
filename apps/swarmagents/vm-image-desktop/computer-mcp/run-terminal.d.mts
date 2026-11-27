/**
 * Ambient types for `run-terminal.mjs` (the computer-use MCP run_in_terminal
 * diff/settle helpers). The implementation is the single source of truth;
 * these declarations mirror its exported surface so TS callers (tests)
 * typecheck against the same module the VM server executes.
 */

/** Fallback: when no pre-command lines match, return this many newest lines. */
export const RUN_TERMINAL_FALLBACK_LINES: number;
/** Default poll interval between screen reads (ms). */
export const RUN_TERMINAL_POLL_MS: number;

/** Normalize one OCR line for comparison (collapse whitespace, trim, lowercase). */
export function normalizeOcrLine(line: unknown): string;

/** Are two OCR line arrays equal (normalized comparison)? */
export function sameLines(a: unknown, b: unknown): boolean;

export interface DiffNewLinesResult {
  lines: string[];
  /** True when a prefix of the pre-command read matched (a tail diff happened). */
  matchedBefore: boolean;
}

/**
 * The lines that appeared after the command line: the newest OCR read minus
 * the longest prefix matching the pre-command read; when nothing matches, the
 * last `fallbackLines` (default 40) newest lines.
 */
export function diffNewLines(
  current: readonly string[],
  before: readonly string[],
  options?: { fallbackLines?: number },
): DiffNewLinesResult;

/** A terminal reader: resolves `{ ok: true, lines }` or `{ ok: false, error }`. */
export interface TerminalReadResult {
  ok: boolean;
  lines?: string[];
  error?: string;
}
export type TerminalReader = () => Promise<TerminalReadResult> | TerminalReadResult;

export interface SettleTerminalResult {
  /** True when two consecutive reads were identical before the timeout. */
  settled: boolean;
  /** The last successful read's lines (empty when no read ever succeeded). */
  lines: string[];
  /** Wall time spent polling, in ms. */
  elapsedMs: number;
}

/**
 * Poll `read` every ~intervalMs until two consecutive reads are identical
 * (screen settled) or `timeoutMs` elapses. Failed reads are skipped. Never
 * throws.
 */
export function settleTerminal(
  read: TerminalReader,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<SettleTerminalResult>;
