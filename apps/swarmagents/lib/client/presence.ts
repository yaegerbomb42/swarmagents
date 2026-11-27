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
import { parseEffectLine, type ActionEffect } from "./effect";

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

/* ------------------------------------------------------------------ *
 * Computer-use action telemetry — the live desktop overlay's input.
 *
 * The harness gives the agent two ways to drive the screen: the
 * computer-mcp server (screenshot/click/type/key/scroll/...) on the desktop
 * framebuffer, and the Playwright MCP servers (browser_navigate/browser_click/
 * ...) in Chromium. Both arrive in the run stream as tool calls
 * (`mcp__<server>__<tool>`, sometimes bare) and as `computer.action`
 * telemetry events. This section parses either shape into one structured
 * action the DesktopView overlay can render: where the agent touched, what
 * it did, and a safe human detail. Typed text is never carried — only its
 * length — and key combos are restricted to the keysym charset, because the
 * overlay renders on every surface the activity strip does.
 * ------------------------------------------------------------------ */

/** The desktop VM's framebuffer: computer-mcp coordinates live here. */
export const DESKTOP_FRAMEBUFFER: FramebufferSize = { width: 1600, height: 900 };
/** The headless browser viewport: browser-surface coordinates live here. */
export const BROWSER_VIEWPORT: FramebufferSize = { width: 1280, height: 800 };

export interface FramebufferSize {
  width: number;
  height: number;
}

/** The computer-use actions the overlay knows how to show. */
export type ComputerActionKind =
  | "click"
  | "double_click"
  | "move"
  | "type"
  | "keypress"
  | "scroll"
  | "navigate"
  | "screenshot";

/**
 * One parsed computer-use action. Coordinates are clamped framebuffer pixels
 * (see framebuffer); actions without a screen target (type, navigate,
 * screenshot) carry no coordinates and the overlay shows only the HUD chip.
 * `detail` is safe to render: app names, key combos, URL hosts, element
 * descriptions, typed-character counts — never typed content.
 */
export interface ComputerAction {
  kind: ComputerActionKind;
  /** Clamped framebuffer coordinates, when the action has a screen target. */
  x?: number;
  y?: number;
  /** Safe human detail (see above). */
  detail?: string;
  /** Epoch ms of the action. */
  at: number;
  /** The framebuffer the coordinates were clamped to (overlay positioning). */
  framebuffer: FramebufferSize;
  /**
   * The action effect from the tool result (core-23): what the screen did
   * after the action settled. Set when the run stream paired this action's
   * tool.call with a tool.result whose output carried an effect line.
   */
  effect?: ActionEffect;
}

/** Key-combo charset: printable keysym names plus modifiers, no shell chars. */
export function sanitizeKeyCombo(text: string): string {
  return text.replace(/[^A-Za-z0-9_+\-]/g, "").slice(0, 32);
}

/** A coordinate argument: a finite number, or an integer string ("640"). */
function toCoord(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

/**
 * Clamp a point onto the framebuffer (valid pixel indices: 0..width-1,
 * 0..height-1). Returns null when either coordinate is missing or invalid —
 * the caller keeps the action but drops the point, so a malformed click
 * still narrates instead of pointing off-screen.
 */
export function clampFramebufferPoint(
  x: number | undefined,
  y: number | undefined,
  framebuffer: FramebufferSize,
): { x: number; y: number } | null {
  if (x === undefined || y === undefined) return null;
  return {
    x: Math.min(Math.max(x, 0), Math.max(framebuffer.width - 1, 0)),
    y: Math.min(Math.max(y, 0), Math.max(framebuffer.height - 1, 0)),
  };
}

function capText(value: string, max = 80): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** URL host for a navigation target, or the raw string capped. */
function hostOfUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).hostname || capText(trimmed);
  } catch {
    return capText(trimmed.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? trimmed);
  }
}

/** The element/ref description a Playwright call names, capped. */
function elementDetail(input: Record<string, unknown>): string | undefined {
  const element = str(input.element) ?? str(input.target);
  return element ? capText(element) : undefined;
}

/** "Typing (12 chars)" — length only, never the typed content. */
function typeDetail(input: Record<string, unknown>): string | undefined {
  const text = str(input.text);
  return text !== undefined ? `(${text.length} chars)` : undefined;
}

/** "down", "up and left" — the scroll direction from dx/dy deltas. */
function scrollDirection(dx: number | undefined, dy: number | undefined): string | undefined {
  const parts: string[] = [];
  if (dy !== undefined && dy > 0) parts.push("down");
  if (dy !== undefined && dy < 0) parts.push("up");
  if (dx !== undefined && dx > 0) parts.push("right");
  if (dx !== undefined && dx < 0) parts.push("left");
  return parts.length > 0 ? parts.join(" and ") : undefined;
}

/** Split `mcp__<server>__<tool>`; bare tool names get an empty server. */
function splitMcpName(name: string): { server: string; tool: string } {
  const parts = name.split("__");
  if (parts.length < 2) return { server: "", tool: name };
  return { server: parts[parts.length - 2] ?? "", tool: parts[parts.length - 1] ?? "" };
}

/** computer-mcp tools this parser covers (the task's eight actions). */
const COMPUTER_TOOLS = new Set([
  "click",
  "double_click",
  "move",
  "type",
  "key",
  "scroll",
  "screenshot",
]);

function pointAction(
  kind: ComputerActionKind,
  input: Record<string, unknown>,
  at: number,
  framebuffer: FramebufferSize,
  detail?: string,
): ComputerAction {
  const point = clampFramebufferPoint(toCoord(input.x), toCoord(input.y), framebuffer);
  const action: ComputerAction = { kind, at, framebuffer };
  if (point) {
    action.x = point.x;
    action.y = point.y;
  }
  if (detail) action.detail = detail;
  return action;
}

/**
 * Parse one computer-use tool call into a structured action, or null when
 * the call is not a computer-use action (or not one of the eight the overlay
 * shows). Coordinates are clamped onto `framebuffer` (default: the desktop
 * framebuffer); `at` defaults to now.
 */
export function parseComputerAction(
  name: string,
  input: unknown,
  at: number = Date.now(),
  framebuffer: FramebufferSize = DESKTOP_FRAMEBUFFER,
): ComputerAction | null {
  const { server, tool } = splitMcpName(name);
  if (!tool) return null;
  const args = isRecord(input) ? input : {};
  const isComputer =
    server === "computer-mcp" || (server === "" && COMPUTER_TOOLS.has(tool));
  const isPlaywright =
    server === "playwright-mcp" ||
    server === "browser-mcp" ||
    (server === "" && tool.startsWith("browser_"));

  if (isComputer) {
    switch (tool) {
      case "click": {
        const button = toCoord(args.button);
        const detail =
          button === 3 ? "Right-click" : button === 2 ? "Middle-click" : undefined;
        return pointAction("click", args, at, framebuffer, detail);
      }
      case "double_click":
        return pointAction("double_click", args, at, framebuffer);
      case "move":
        return pointAction("move", args, at, framebuffer);
      case "type":
        return { kind: "type", detail: typeDetail(args), at, framebuffer };
      case "key": {
        const combo = str(args.combo);
        const detail = combo ? sanitizeKeyCombo(combo) : undefined;
        return { kind: "keypress", detail, at, framebuffer };
      }
      case "scroll":
        return {
          kind: "scroll",
          detail: scrollDirection(toCoord(args.dx), toCoord(args.dy)),
          at,
          framebuffer,
        };
      case "screenshot":
        return { kind: "screenshot", at, framebuffer };
      default:
        return null;
    }
  }

  if (isPlaywright) {
    switch (tool) {
      case "browser_navigate": {
        const url = str(args.url) ?? "";
        return { kind: "navigate", detail: hostOfUrl(url) || undefined, at, framebuffer };
      }
      case "browser_click":
        return { kind: "click", detail: elementDetail(args), at, framebuffer };
      case "browser_type":
        return {
          kind: "type",
          detail: typeDetail(args) ?? elementDetail(args),
          at,
          framebuffer,
        };
      case "browser_press_key": {
        const key = str(args.key);
        const detail = key ? sanitizeKeyCombo(key) : undefined;
        return { kind: "keypress", detail, at, framebuffer };
      }
      case "browser_mouse_wheel":
        return {
          kind: "scroll",
          detail: scrollDirection(toCoord(args.deltaX), toCoord(args.deltaY)),
          at,
          framebuffer,
        };
      case "browser_hover":
        return { kind: "move", detail: elementDetail(args), at, framebuffer };
      case "browser_snapshot":
      case "browser_accessible_snapshot":
      case "browser_take_screenshot":
        return { kind: "screenshot", at, framebuffer };
      default:
        return null;
    }
  }

  return null;
}

/**
 * Parse a `computer.action` telemetry event payload ({ action, x?, y?,
 * text?, target?, url? }) into a structured action. Best-effort: the
 * `action` field is the harness's human summary (see summarizeTool /
 * describeDesktopAction), so the kind is inferred from its prefix and the
 * coordinates come from the structured x/y fields. Tool-call parsing
 * (parseComputerAction) is authoritative when both are available.
 */
export function computerActionFromEvent(
  data: unknown,
  at: number = Date.now(),
  framebuffer: FramebufferSize = DESKTOP_FRAMEBUFFER,
): ComputerAction | null {
  if (!isRecord(data)) return null;
  const summary = str(data.action);
  const point = clampFramebufferPoint(toCoord(data.x), toCoord(data.y), framebuffer);
  const target = str(data.target);
  const url = str(data.url);
  const text = str(data.text);
  const withPoint = (
    kind: ComputerActionKind,
    detail?: string,
  ): ComputerAction => {
    const action: ComputerAction = { kind, at, framebuffer };
    if (point) {
      action.x = point.x;
      action.y = point.y;
    }
    if (detail) action.detail = detail;
    return action;
  };

  if (!summary) {
    if (url) return { kind: "navigate", detail: hostOfUrl(url) || undefined, at, framebuffer };
    return null;
  }
  if (summary === "Taking a screenshot" || summary === "Reading the page") {
    return { kind: "screenshot", at, framebuffer };
  }
  if (summary.startsWith("Double-clicking at")) return withPoint("double_click");
  if (
    summary.startsWith("Right-clicking at") ||
    summary.startsWith("Middle-clicking at") ||
    summary.startsWith("Clicking at")
  ) {
    const detail = summary.startsWith("Right-clicking")
      ? "Right-click"
      : summary.startsWith("Middle-clicking")
        ? "Middle-click"
        : undefined;
    return withPoint("click", detail);
  }
  if (summary.startsWith("Moving pointer to")) return withPoint("move");
  if (summary.startsWith("Dragging from")) return withPoint("move", "Drag");
  if (summary.startsWith("Typing (")) {
    const chars = summary.match(/\((\d+) chars\)/);
    return { kind: "type", detail: chars ? `(${chars[1]} chars)` : undefined, at, framebuffer };
  }
  if (summary.startsWith("Pressing ")) {
    const combo = text ? sanitizeKeyCombo(text) : sanitizeKeyCombo(summary.slice("Pressing ".length));
    return { kind: "keypress", detail: combo || undefined, at, framebuffer };
  }
  if (summary.startsWith("Scrolling")) {
    const detail = summary.slice("Scrolling".length).trim() || undefined;
    return { kind: "scroll", detail, at, framebuffer };
  }
  if (summary.startsWith("Clicking ")) {
    return withPoint("click", (target ?? summary.slice("Clicking ".length).trim()) || undefined);
  }
  if (summary.startsWith("Typing into ")) {
    return { kind: "type", detail: target, at, framebuffer };
  }
  if (summary.startsWith("Hovering ")) {
    return withPoint("move", (target ?? summary.slice("Hovering ".length).trim()) || undefined);
  }
  if (summary === "Moving the pointer") return withPoint("move");
  if (summary === "Scrolling the page") return { kind: "scroll", at, framebuffer };
  if (summary.startsWith("Opening ")) {
    const detail =
      target ?? (url ? hostOfUrl(url) : undefined) ?? summary.slice("Opening ".length).trim();
    return { kind: "navigate", detail: detail || undefined, at, framebuffer };
  }
  if (summary === "Opening a new tab") return { kind: "navigate", at, framebuffer };
  return null;
}

/**
 * One short HUD line for an action ("Clicking (640, 420)", "Typing…").
 * Coordinates win over the detail; the detail is the fallback when the
 * action has no screen target.
 */
export function computerActionLabel(action: ComputerAction): string {
  const hasPoint = action.x !== undefined && action.y !== undefined;
  const point = hasPoint ? `(${action.x}, ${action.y})` : undefined;
  switch (action.kind) {
    case "click": {
      const verb =
        action.detail === "Right-click"
          ? "Right-clicking"
          : action.detail === "Middle-click"
            ? "Middle-clicking"
            : "Clicking";
      if (point) return `${verb} ${point}`;
      if (action.detail && action.detail !== "Right-click" && action.detail !== "Middle-click") {
        return `Clicking ${action.detail}`;
      }
      return verb;
    }
    case "double_click":
      return point ? `Double-clicking ${point}` : "Double-clicking";
    case "move":
      if (point) return `Moving to ${point}`;
      if (action.detail) return `Moving to ${action.detail}`;
      return "Moving the pointer";
    case "type":
      return action.detail ? `Typing ${action.detail}` : "Typing…";
    case "keypress":
      return action.detail ? `Pressing ${action.detail}` : "Pressing a key";
    case "scroll":
      return action.detail ? `Scrolling ${action.detail}` : "Scrolling";
    case "navigate":
      return action.detail ? `Opening ${action.detail}` : "Opening a page";
    case "screenshot":
      return "Taking a screenshot";
  }
}

/**
 * Fold the run stream into the latest computer-use action, for the desktop
 * overlay. Tool calls are authoritative; `computer.action` telemetry events
 * are the fallback when a stream carries only those. Returns undefined when
 * the stream has no computer-use action.
 *
 * Tool results pair with their calls by id: a result whose output carries a
 * computer-mcp effect line (core-23) attaches it to the same action, so the
 * overlay chip can show what the screen did after the action settled.
 */
export function deriveComputerAction(items: readonly RunStreamItem[]): ComputerAction | undefined {
  let latest: ComputerAction | undefined;
  const callsById = new Map<string, ComputerAction>();
  for (const item of items) {
    if (item.kind === "tool.call") {
      const payload = payloadOf(item);
      const name = str(payload.name);
      if (!name) continue;
      const action = parseComputerAction(name, payload.input, item.ts);
      if (action) {
        latest = action;
        const id = str(payload.id);
        if (id) callsById.set(id, action);
      }
    } else if (item.kind === "tool.result") {
      const payload = payloadOf(item);
      const id = str(payload.id);
      const call = id ? callsById.get(id) : undefined;
      if (id && call) callsById.delete(id);
      if (!call) continue;
      const output = str(payload.output);
      const effect = output ? parseEffectLine(output) : null;
      if (effect) call.effect = effect;
    } else if (item.kind === "computer.action") {
      const action = computerActionFromEvent(payloadOf(item), item.ts);
      if (action) latest = action;
    }
  }
  return latest;
}

/**
 * Epoch ms of the newest non-escalated `watchdog.loop` nudge (core-21), or
 * undefined when the stream carries none. Escalation halts the run — it is
 * not a "nudged" moment, so it is skipped.
 */
export function lastLoopNudgeAt(items: readonly RunStreamItem[]): number | undefined {
  let at: number | undefined;
  for (const item of items) {
    if (item.kind !== "watchdog.loop") continue;
    const payload = payloadOf(item);
    if (payload.action === "escalate") continue;
    at = item.ts;
  }
  return at;
}
