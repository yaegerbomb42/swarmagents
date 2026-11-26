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

/** Modes the `type` tool accepts ("auto" | "keys" | "paste"). */
export const TYPE_MODES: readonly string[];

/**
 * Choose the input method for a `type` call. Auto uses paste for text longer
 * than 200 chars, multiline text, or non-ASCII text — else keys. Returns null
 * (invalid) for any other `mode` value.
 */
export function chooseTypeMode(text: string, mode?: string): "keys" | "paste" | null;

/** Marker argv command for the paste path (handled by the server, never spawned). */
export const TYPE_PASTE_MARKER: string;

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

/** One AT-SPI2 widget parsed from atspi_dump.py output, with a clickable center. */
export interface UiNode {
  app: string;
  role: string;
  name: string;
  /** Subset of: focused, focusable, enabled, checked, pressed, selected, expanded, editable, modal, active. */
  states: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export interface AtspiDump {
  ok: boolean;
  error?: string;
  apps: string[];
  truncated: boolean;
  nodes: UiNode[];
}

/** Parse atspi_dump.py JSON into sanitized widget records (never throws). */
export function parseAtspiDump(stdout: string, maxItems?: number): AtspiDump;

/** Narrow widgets by name query / role substring and cap the count. */
export function filterUiNodes(nodes: UiNode[], opts?: { query?: string; role?: string; maxItems?: number }): UiNode[];

/** Render widgets as compact text lines with click(x, y) targets. */
export function formatUiNodes(nodes: UiNode[]): string;

/** Find the best OCR target matching `query` (exact match preferred). */
export function findTextTarget(
  targets: readonly OcrTarget[],
  query: string,
  options?: { exact?: boolean },
): OcrTarget | null;

/**
 * Map common argument slips to canonical names (core-37): key {key|keys} ->
 * combo ("Enter" -> "Return"), focus_window {window_title|window_name} ->
 * title, open_app {app|app_name} -> name (+ everyday app names), type
 * {submit:true} -> trailing newline, click {coordinate:[x,y]} -> x/y.
 */
export function normalizeToolArgs(tool: string, args: unknown): Record<string, unknown>;

/** "Enter" -> "Return", "Control+L" -> "ctrl+L", ["ctrl","l"] -> "ctrl+l". */
export function normalizeKeyCombo(value: unknown): unknown;

/** Keys that run or discard a line typed at a terminal prompt (Return, KP_Enter, ctrl+u, ctrl+c). */
export function clearsTerminalLine(combo: unknown): boolean;
