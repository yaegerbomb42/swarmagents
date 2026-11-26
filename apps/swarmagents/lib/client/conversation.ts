/**
 * conversation.ts — pure reducer from the run stream to a chat-like log.
 *
 * The minimal main page shows one high-level conversation: the user's ask,
 * the agent's messages, readable one-line tool narration (with expandable
 * detail), interactive ask_user cards, and run status lines. This module is
 * DOM-free so it unit-tests with node:test.
 */

import type { RunStreamItem } from "./useRunStream";

export type ConversationEntry =
  | {
      kind: "user";
      key: string;
      ts: number;
      text: string;
      attachments: string[];
    }
  | { kind: "agent"; key: string; ts: number; text: string }
  | {
      kind: "tool";
      key: string;
      ts: number;
      /** Tool-call id, used to pair the result and expand the detail. */
      id?: string;
      name: string;
      /** One human-readable line: "Writing game/index.html". */
      label: string;
      status: "running" | "done" | "error";
      input: unknown;
      output?: string;
      truncated?: boolean;
      durationMs?: number;
    }
  | {
      kind: "question";
      key: string;
      ts: number;
      id: string;
      question: string;
      options: string[];
      allowFreeText: boolean;
      status: "pending" | "answered" | "cancelled" | "expired";
      answer?: string;
      expiresAt?: number;
    }
  | {
      kind: "handoff";
      key: string;
      ts: number;
      id: string;
      reason: string;
      description: string;
      status: "pending" | "answered" | "cancelled" | "expired";
      expiresAt?: number;
    }
  | {
      kind: "status";
      key: string;
      ts: number;
      text: string;
      tone: "done" | "error" | "info";
    };

const MAX_AGENT_TEXT = 8000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function short(value: string, max = 110): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Is this the ask_user MCP tool? (Matched by suffix so no server import.) */
export function isAskUserToolName(name: string): boolean {
  return name === "ask_user" || name.endsWith("__ask_user");
}

/** Is this the ask_human_desktop MCP tool? (Matched by suffix so no server import.) */
export function isDesktopHandoffToolName(name: string): boolean {
  return name === "ask_human_desktop" || name.endsWith("__ask_human_desktop");
}

/** Strip the MCP wrapper: "mcp__computer-mcp__click" -> "click". */
export function shortToolName(name: string): string {
  const parts = name.split("__");
  return parts.length > 1 ? parts[parts.length - 1] : name;
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const value = input.file_path ?? input.path ?? input.file;
  return asString(value);
}

/**
 * One-line description of a tool call, in the user's language. The detail
 * (full input/output) stays expandable in the UI.
 */
export function describeToolCall(name: string, input: unknown): string {
  const record = isRecord(input) ? input : {};
  const command = asString(record.command);
  const file = pathOf(record);
  const url = asString(record.url) ?? asString(record.goto);
  const pattern = asString(record.pattern);
  const query = asString(record.query);
  const target = asString(record.target) ?? asString(record.text);
  const tool = shortToolName(name);

  switch (tool) {
    case "Bash":
    case "shell":
    case "terminal":
      return command ? `Running: ${short(command)}` : "Running a shell command";
    case "Write":
      return file ? `Writing ${file}` : "Writing a file";
    case "Edit":
    case "MultiEdit":
      return file ? `Editing ${file}` : "Editing a file";
    case "Read":
      return file ? `Reading ${file}` : "Reading a file";
    case "Glob":
      return pattern ? `Finding ${short(pattern, 60)}` : "Finding files";
    case "Grep":
      return pattern ? `Searching for "${short(pattern, 60)}"` : "Searching files";
    case "WebSearch":
      return query ? `Searching the web for "${short(query, 60)}"` : "Searching the web";
    case "WebFetch":
      return url ? `Opening ${short(url, 90)}` : "Fetching a web page";
    case "browser_navigate":
    case "navigate":
      return url ? `Opening ${short(url, 90)} in the browser` : "Opening the browser";
    case "browser_click":
    case "click":
      return target ? `Clicking ${short(target, 60)}` : "Clicking on screen";
    case "browser_type":
    case "type": {
      // Typed text is never rendered (it may be a password): name only the
      // element being typed into, never the typed content itself.
      const typeTarget = asString(record.target);
      return typeTarget ? `Typing ${short(typeTarget, 60)}` : "Typing on screen";
    }
    default:
      return `Calling tool: ${short(tool, 40)}`;
  }
}

interface UploadedPrompt {
  text: string;
  attachments: string[];
}

/**
 * Split the hidden upload manifest the composer appends to a prompt:
 * "\n\nUploaded files (in /workspace/uploads/):\n- /workspace/uploads/a.png".
 * The conversation shows the user's words plus attachment chips instead.
 */
export function splitUploadedFiles(prompt: string): UploadedPrompt {
  const marker = "\n\nUploaded files (in /workspace/uploads/):\n";
  const index = prompt.indexOf(marker);
  if (index === -1) {
    return { text: prompt, attachments: [] };
  }
  const text = prompt.slice(0, index);
  const attachments = prompt
    .slice(index + marker.length)
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean)
    .map((path) => path.split("/").pop() ?? path);
  return { text, attachments };
}

/**
 * A run that reached a terminal state has no tool still running: settle any
 * tool entry whose result never arrived (or never paired by id), so the steps
 * block stops showing "Running" after the run finished. A finished run
 * implies its tools completed; an errored or cancelled run implies the
 * in-flight tool did not.
 */
function settleRunningTools(
  toolByKey: ReadonlyMap<string, Extract<ConversationEntry, { kind: "tool" }>>,
  status: "done" | "error",
): void {
  for (const entry of toolByKey.values()) {
    if (entry.status === "running") entry.status = status;
  }
}

function questionResolvedStatus(status: string): "answered" | "cancelled" | "expired" {
  return status === "answered" ? "answered" : status === "expired" ? "expired" : "cancelled";
}

/**
 * SSE events carry their fields at the top level, while many run events also
 * wrap them under `data` (e.g. `{type, data:{name, input}}`). Flatten both so
 * one reducer handles the wire shape and plain payloads alike.
 */
function payloadOf(item: RunStreamItem): Record<string, unknown> {
  const event = isRecord(item.data) ? item.data : {};
  const nested = event.data;
  return isRecord(nested) ? { ...nested, ...event } : event;
}

/**
 * Build the conversation log from the run stream. Idempotent for a given
 * items array: pairs tool results with their calls and folds question
 * resolutions into the matching card.
 */
export function buildConversation(items: readonly RunStreamItem[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const toolByKey = new Map<string, Extract<ConversationEntry, { kind: "tool" }>>();
  const questionById = new Map<string, Extract<ConversationEntry, { kind: "question" }>>();
  const handoffById = new Map<string, Extract<ConversationEntry, { kind: "handoff" }>>();

  for (const item of items) {
    const data = payloadOf(item);
    switch (item.kind) {
      case "run.created": {
        const raw = asString(data.prompt);
        if (raw) {
          const { text, attachments } = splitUploadedFiles(raw);
          entries.push({ kind: "user", key: `user:${item.seq}`, ts: item.ts, text, attachments });
        }
        break;
      }
      case "assistant.text": {
        const text = typeof item.data === "string" ? item.data : asString(data.text);
        if (text && text.trim()) {
          entries.push({
            kind: "agent",
            key: `agent:${item.seq}`,
            ts: item.ts,
            text: text.slice(0, MAX_AGENT_TEXT),
          });
        }
        break;
      }
      case "tool.call": {
        const name = asString(data.name) ?? "tool";
        if (isAskUserToolName(name)) break; // rendered as the question card
        if (isDesktopHandoffToolName(name)) break; // rendered as the handoff card
        const id = asString(data.id);
        const key = id ? `tool:${id}` : `tool:seq:${item.seq}`;
        const entry: Extract<ConversationEntry, { kind: "tool" }> = {
          kind: "tool",
          key,
          ts: item.ts,
          ...(id ? { id } : {}),
          name,
          label: describeToolCall(name, data.input),
          status: "running",
          input: data.input,
        };
        entries.push(entry);
        toolByKey.set(key, entry);
        break;
      }
      case "tool.result": {
        const id = asString(data.id);
        const key = id ? `tool:${id}` : undefined;
        const entry = key ? toolByKey.get(key) : undefined;
        if (!entry) break;
        entry.status = data.ok === false ? "error" : "done";
        entry.output = asString(data.output);
        entry.truncated = data.truncated === true;
        if (typeof entry.ts === "number") entry.durationMs = Math.max(0, item.ts - entry.ts);
        break;
      }
      case "computer.action": {
        const action = asString(data.action);
        if (action) {
          entries.push({ kind: "status", key: `action:${item.seq}`, ts: item.ts, text: action, tone: "info" });
        }
        break;
      }
      case "question.required": {
        const raw = isRecord(data.question) ? data.question : data;
        const id = asString(raw.id);
        const question = asString(raw.question);
        if (!id || !question) break;
        if (questionById.has(id)) break;
        const entry: Extract<ConversationEntry, { kind: "question" }> = {
          kind: "question",
          key: `question:${id}`,
          ts: item.ts,
          id,
          question,
          options: Array.isArray(raw.options)
            ? raw.options.filter((option): option is string => typeof option === "string")
            : [],
          allowFreeText: raw.allowFreeText !== false,
          status: "pending",
          ...(asNumber(raw.expiresAt) !== undefined ? { expiresAt: asNumber(raw.expiresAt) } : {}),
        };
        entries.push(entry);
        questionById.set(id, entry);
        break;
      }
      case "question.resolved": {
        const id = asString(data.id);
        if (!id) break;
        const entry = questionById.get(id);
        const status = questionResolvedStatus(asString(data.status) ?? "cancelled");
        if (entry) {
          entry.status = status;
          const answer = asString(data.answer);
          if (answer !== undefined) entry.answer = answer;
        } else {
          // A reload can observe the resolution without the required event.
          entries.push({
            kind: "status",
            key: `question-resolved:${item.seq}`,
            ts: item.ts,
            text: status === "answered" ? "Question answered" : `Question ${status}`,
            tone: status === "answered" ? "done" : "info",
          });
        }
        break;
      }
      case "handoff.required": {
        const raw = isRecord(data.handoff) ? data.handoff : data;
        const id = asString(raw.id);
        const reason = asString(raw.reason);
        if (!id || !reason) break;
        if (handoffById.has(id)) break;
        const entry: Extract<ConversationEntry, { kind: "handoff" }> = {
          kind: "handoff",
          key: `handoff:${id}`,
          ts: item.ts,
          id,
          reason,
          description: asString(raw.description) ?? "",
          status: "pending",
          ...(asNumber(raw.expiresAt) !== undefined ? { expiresAt: asNumber(raw.expiresAt) } : {}),
        };
        entries.push(entry);
        handoffById.set(id, entry);
        break;
      }
      case "handoff.resolved": {
        const id = asString(data.id);
        if (!id) break;
        const entry = handoffById.get(id);
        const status = questionResolvedStatus(asString(data.status) ?? "cancelled");
        if (entry) {
          entry.status = status;
        } else {
          entries.push({
            kind: "status",
            key: `handoff-resolved:${item.seq}`,
            ts: item.ts,
            text: status === "answered" ? "Desktop handed back" : `Desktop handoff ${status}`,
            tone: status === "answered" ? "done" : "info",
          });
        }
        break;
      }
      case "tool.blocked": {
        const name = asString(data.name) ?? "tool";
        const reason = asString(data.reason);
        entries.push({
          kind: "status",
          key: `blocked:${item.seq}`,
          ts: item.ts,
          text: `Blocked ${name}${reason ? ` — ${short(reason, 180)}` : ""}`,
          tone: "error",
        });
        break;
      }
      case "tool.backgrounded": {
        entries.push({
          kind: "status",
          key: `backgrounded:${item.seq}`,
          ts: item.ts,
          text: "Background work started — its output will not stream here.",
          tone: "info",
        });
        break;
      }
      case "role.changed": {
        const to = isRecord(data.to) ? asString(data.to.name) : undefined;
        if (to) {
          entries.push({
            kind: "status",
            key: `role:${item.seq}`,
            ts: item.ts,
            text: `Switched to ${to}`,
            tone: "info",
          });
        }
        break;
      }
      case "run.finished": {
        settleRunningTools(toolByKey, "done");
        const cost = asNumber(data.costUsd);
        const duration = asNumber(data.durationMs);
        const parts = ["Done"];
        if (duration !== undefined) parts.push(`${(duration / 1000).toFixed(1)}s`);
        if (cost !== undefined) parts.push(`$${cost.toFixed(3)}`);
        entries.push({
          kind: "status",
          key: `finished:${item.seq}`,
          ts: item.ts,
          text: parts.join(" · "),
          tone: data.exitCode === 0 ? "done" : "error",
        });
        break;
      }
      case "run.error": {
        settleRunningTools(toolByKey, "error");
        entries.push({
          kind: "status",
          key: `error:${item.seq}`,
          ts: item.ts,
          text: short(asString(data.message) ?? "Run failed", 240),
          tone: "error",
        });
        break;
      }
      case "run.deliverableCheck": {
        entries.push({
          kind: "status",
          key: `deliverable:${item.seq}`,
          ts: item.ts,
          text: short(asString(data.message) ?? "Deliverable not verified", 240),
          tone: "info",
        });
        break;
      }
      case "run.cancelled": {
        settleRunningTools(toolByKey, "error");
        entries.push({ kind: "status", key: `cancelled:${item.seq}`, ts: item.ts, text: "Run stopped", tone: "info" });
        break;
      }
      case "approval.required": {
        // Auto-approve mode never emits these; if one arrives (legacy run),
        // show a status line rather than an approval card on the main page.
        const raw = isRecord(data.approval) ? data.approval : data;
        const tool = asString(raw.tool) ?? "a tool";
        entries.push({
          kind: "status",
          key: `approval:${item.seq}`,
          ts: item.ts,
          text: `Waiting for approval · ${tool} (open Settings → Panels to review)`,
          tone: "info",
        });
        break;
      }
      default:
        break;
    }
  }

  return entries;
}

/** Index tool entries for a compact detail renderer (used by tests). */
export function conversationToolKeys(entries: readonly ConversationEntry[]): string[] {
  return entries.filter((entry) => entry.kind === "tool").map((entry) => entry.key);
}
