/**
 * presence.ts — "what is the agent doing right now, and what did it just
 * touch?"
 *
 * Every VM view shows the same answer. The desktop tints the region of the
 * screen that just changed; the terminal marks the newest tool line; the files
 * view highlights the file the agent wrote last; the status bar names the
 * action and the file. All of it comes from this one reducer, so the four
 * views can never disagree about what the agent is doing.
 *
 * Input: the run stream items (the same array useRunStream already keeps).
 * When another tab owns the SSE stream, the caller can pass the newest
 * activity line from its poll instead (`fromActivity`), so presence still
 * names the current action rather than going blank.
 *
 * Output: one small, memo-friendly summary:
 *
 *   action        the current tool call, humanized ("Editing src/app.py")
 *   tool          the raw tool name, for iconography
 *   file          the workspace path of the file in play (read or written)
 *   wroteFile     the last file the agent wrote (drives the files highlight)
 *   changedAt     when that happened (epoch ms), for the flash timer
 *   runState      idle · working · waiting · paused · done · failed
 *   stats         tool calls, files touched — the status bar's numbers
 *
 * Pure and DOM-free so it unit-tests with node:test; the components only own
 * timers and styling.
 */

import type { RunStreamItem } from "./useRunStream";

/** What the run itself is doing, in the same vocabulary as runPhase.ts. */
export type PresenceRunState = "idle" | "working" | "waiting" | "paused" | "done" | "failed";

/** Tools whose argument names a workspace file. */
const FILE_ARG_KEYS = ["file_path", "path", "file", "notebook_path"] as const;

/** Tool names that write, as the harness and both providers spell them. */
const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "write",
  "edit",
  "create_file",
  "str_replace_editor",
  "apply_patch",
  "fs_write",
]);

const READ_TOOLS = new Set(["Read", "read", "read_file", "fs_read", "view", "cat", "Open"]);

export interface Presence {
  /** Humanized current action ("Editing src/app.py", "Running npm test"). */
  action?: string;
  /**
   * The raw command of a shell action ("npm test"), when the action is a
   * command. The terminal's prompt shows it as the live command line.
   */
  command?: string;
  /** Raw tool name of the current (or last) call, for the view's icon. */
  tool?: string;
  /** The file the action is about (read or written), workspace-absolute. */
  file?: string;
  /** The last file the agent wrote — what the file views highlight. */
  wroteFile?: string;
  /** Epoch ms of the last write (or of the last event when no write yet). */
  changedAt?: number;
  runState: PresenceRunState;
  stats: {
    toolCalls: number;
    filesTouched: number;
    /** seq of the newest event the summary consumed. */
    seq: number;
  };
}

export const EMPTY_PRESENCE: Presence = {
  runState: "idle",
  stats: { toolCalls: 0, filesTouched: 0, seq: 0 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The stream payloads put fields at the top level or under `data`. */
function payloadOf(item: RunStreamItem): Record<string, unknown> {
  const raw = item.data;
  if (!isRecord(raw)) return {};
  const nested = raw.data;
  return isRecord(nested) ? { ...nested, ...raw } : raw;
}

function fileArg(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of FILE_ARG_KEYS) {
    const value = str(input[key]);
    if (value) return value;
  }
  return undefined;
}

/** Short tool name (`mcp__fs__write` → `write`). */
function shortToolName(name: string): string {
  return name.split("__").pop() ?? name;
}

/**
 * One human line for a tool call. Commands are commands; file tools name the
 * file; everything else names itself. Kept here (not in the terminal) so the
 * status bar and the terminal say the same words.
 */
export function describeToolCall(name: string, input: unknown): string {
  const short = shortToolName(name);
  if (!isRecord(input)) return short;
  const command = str(input.command);
  const file = fileArg(input);
  const url = str(input.url) ?? str(input.goto);
  if (command) return `${short === "Bash" ? "Running" : short} ${command}`;
  if (file) {
    if (WRITE_TOOLS.has(name) || WRITE_TOOLS.has(short)) return `Editing ${file}`;
    if (READ_TOOLS.has(name) || READ_TOOLS.has(short)) return `Reading ${file}`;
    return `${short} ${file}`;
  }
  if (url) return `Opening ${url}`;
  const pattern = str(input.pattern) ?? str(input.query);
  if (pattern) return `${short} “${pattern}”`;
  return short;
}

/** "Running npm test" → "Ran npm test", for the finished run's summary. */
export function pastTenseAction(action: string): string {
  const space = action.indexOf(" ");
  const head = space === -1 ? action : action.slice(0, space);
  const tail = space === -1 ? "" : action.slice(space);
  const past: Record<string, string> = {
    Running: "Ran",
    Editing: "Edited",
    Reading: "Read",
    Opening: "Opened",
    Searching: "Searched",
    Listing: "Listed",
    Writing: "Wrote",
  };
  const mapped = past[head];
  return mapped ? `${mapped}${tail}` : action;
}

function isWrite(name: string): boolean {
  return WRITE_TOOLS.has(name) || WRITE_TOOLS.has(shortToolName(name));
}

/**
 * Fold the run stream into the presence summary. Idempotent for a given array
 * (safe to call from a useMemo): it walks once and keeps the small state, not
 * a copy of the stream.
 */
export function derivePresence(items: readonly RunStreamItem[]): Presence {
  let runState: PresenceRunState = "idle";
  let action: string | undefined;
  let command: string | undefined;
  let tool: string | undefined;
  let file: string | undefined;
  let wroteFile: string | undefined;
  let changedAt: number | undefined;
  let toolCalls = 0;
  let seq = 0;
  const files = new Set<string>();
  let pendingCall: { name: string; file?: string } | undefined;
  let waiting = false;

  for (const item of items) {
    seq = Math.max(seq, item.seq);
    const payload = payloadOf(item);
    switch (item.kind) {
      case "run.created":
      case "run.queued":
      case "run.started":
        // A new run resets the lifecycle: the previous run's "Finished" must
        // not sit in the status bar while the next one is streaming.
        runState = "working";
        break;
      case "tool.call": {
        const name = str(payload.name) ?? "tool";
        toolCalls += 1;
        pendingCall = { name, file: fileArg(payload.input) };
        tool = name;
        action = describeToolCall(name, payload.input);
        command = isRecord(payload.input) ? str(payload.input.command) : undefined;
        if (pendingCall.file) {
          file = pendingCall.file;
          files.add(pendingCall.file);
        }
        changedAt = item.ts;
        break;
      }
      case "tool.result": {
        const ok = payload.ok !== false;
        if (!ok) {
          action = pendingCall ? `${shortToolName(pendingCall.name)} failed` : "Tool failed";
        }
        if (pendingCall && ok && isWrite(pendingCall.name) && pendingCall.file) {
          wroteFile = pendingCall.file;
          file = pendingCall.file;
          changedAt = item.ts;
        }
        pendingCall = undefined;
        break;
      }
      case "tool.blocked": {
        action = `${str(payload.name) ?? "Tool"} blocked`;
        tool = str(payload.name) ?? tool;
        pendingCall = undefined;
        break;
      }
      case "approval.required":
      case "approval.timeout":
        waiting = true;
        action = "Waiting for your approval";
        break;
      case "question.required":
        waiting = true;
        action = "Waiting for your answer";
        break;
      case "handoff.required":
        waiting = true;
        action = "Waiting for you on the desktop";
        break;
      case "approval.resolved":
      case "question.resolved":
      case "handoff.resolved":
        waiting = false;
        break;
      case "run.paused":
        runState = "paused";
        waiting = false;
        break;
      case "run.finished":
        runState = "done";
        // The action keeps naming what the run *did*, in the past tense
        // ("Ran python3 hello.py", "Edited hello.py"): the status bar then
        // reads "done · Ran python3 hello.py" instead of claiming the agent
        // is still running it.
        if (action) action = pastTenseAction(action);
        break;
      case "run.error":
        runState = "failed";
        action = str(payload.message) ?? "The run failed";
        break;
      case "run.cancelled":
        runState = "done";
        action = "Stopped by you";
        break;
      default:
        break;
    }
  }

  if (waiting) runState = "waiting";

  const presence: Presence = {
    runState,
    stats: { toolCalls, filesTouched: files.size, seq },
  };
  if (action) presence.action = action;
  if (command) presence.command = command;
  if (tool) presence.tool = tool;
  if (file) presence.file = file;
  if (wroteFile) presence.wroteFile = wroteFile;
  if (changedAt) presence.changedAt = changedAt;
  return presence;
}

/**
 * The tone the presence line uses. Same five tones as everything else, so a
 * waiting agent is amber in the status bar and amber in the chat.
 */
export function presenceTone(presence: Presence): "accent" | "ok" | "warn" | "err" | "muted" {
  switch (presence.runState) {
    case "working":
      return "accent";
    case "waiting":
      return "warn";
    case "done":
      return "ok";
    case "failed":
      return "err";
    case "paused":
      return "warn";
    default:
      return "muted";
  }
}

/** One short word for the run state (`Working`, `Waiting`, …). */
export function presenceLabel(presence: Presence): string {
  switch (presence.runState) {
    case "working":
      return "Working";
    case "waiting":
      return "Waiting";
    case "paused":
      return "Paused";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

/**
 * The region of the 1280×800 desktop a change most plausibly happened in.
 * The harness does not report desktop coordinates on every tool call, so this
 * is deliberately coarse: a file write lands in the main window area, a
 * browser action in the browser window, a shell command at the bottom. It is
 * a *hint* for the presence glow, never a claim about pixels.
 */
export function presenceHintRegion(
  presence: Presence,
): { x: number; y: number; w: number; h: number } | null {
  if (presence.runState === "idle") return null;
  if (presence.tool && presence.tool.includes("browser")) {
    return { x: 80, y: 60, w: 900, h: 620 };
  }
  if (presence.file) return { x: 60, y: 40, w: 760, h: 560 };
  if (presence.action?.startsWith("Running")) return { x: 40, y: 520, w: 1200, h: 240 };
  return null;
}


/**
 * Build presence from the polled activity lines (`buildActivityLines`), for
 * the case where another part of the page owns the run's SSE stream. The
 * lines are already humanized ("Editing src/app.py", "Running npm test"), so
 * this only classifies them; it is deliberately conservative — a line that is
 * not a file or command action leaves `file`/`command` unset rather than
 * guessing.
 */
export function presenceFromActivity(
  lines: ReadonlyArray<{ text: string }>,
  runState: PresenceRunState,
): Presence {
  let action: string | undefined;
  let command: string | undefined;
  let file: string | undefined;
  let wroteFile: string | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines[i]?.text;
    if (!text) continue;
    if (text.startsWith("Editing ") || text.startsWith("Reading ")) {
      file = text.slice(text.indexOf(" ") + 1);
      action = text;
      if (text.startsWith("Editing ")) wroteFile = file;
      break;
    }
    if (text.startsWith("Running ")) {
      command = text.slice("Running ".length);
      action = text;
      break;
    }
    if (text.startsWith("Opening ")) {
      action = text;
      break;
    }
  }
  const presence: Presence = { runState, stats: { toolCalls: 0, filesTouched: 0, seq: 0 } };
  if (action) presence.action = runState === "done" ? pastTenseAction(action) : action;
  if (command) presence.command = command;
  if (file) presence.file = file;
  if (wroteFile) presence.wroteFile = wroteFile;
  return presence;
}
