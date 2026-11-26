/**
 * Ambient types for `paste.mjs` (the computer-mcp paste plumbing).
 * The implementation is the single source of truth; these declarations mirror
 * its exported surface so TS callers (harness/risk layer, tests) typecheck
 * against the same module the VM server executes.
 */

/** X window classes whose paste chord is Ctrl+Shift+V instead of Ctrl+V. */
export const TERMINAL_CLASSES: readonly string[];

/** True when a focused-window class string names a paste-with-Shift terminal. */
export function isTerminalClass(name: unknown): boolean;

/** One argv command result. */
export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn one argv command and resolve its result; never rejects. */
export function runCmd(
  spawnImpl: (command: string, args: string[], options: Record<string, unknown>) => unknown,
  program: string,
  args: string[],
  opts: {
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  },
): Promise<CmdResult>;

/** The focused window's WM_CLASS, or "" when it cannot be determined. */
export function activeWindowClass(opts?: {
  spawnImpl?: (command: string, args: string[], options: Record<string, unknown>) => unknown;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<string>;

/** Paste `text` into the focused window (clipboard, chord, restore). */
export function pasteText(
  text: string,
  opts?: {
    spawnImpl?: (command: string, args: string[], options: Record<string, unknown>) => unknown;
    env?: Record<string, string | undefined>;
    settleMs?: number;
    restoreMs?: number;
    timeoutMs?: number;
  },
): Promise<
  | { ok: true; mode: "paste"; chars: number; ms: number; combo: string }
  | { ok: false; error: string }
>;
