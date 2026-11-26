/**
 * activity.ts — derive the compact "what is the agent doing right now" lines
 * that feed the ActivityStrip (the live ticker between the VM screen and the
 * input bar).
 *
 * The mapper is pure and DOM-free so it unit-tests with plain node:test: it
 * turns the run stream's raw events (see lib/harness/types.ts) into short,
 * humanized one-liners. `buildActivityLines` additionally pairs `tool.call`
 * with its `tool.result` so result lines can name the tool even though result
 * payloads only carry the call id.
 */

import type { RunStreamItem } from "./useRunStream";

export type ActivityTone = "default" | "accent" | "done" | "error";

export interface ActivityLine {
  /** Stable React key: event kind + stream seq. */
  key: string;
  kind: string;
  text: string;
  tone: ActivityTone;
}

const MAX_TEXT = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** "browser.open" → "Browser open" style fallback text for unknown actions. */
function humanizeAction(action: string): string {
  const words = action.replace(/[_.-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Action";
}

/**
 * Key combos are keysym names, charset-restricted by the desktop
 * validator (validate.mjs KEY_COMBO_RE); strip anything else anyway so a
 * malformed event can never smuggle free text into the ticker through
 * the key branch. Mirrors the desktop action overlays' sanitizer.
 */
function sanitizeCombo(text: string): string {
  return text.replace(/[^A-Za-z0-9_+\-]/g, "").slice(0, 32);
}

function truncate(value: unknown): string {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function line(item: RunStreamItem, kind: string, text: string, tone: ActivityTone): ActivityLine {
  return { key: `${kind}:${item.seq}`, kind, text, tone };
}

/**
 * Map one run-stream item to an activity line, or null when the event is not
 * meaningful in the ticker (usage snapshots, unknown kinds).
 *
 * `callNames` is optional: a map of tool-call id → tool name accumulated by
 * `buildActivityLines` so `tool.result` rows can name their tool.
 */
export function toActivityLine(
  item: RunStreamItem,
  callNames: ReadonlyMap<string, string> = new Map(),
): ActivityLine | null {
  const data = isRecord(item.data) ? item.data : {};

  switch (item.kind) {
    case "shell.cmd": {
      const command = asString(data.command);
      if (!command) return null;
      return line(item, "shell.cmd", `Running: ${truncate(command)}`, "accent");
    }

    case "tool.call": {
      const name = asString(data.name) ?? "tool";
      const input = isRecord(data.input) ? data.input : {};
      const command = asString(input.command);
      const file = asString(input.file_path) ?? asString(input.path);
      const url = asString(input.url) ?? asString(input.goto);
      if (name === "Bash" && command) {
        return line(item, "tool.call", `Running: ${truncate(command)}`, "accent");
      }
      if (file) return line(item, "tool.call", `Editing ${truncate(file)}`, "accent");
      if (url) return line(item, "tool.call", `Opening ${truncate(url)}`, "accent");
      return line(item, "tool.call", `Using ${name}`, "accent");
    }

    case "tool.result": {
      const ok = data.ok !== false;
      const id = asString(data.id);
      const name = id ? callNames.get(id) : undefined;
      const label = name ? name : "Tool";
      return line(
        item,
        "tool.result",
        ok ? `${label} done` : `${label} failed`,
        ok ? "done" : "error",
      );
    }

    case "tool.blocked": {
      const name = asString(data.name) ?? "tool";
      const reason = asString(data.reason);
      return line(
        item,
        "tool.blocked",
        `${name} blocked${reason ? ` · ${truncate(reason)}` : ""}`,
        "error",
      );
    }

    case "tool.backgrounded": {
      const command = asString(data.command);
      return line(
        item,
        "tool.backgrounded",
        command
          ? `Backgrounded — output won't stream · ${truncate(command)}`
          : "Backgrounded work — output won't stream",
        "error",
      );
    }

    case "assistant.text": {
      const text = typeof item.data === "string" ? item.data : asString(data.text);
      if (!text) return null;
      return line(item, "assistant.text", truncate(text), "default");
    }

    case "approval.required": {
      const raw = isRecord(data.approval) ? data.approval : data;
      const action = asString(raw.action) ?? asString(raw.tool);
      return line(
        item,
        "approval.required",
        action ? `Waiting for your approval · ${truncate(action)}` : "Waiting for your approval",
        "accent",
      );
    }

    case "approval.resolved": {
      const verdict = asString(data.verdict) ?? "resolved";
      const tone: ActivityTone =
        verdict === "approved" ? "done" : verdict === "denied" || verdict === "expired" ? "error" : "default";
      return line(item, "approval.resolved", `Approval ${verdict}`, tone);
    }

    case "approval.timeout": {
      return line(item, "approval.timeout", "Approval timed out · auto-denied", "error");
    }

    case "checkpoint.created": {
      const label = asString(data.label) ?? "checkpoint";
      const tool = asString(data.tool);
      return line(
        item,
        "checkpoint.created",
        tool ? `Checkpoint ${label} · before ${tool}` : `Checkpoint ${label}`,
        "done",
      );
    }

    case "checkpoint.failed": {
      const label = asString(data.label) ?? "checkpoint";
      const error = asString(data.error);
      return line(
        item,
        "checkpoint.failed",
        error ? `Checkpoint ${label} failed · ${truncate(error)}` : `Checkpoint ${label} failed`,
        "error",
      );
    }

    case "checkpoint.restored": {
      const label = asString(data.label) ?? "checkpoint";
      return line(item, "checkpoint.restored", `Forked from ${label}`, "accent");
    }

    case "run.started": {
      const model = asString(data.model);
      return line(item, "run.started", model ? `Run started · ${model}` : "Run started", "accent");
    }

    case "run.finished": {
      const exitCode = typeof data.exitCode === "number" ? data.exitCode : 0;
      const durationMs = typeof data.durationMs === "number" ? data.durationMs : undefined;
      const costUsd = typeof data.costUsd === "number" ? data.costUsd : undefined;
      let text = `Done · exit ${exitCode}`;
      if (durationMs !== undefined) text += ` · ${(durationMs / 1000).toFixed(1)}s`;
      if (costUsd !== undefined) text += ` · $${costUsd.toFixed(3)}`;
      return line(item, "run.finished", text, exitCode === 0 ? "done" : "error");
    }

    case "run.error": {
      return line(item, "run.error", `Error · ${asString(data.message) ?? "unknown"}`, "error");
    }

    case "run.deliverableCheck": {
      const message = asString(data.message) ?? "Deliverable not verified";
      return line(item, "run.deliverableCheck", `Deliverable check · ${truncate(message)}`, "error");
    }

    case "run.cancelled": {
      const reason = asString(data.reason);
      return line(
        item,
        "run.cancelled",
        `Stopped${reason ? ` (${reason})` : ""}`,
        "error",
      );
    }

    case "vm.starting": {
      return line(item, "vm.starting", "VM starting · booting isolated sandbox", "accent");
    }

    case "vm.ready": {
      return line(item, "vm.ready", "VM ready", "done");
    }

    case "vm.error": {
      return line(item, "vm.error", `VM error · ${asString(data.message) ?? "unknown"}`, "error");
    }

    case "computer.action": {
      // Desktop/browser harness events: {action, target?, text?, x?, y?, url?}.
      // Rendered as plain sentences so the activity strip reads like narration.
      //
      // Typed text is NEVER rendered here — only its length. The `text`
      // field can carry credentials the agent was given (a password from
      // the prompt, a token to paste); the runner redacts known secret
      // shapes before the event is built, but the ticker must not depend
      // on redactor coverage. Same posture as the desktop action
      // overlays' labels ("Typing (N chars)"). Key combos are keysym
      // names, so they render after charset sanitization.
      const action = asString(data.action);
      if (!action) return null;
      const target = asString(data.target);
      const text = asString(data.text);
      const textLength = asNumber(data.textLength);
      const url = asString(data.url);
      const x = asNumber(data.x);
      const y = asNumber(data.y);
      if (url) return line(item, "computer.action", `Opening ${url}`, "accent");
      if (action === "type") {
        const chars = textLength ?? (text !== undefined ? text.length : undefined);
        if (chars !== undefined) {
          return line(item, "computer.action", `Typing (${chars} chars)`, "accent");
        }
      }
      if (action === "key" && text) {
        const combo = sanitizeCombo(text);
        if (combo) return line(item, "computer.action", `Pressing ${combo}`, "accent");
      }
      if (action === "click" || action === "double_click") {
        if (target) return line(item, "computer.action", `Clicking ${truncate(target)}`, "accent");
        if (x !== undefined && y !== undefined) {
          return line(item, "computer.action", `Clicking at (${x}, ${y})`, "accent");
        }
        return line(item, "computer.action", "Clicking", "accent");
      }
      if (action === "scroll") {
        if (target) return line(item, "computer.action", `Scrolling ${truncate(target)}`, "accent");
        if (x !== undefined || y !== undefined || text) {
          return line(item, "computer.action", "Scrolling", "accent");
        }
      }
      // `text` is deliberately not a fallback detail: on summary-style
      // events it carries the typed content (see above). The summary in
      // `action` already narrates the action; `target` (element/app
      // names) is the only safe detail.
      const detail = target ? truncate(target) : undefined;
      return line(item, "computer.action", detail ? `${humanizeAction(action)} · ${detail}` : humanizeAction(action), "accent");
    }

    default:
      // usage snapshots and unknown event kinds are not useful in the ticker.
      return null;
  }
}

/**
 * Reduce a run stream to its activity lines, newest last, capped at `limit`.
 * Tool results resolve their tool name via the ids of preceding calls.
 */
export function buildActivityLines(items: readonly RunStreamItem[], limit = 8): ActivityLine[] {
  const out: ActivityLine[] = [];
  const callNames = new Map<string, string>();
  for (const item of items) {
    if (item.kind === "tool.call") {
      const data = isRecord(item.data) ? item.data : {};
      const id = asString(data.id);
      const name = asString(data.name);
      if (id && name) callNames.set(id, name);
    }
    const mapped = toActivityLine(item, callNames);
    if (mapped) out.push(mapped);
  }
  return out.slice(-Math.max(1, limit));
}
