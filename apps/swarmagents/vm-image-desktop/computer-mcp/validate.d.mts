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

/** All tool names the computer MCP server exposes. */
export const COMPUTER_TOOLS: readonly string[];

/** Validate a tool call; produces safe argv arrays (never a shell string). */
export function parseToolArgs(tool: string, args: Record<string, unknown>): ParsedToolArgs;

/** Short human-readable summary of a tool call (for telemetry/activity strip). */
export function summarizeTool(tool: string, args: Record<string, unknown>): string;
