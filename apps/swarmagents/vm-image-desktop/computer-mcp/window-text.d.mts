/**
 * Ambient types for `window-text.mjs` (the computer-use MCP window-text
 * capture module). The implementation is the single source of truth; these
 * declarations mirror its exported surface so TS callers (server tests)
 * typecheck against the same module the VM server executes.
 */

/** Default max lines returned by read_window_text (last lines = newest). */
export const DEFAULT_WINDOW_TEXT_LINES: number;
/** Hard cap for maxLines (validated in validate.mjs, clamped here too). */
export const MAX_WINDOW_TEXT_LINES: number;
/** The OCR mode: uniform block — ordered text lines, not sparse word targets. */
export const WINDOW_TEXT_PSM: string;

/** Capture result when the window was read successfully. */
export interface WindowTextResult {
  ok: true;
  title: string;
  /** "x,y w xh" (wmctrl frame geometry of the window that was read). */
  geometry: string;
  /** Ordered text lines (last maxLines), newest at the end. */
  lines: string[];
  /** True when more lines were detected than returned. */
  truncated: boolean;
}

export type WindowTextCaptureResult = WindowTextResult | { ok: false; error: string };

/** The injectable spawn runner signature (server.mjs's `run`). */
export type RunSpawn = (
  program: string,
  args: string[],
  options?: { timeoutMs?: number; env?: Record<string, string | undefined> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Capture the text of a window (active, or title-matched when `title` is
 * given) via wmctrl geometry + scrot + ImageMagick crop + tesseract --psm 6.
 * Never throws; resolves `{ ok: true, ... }` or `{ ok: false, error }`.
 */
export function captureWindowText(options: {
  run: RunSpawn;
  title?: string;
  maxLines?: number;
  env?: Record<string, string | undefined>;
}): Promise<WindowTextCaptureResult>;

/**
 * The short "Active window text (OCR, last 15 lines):" section for
 * describe_screen, computed with the same capture helper (shared code path
 * with read_window_text). Returns the section text, or null when the capture
 * cannot run (no window / missing tools) — describe_screen then simply omits
 * the section.
 */
export function activeWindowTextSection(options: {
  run: RunSpawn;
  env?: Record<string, string | undefined>;
}): Promise<string | null>;

export const DARK_MEAN_THRESHOLD: number;
export function ocrPrepArgs(meanStdout: string): string[];
