/**
 * Duplicate-action loop breaker (core-21).
 *
 * Catches the classic computer-use failure: the agent repeats the exact same
 * action (same tool, same input) and gets the exact same output, over and
 * over, because the action is not doing anything. The breaker is always on
 * and costs nothing: one hash per tool result.
 *
 * Escalation ladder:
 *   1. Third identical (action, output) in a row -> **nudge**. The runner
 *      emits `watchdog.loop` (action "nudge") and the manager arms a one-shot
 *      deny for that exact call at the PreToolUse hook. If the model tries it
 *      a fourth time, the call does not run and the model gets the nudge text
 *      as the tool error, so it changes approach without losing any work.
 *   2. Same action repeats three more times after the nudge -> **escalate**:
 *      the runner halts the run with a clear reason. Nothing is rewound.
 *
 * Navigation, waiting and observation are exempt: scrolling a page, tabbing
 * through a form, waiting for a page or polling a server legitimately repeat
 * the same call with the same output.
 */

import { createHash } from "node:crypto";

/** Tools that legitimately repeat with identical output (matched by the last `__` segment). */
export const LOOP_EXEMPT_TOOLS = new Set([
  // computer-mcp navigation / waiting / observation
  "scroll",
  "key",
  "move",
  "wait",
  "screenshot",
  "describe_screen",
  "read_window_text",
  "inspect_ui",
  "wait_for_ui",
  "wait_for_text",
  "wait_for_screen_change",
  "clipboard_get",
  // Playwright MCP
  "browser_snapshot",
  "browser_wait_for",
  "browser_press_key",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  // Claude Code built-ins that only observe
  "Read",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
  "BashOutput",
]);

const SHELL_TOOLS = new Set(["Bash", "Shell", "Terminal", "cmd"]);

/** `sleep 5`, `curl -s localhost:3000/health`, `sleep 2 && curl ...`: waiting for something. */
const POLL_COMMAND_RE =
  /^\s*(?:sleep\s+[\d.]+[smh]?\s*(?:;|&&)\s*)*(?:sleep\s+[\d.]+[smh]?|curl\b|wget\b|nc\s+-z\b|pg_isready\b|docker\s+(?:ps|logs)\b|kubectl\s+get\b|tail\b|ps\b|pgrep\b|ss\b|netstat\b|git\s+(?:status|log|diff)\b)/;

export const LOOP_THRESHOLD = 3;

export function baseToolName(toolName: string | undefined): string {
  if (!toolName) return "";
  const parts = toolName.split("__");
  return parts[parts.length - 1] ?? toolName;
}

export function isLoopExempt(toolName: string | undefined, input: unknown): boolean {
  const base = baseToolName(toolName);
  if (!base) return true;
  if (LOOP_EXEMPT_TOOLS.has(base)) return true;
  if (SHELL_TOOLS.has(base)) {
    const command =
      input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
        ? (input as { command: string }).command
        : "";
    return POLL_COMMAND_RE.test(command);
  }
  return false;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`)
    .join(",")}}`;
}

/** Deterministic fingerprint of a tool call: name + canonical (key-sorted) input. */
export function actionFingerprint(toolName: string | undefined, input: unknown): string {
  return createHash("sha256")
    .update(`${toolName ?? "unknown"}:${stableJson(input ?? {})}`, "utf8")
    .digest("hex");
}

/**
 * Hash of the tool output with volatile noise removed (timestamps, durations,
 * hex ids), so "clicked at 12:00:01" and "clicked at 12:00:03" compare equal.
 */
export function outputHash(output: string): string {
  const normalized = output
    .slice(0, 4000)
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, "<ts>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "<dur>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function loopNudgeText(toolName: string | undefined): string {
  return (
    `Loop breaker: you ran the exact same ${baseToolName(toolName) || "tool"} call ${LOOP_THRESHOLD} times ` +
    `and got the same result each time, so it is not changing anything. This repeat was not executed. ` +
    `Do NOT repeat that same call. Re-read the screen (screenshot, describe_screen or inspect_ui), check which ` +
    `window has focus, and try a different approach (different target, keyboard shortcut, or another tool).`
  );
}

export type LoopVerdict =
  | { kind: "none" }
  | { kind: "nudge"; fingerprint: string; message: string }
  | { kind: "escalate"; fingerprint: string; message: string };

export interface LoopObservation {
  toolName: string | undefined;
  input: unknown;
  output: string;
}

export class LoopBreaker {
  private lastKey: string | null = null;
  private streak = 0;
  private readonly nudged = new Set<string>();

  constructor(private readonly threshold = LOOP_THRESHOLD) {}

  observe(obs: LoopObservation): LoopVerdict {
    if (isLoopExempt(obs.toolName, obs.input)) {
      // Exempt calls are neutral: they neither extend nor break a streak, so
      // "click, screenshot, click, screenshot, click" is still caught.
      return { kind: "none" };
    }
    const fingerprint = actionFingerprint(obs.toolName, obs.input);
    const key = `${fingerprint}:${outputHash(obs.output)}`;
    if (key === this.lastKey) this.streak += 1;
    else {
      this.lastKey = key;
      this.streak = 1;
    }
    if (this.streak < this.threshold) return { kind: "none" };
    this.streak = 0;
    if (this.nudged.has(fingerprint)) {
      return {
        kind: "escalate",
        fingerprint,
        message:
          `loop breaker: the same ${baseToolName(obs.toolName)} call kept repeating with identical output ` +
          `after a nudge; stopping the run instead of looping.`,
      };
    }
    this.nudged.add(fingerprint);
    return { kind: "nudge", fingerprint, message: loopNudgeText(obs.toolName) };
  }
}

/** One armed nudge per run: deny the next call only if it is the looping call. */
export interface PendingLoopNudge {
  fingerprint: string;
  message: string;
}

/**
 * Decide a hook call against an armed nudge. Returns the deny reason when the
 * call is the exact looping action, else null. The nudge is one-shot either
 * way: a different call means the model already changed approach.
 */
export function consumeLoopNudge(
  pending: PendingLoopNudge | undefined,
  toolName: string,
  input: unknown,
): string | null {
  if (!pending) return null;
  return actionFingerprint(toolName, input) === pending.fingerprint ? pending.message : null;
}
