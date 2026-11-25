/**
 * traceTimeline.ts — pure grouping engine from flat SSE log events to a
 * structured per-turn trace timeline.
 *
 * The run stream is a flat log: `tool.call` / `tool.result` pairs, the
 * occasional `assistant.thinking` event (emitted by thinking-capable
 * harnesses; the in-repo gateway accumulates thinking internally today, so
 * the event may only arrive from future or replayed runs), and agent prose
 * in between. This module folds that log into TimelineSteps grouped into
 * stretches — one stretch per run of tool work between agent messages, so
 * the stretches line up 1:1 with the steps blocks buildTurnBlocks produces
 * and the UI can render one collapsible pill per stretch.
 *
 * What a step carries, and what it never carries:
 * - kind (bash|edit|read|search|mcp|browser|desktop|thinking), duration,
 *   ok/error, a one-line preview, and — for edits — a unified-diff-style
 *   preview, or the tool's stdout otherwise. Both previews are capped.
 * - Never a raw JSON dump: only whitelisted fields are read, and typed text
 *   is never carried (a `type` action's content is a secret risk; only its
 *   length is ever implied, never the text itself).
 *
 * Pure and DOM-free so it unit-tests with node:test; the component only owns
 * timers and styling. Idempotent for a given items array.
 */

import type { RunStreamItem } from "./useRunStream";
import {
  describeToolCall,
  isAskUserToolName,
  isDesktopHandoffToolName,
} from "./conversation";
import { formatStepDuration } from "./turns";

/** The step kinds the timeline renders, with one color each in the UI. */
export type TraceStepKind =
  | "bash"
  | "edit"
  | "read"
  | "search"
  | "mcp"
  | "browser"
  | "desktop"
  | "thinking";

/** A capped diff (edits) or stdout (everything else with output) preview. */
export interface TracePreview {
  kind: "diff" | "stdout";
  body: string;
  truncated: boolean;
}

/** One grouped step: a tool call with its result, or one thinking event. */
export interface TimelineStep {
  /** Stable identity: the call id when present, else a synthetic key. */
  id: string;
  kind: TraceStepKind;
  /** Raw tool name, for tool steps (absent for thinking steps). */
  toolName?: string;
  /** One human-readable line ("Editing src/app.py", "Running npm test"). */
  label: string;
  status: "running" | "done" | "error";
  /** Wall-clock timestamp of the call / thinking event (item.ts). */
  startedAt: number;
  /** Wall-clock timestamp of the matching result event. */
  endedAt?: number;
  /** result.ts - call.ts, once a result arrives. */
  durationMs?: number;
  /** undefined while running; false when the tool reported an error. */
  ok?: boolean;
  /** Short human preview shown on the step card. */
  preview: string;
  /** Diff (edits) or stdout preview, when there is anything to show. */
  diff?: TracePreview;
  /** The workspace file the step is about (read or written), when known. */
  file?: string;
}

/** One stretch of tool work between agent messages. */
export interface TimelineStretch {
  key: string;
  steps: TimelineStep[];
}

export interface TraceStretchSummary {
  count: number;
  /** A step in this stretch is still running. */
  running: boolean;
  /** Steps that finished with an error. */
  failed: number;
  /** Summed duration of finished steps; undefined when none measured. */
  durationMs?: number;
  /** The step to show while collapsed: the running one, else the last. */
  label: string;
}

const MAX_PREVIEW_CHARS = 4000;
const MAX_DIFF_LINES = 40;
const MAX_THINKING_PREVIEW = 240;

/** Tools that write, as the harness and both providers spell them. */
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

const READ_TOOLS = new Set(["Read", "read", "read_file", "fs_read", "view", "cat", "Glob", "Open"]);

const SEARCH_TOOLS = new Set(["Grep", "WebSearch", "WebFetch", "search", "grep"]);

const BASH_TOOLS = new Set(["Bash", "shell", "terminal", "exec"]);

/** computer-mcp tools, bare or under the computer-mcp server. */
const COMPUTER_TOOLS = new Set([
  "click",
  "double_click",
  "move",
  "type",
  "key",
  "scroll",
  "screenshot",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Short tool name (`mcp__fs__write` → `write`). */
function shortToolName(name: string): string {
  return name.split("__").pop() ?? name;
}

/** Split `mcp__<server>__<tool>`; bare tool names get an empty server. */
function splitMcpName(name: string): { server: string; tool: string } {
  const parts = name.split("__");
  if (parts.length < 2) return { server: "", tool: name };
  return { server: parts[parts.length - 2] ?? "", tool: parts[parts.length - 1] ?? "" };
}

/**
 * Classify a tool call into a timeline kind. Computer-use tools split by
 * server the same way presence.ts splits them: computer-mcp (or the bare
 * desktop verbs) drives the desktop framebuffer, Playwright/browser servers
 * (or `browser_*` names) drive Chromium.
 */
export function classifyToolKind(name: string): Exclude<TraceStepKind, "thinking"> {
  const { server, tool } = splitMcpName(name);
  const isComputer = server === "computer-mcp" || (server === "" && COMPUTER_TOOLS.has(tool));
  if (isComputer) return "desktop";
  const isPlaywright =
    server === "playwright-mcp" ||
    server === "playwright" ||
    server === "browser-mcp" ||
    server === "puppeteer" ||
    tool.startsWith("browser_");
  if (isPlaywright) return "browser";
  if (BASH_TOOLS.has(tool)) return "bash";
  if (WRITE_TOOLS.has(tool)) return "edit";
  if (READ_TOOLS.has(tool)) return "read";
  if (SEARCH_TOOLS.has(tool)) return "search";
  return "mcp";
}

/** The workspace file a tool call is about, when its input names one. */
function fileArg(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of ["file_path", "path", "file", "notebook_path"]) {
    const value = asString(input[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * SSE events carry their fields at the top level, while many run events also
 * wrap them under `data`. Flatten both so one reducer handles the wire shape
 * and plain payloads alike (mirrors conversation.ts).
 */
function payloadOf(item: RunStreamItem): Record<string, unknown> {
  const event = isRecord(item.data) ? item.data : {};
  const nested = event.data;
  return isRecord(nested) ? { ...nested, ...event } : event;
}

/** The thinking text of an `assistant.thinking` event, in any known shape. */
function thinkingText(item: RunStreamItem): string | undefined {
  if (typeof item.data === "string") return item.data;
  const data = payloadOf(item);
  return asString(data.text) ?? asString(data.thinking) ?? asString(data.content);
}

function capChars(value: string, max = MAX_PREVIEW_CHARS): { body: string; truncated: boolean } {
  if (value.length <= max) return { body: value, truncated: false };
  return { body: `${value.slice(0, max)}…`, truncated: true };
}

function capLines(value: string, maxLines = MAX_DIFF_LINES): { body: string; truncated: boolean } {
  const lines = value.split("\n");
  if (lines.length <= maxLines) return { body: value, truncated: false };
  return { body: `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)`, truncated: true };
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asString(input[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * A unified-diff-style preview for an edit tool, built only from the
 * whitelisted input fields. Write shows the new content as added lines;
 * Edit/MultiEdit show removed then added lines per hunk. Returns undefined
 * when the input carries nothing renderable (e.g. an Edit with no strings).
 */
function buildEditDiff(name: string, input: unknown): TracePreview | undefined {
  if (!isRecord(input)) return undefined;
  const tool = shortToolName(name);
  const lines: string[] = [];
  const push = (prefix: string, text: string) => {
    for (const line of text.split("\n")) lines.push(`${prefix} ${line}`);
  };

  if (tool === "Write" || tool === "create_file") {
    const content = firstString(input, ["content", "text"]);
    if (!content) return undefined;
    push("+", content);
  } else if (tool === "Edit" || tool === "str_replace_editor") {
    const oldText = firstString(input, ["old_string", "old_text", "old_str", "old"]);
    const newText = firstString(input, ["new_string", "new_text", "new_str", "new"]);
    if (oldText) push("-", oldText);
    if (newText) push("+", newText);
    if (!oldText && !newText) return undefined;
  } else if (tool === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    edits.forEach((edit, index) => {
      if (!isRecord(edit)) return;
      const oldText = firstString(edit, ["old_string", "old_text", "old_str", "old"]);
      const newText = firstString(edit, ["new_string", "new_text", "new_str", "new"]);
      if (!oldText && !newText) return;
      lines.push(`--- edit ${index + 1} ---`);
      if (oldText) push("-", oldText);
      if (newText) push("+", newText);
    });
    if (lines.length === 0) return undefined;
  } else if (tool === "NotebookEdit") {
    const source = firstString(input, ["new_source", "source", "content"]);
    if (!source) return undefined;
    push("+", source);
  } else if (tool === "apply_patch") {
    const patch = firstString(input, ["patch", "diff"]);
    if (!patch) return undefined;
    lines.push(...patch.split("\n"));
  } else {
    return undefined;
  }

  const capped = capLines(lines.join("\n"));
  return { kind: "diff", body: capped.body, truncated: capped.truncated };
}

/** A capped stdout preview from a tool result's output. */
function buildStdout(output: string | undefined, truncated: boolean): TracePreview | undefined {
  if (!output) return undefined;
  const capped = capChars(output);
  return { kind: "stdout", body: capped.body, truncated: truncated || capped.truncated };
}

/**
 * The card preview for a finished tool step: the diff when the tool is an
 * edit with one, else the first line of its stdout, else the label. Typed
 * text is never surfaced here — `type` steps preview only their label.
 */
function stepPreview(step: TimelineStep): string {
  if (step.diff) {
    const first = step.diff.body.split("\n").find((line) => line.trim().length > 0);
    return first ? first.slice(0, 160) : step.label;
  }
  return step.label;
}

/**
 * Fold flat SSE log events into stretches of timeline steps. Tool calls pair
 * with their results by id (falling back to the most recent still-running
 * call, the stream's natural round-trip order); a result with no matching
 * call still surfaces as a zero-duration step so the outcome is never
 * silently dropped. Thinking events become their own steps. Agent prose,
 * questions, and handoffs end the current stretch so stretches line up with
 * the steps blocks buildTurnBlocks produces.
 */
export function buildTraceTimeline(items: readonly RunStreamItem[]): TimelineStretch[] {
  const stretches: TimelineStretch[] = [];
  let steps: TimelineStep[] = [];
  let stretchCounter = 0;
  let callCounter = 0;

  const startStretch = () => {
    steps = [];
    stretches.push({ key: `trace:stretch:${++stretchCounter}`, steps });
  };
  const currentSteps = (): TimelineStep[] => {
    if (stretches.length === 0) startStretch();
    return steps;
  };
  const settleRunning = (status: "done" | "error") => {
    // A run that ended leaves no tool running, in any stretch.
    for (const stretch of stretches) {
      for (const step of stretch.steps) {
        if (step.status === "running") {
          step.status = status;
          step.ok = status === "done";
          step.preview = stepPreview(step);
        }
      }
    }
  };

  for (const item of items) {
    const data = payloadOf(item);
    switch (item.kind) {
      case "assistant.text": {
        const text = typeof item.data === "string" ? item.data : asString(data.text);
        // Empty prose does not split a stretch (buildConversation skips it
        // too, so the steps blocks stay aligned).
        if (text && text.trim()) startStretch();
        break;
      }
      case "question.required":
      case "handoff.required":
        // These become their own blocks in the turn, ending the stretch.
        startStretch();
        break;
      case "assistant.thinking": {
        const text = thinkingText(item);
        if (!text || !text.trim()) break;
        const preview = text.replace(/\s+/g, " ").trim().slice(0, MAX_THINKING_PREVIEW);
        currentSteps().push({
          id: `thinking:${item.seq}`,
          kind: "thinking",
          label: "Thinking",
          status: "done",
          startedAt: item.ts,
          endedAt: item.ts,
          durationMs: 0,
          ok: true,
          preview,
        });
        break;
      }
      case "tool.call": {
        const name = asString(data.name) ?? "tool";
        if (isAskUserToolName(name)) break; // rendered as the question card
        if (isDesktopHandoffToolName(name)) break; // rendered as the handoff card
        const id = asString(data.id) ?? `call-${++callCounter}`;
        const kind = classifyToolKind(name);
        const label = describeToolCall(name, data.input);
        // A repeated call with the same id (rare replay) refreshes in place
        // rather than duplicating the row.
        const all = stretches.flatMap((stretch) => stretch.steps);
        const existing = id ? [...all].reverse().find((s) => s.id === id && s.toolName !== undefined) : undefined;
        if (existing) {
          existing.kind = kind;
          existing.toolName = name;
          existing.label = label;
          existing.status = "running";
          existing.endedAt = undefined;
          existing.durationMs = undefined;
          existing.ok = undefined;
          existing.preview = label;
          existing.file = fileArg(data.input);
          const refreshedDiff = kind === "edit" ? buildEditDiff(name, data.input) : undefined;
          if (refreshedDiff) existing.diff = refreshedDiff;
          else delete existing.diff;
          break;
        }
        const step: TimelineStep = {
          id,
          kind,
          toolName: name,
          label,
          status: "running",
          startedAt: item.ts,
          preview: label,
          ...(fileArg(data.input) ? { file: fileArg(data.input) } : {}),
        };
        const diff = kind === "edit" ? buildEditDiff(name, data.input) : undefined;
        if (diff) step.diff = diff;
        currentSteps().push(step);
        break;
      }
      case "tool.result": {
        const id = asString(data.id);
        const ok = data.ok !== false;
        const all = stretches.flatMap((stretch) => stretch.steps);
        const entry =
          (id ? [...all].reverse().find((s) => s.id === id && s.toolName !== undefined) : undefined) ??
          [...all].reverse().find((s) => s.status === "running" && s.toolName !== undefined);
        if (entry) {
          entry.status = ok ? "done" : "error";
          entry.ok = ok;
          entry.endedAt = item.ts;
          entry.durationMs =
            entry.startedAt !== undefined ? Math.max(0, item.ts - entry.startedAt) : 0;
          // An edit's diff comes from its input; everything else previews
          // the result output (capped, never raw JSON).
          if (!entry.diff) {
            const stdout = buildStdout(asString(data.output), data.truncated === true);
            if (stdout) entry.diff = stdout;
          }
          entry.preview = stepPreview(entry);
        } else {
          // A result with no matching call (e.g. replayed after the call
          // scrolled out of retention): surface it as a zero-duration step
          // so the outcome is never silently dropped.
          const stdout = buildStdout(asString(data.output), data.truncated === true);
          const orphan: TimelineStep = {
            id: id ?? `result-${++callCounter}`,
            kind: "mcp",
            toolName: "tool",
            label: "Tool result",
            status: ok ? "done" : "error",
            startedAt: item.ts,
            endedAt: item.ts,
            durationMs: 0,
            ok,
            preview: "Tool result",
            ...(stdout ? { diff: stdout } : {}),
          };
          orphan.preview = stepPreview(orphan);
          currentSteps().push(orphan);
        }
        break;
      }
      case "tool.blocked": {
        const name = asString(data.name) ?? "tool";
        const reason = asString(data.reason);
        const label = `Blocked ${name}${reason ? ` — ${reason.slice(0, 180)}` : ""}`;
        const all = stretches.flatMap((stretch) => stretch.steps);
        const running = [...all].reverse().find((s) => s.status === "running" && s.toolName !== undefined);
        if (running) {
          running.status = "error";
          running.ok = false;
          running.endedAt = item.ts;
          running.durationMs =
            running.startedAt !== undefined ? Math.max(0, item.ts - running.startedAt) : 0;
          running.label = label;
          running.preview = reason ?? label;
        } else {
          currentSteps().push({
            id: `blocked-${++callCounter}`,
            kind: classifyToolKind(name),
            toolName: name,
            label,
            status: "error",
            startedAt: item.ts,
            endedAt: item.ts,
            durationMs: 0,
            ok: false,
            preview: reason ?? label,
          });
        }
        break;
      }
      case "run.finished":
        settleRunning("done");
        break;
      case "run.error":
      case "run.cancelled":
        settleRunning("error");
        break;
      default:
        break;
    }
  }

  // Drop the trailing empty stretch a split at the end of the log leaves.
  return stretches.filter((stretch) => stretch.steps.length > 0);
}

/** All steps across stretches, in order. */
export function flattenTraceTimeline(stretches: readonly TimelineStretch[]): TimelineStep[] {
  return stretches.flatMap((stretch) => stretch.steps);
}

/** The pill summary for one stretch: count, duration, failures, live state. */
export function summarizeTraceStretch(steps: readonly TimelineStep[]): TraceStretchSummary {
  let running: TimelineStep | undefined;
  let failed = 0;
  let durationMs: number | undefined;
  for (const step of steps) {
    if (step.status === "running") running = step;
    if (step.status === "error") failed += 1;
    if (step.durationMs !== undefined) durationMs = (durationMs ?? 0) + step.durationMs;
  }
  const shown = running ?? steps[steps.length - 1];
  return {
    count: steps.length,
    running: running !== undefined,
    failed,
    ...(durationMs !== undefined ? { durationMs } : {}),
    label: shown ? shown.label : "",
  };
}

/** Re-export for the pill: "640 ms" / "1.2 s". */
export { formatStepDuration as formatTraceDuration };
