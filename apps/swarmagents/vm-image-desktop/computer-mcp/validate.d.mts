/**
 * Ambient types for `validate.mjs` (the shared computer-use MCP validator).
 * The implementation is the single source of truth; these declarations mirror
 * its exported surface so TS callers (harness/risk layer, tests) typecheck
 * against the same module the VM server executes.
 */

export interface ParsedToolArgs {
  ok: boolean;
  /** Error reason when ok is false. */
  error?: string;
  /** argv arrays (without the program name) to execute, when ok. */
  cmds: string[][];
}

/** App names open_app accepts (the fixed launch allowlist). */
export const OPEN_APP_NAMES: readonly string[];

/** All tool names the computer MCP server exposes. */
export const COMPUTER_TOOLS: readonly string[];

/** Validate a tool call; produces safe argv arrays (never a shell string). */
export function parseToolArgs(tool: string, args: Record<string, unknown>): ParsedToolArgs;

/** Short human-readable summary of a tool call (for telemetry/activity strip). */
export function summarizeTool(tool: string, args: Record<string, unknown>): string;

/** Window entry parsed from wmctrl -lG for non-vision LLM targeting. */
export interface WmctrlWindow {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  title: string;
}

/** OCR text bounding box parsed from Tesseract TSV output. */
export interface OcrTarget {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/** Parse `wmctrl -lG` stdout into window records with clickable center coords. */
export function parseWmctrlWindows(stdout: string): WmctrlWindow[];

/** Parse Tesseract TSV output into grouped clickable text coordinates. */
export function parseTesseractTsv(tsv: string, maxItems?: number): OcrTarget[];
