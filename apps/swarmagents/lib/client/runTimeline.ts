/**
 * runTimeline.ts — pure reducer from raw run-stream items to a renderable
 * timeline: tool calls paired with their results (durations, ok/error),
 * accumulated token usage, and the run's final cost/meta from run.finished.
 *
 * The stream itself is consumed by useRunStream; this module only shapes the
 * decoded items into a view model, so it stays DOM-free and unit-tests with
 * plain node:test. Callers feed the same items array back on every new event
 * and re-derive; the reducer is idempotent for a given array.
 */

import type { RunStreamItem } from "./useRunStream";

/** One tool call, from its `tool.call` event until its `tool.result`. */
export interface ToolCallEntry {
  /** Stable identity: the call's own id when present, else a synthetic key. */
  id: string;
  name: string;
  input: unknown;
  status: "running" | "done" | "error";
  /** Wall-clock timestamp of the call event (item.ts). */
  startedAt?: number;
  /** Wall-clock timestamp of the matching result event. */
  endedAt?: number;
  /** Set once a result arrives: result.ts - call.ts. */
  durationMs?: number;
  /** undefined while running; false when the tool reported an error. */
  ok?: boolean;
  /** Rendered tool output from the result event. */
  output?: string;
  truncated?: boolean;
}

/** Risk level carried on approval.required events (see lib/harness/risk.ts). */
export type ApprovalRiskLevel = "allow" | "ask" | "deny";

/** Lifecycle of an approval as observed on the run stream. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

/** One approval gate: from `approval.required` until its `approval.resolved`. */
export interface ApprovalEntry {
  /** The approval id the decision endpoint expects (/api/runtime/approvals/{id}). */
  id: string;
  /** What asked for permission: a risky tool call or a role escalation. */
  kind?: "tool" | "role_escalation";
  /** Tool that triggered the gate (e.g. "Bash", "set_role"). */
  tool: string;
  /** The flagged action (command / path / url) — already redacted by the harness. */
  action: string;
  /** Working directory of the flagged action, when provided. */
  cwd?: string;
  /** Why the classifier flagged the call. */
  reason: string;
  /** Human-readable impact summary, when provided. */
  impact?: string;
  riskLevel: ApprovalRiskLevel;
  status: ApprovalStatus;
  /** Wall-clock timestamp of the approval.required event (item.ts). */
  ts: number;
  /** Epoch ms at which an unanswered approval auto-denies itself. */
  expiresAt?: number;
  /** True when the approval expired because nobody decided in time. */
  timedOut?: boolean;
  /** Role escalation: the role being left and the one being requested. */
  fromRole?: { id: string; name: string };
  toRole?: { id: string; name: string };
  /** Role escalation: capabilities the switch would add. */
  addedPermissions?: string[];
  addedTools?: string[];
  addedMcpServers?: string[];
}

/** Run-level totals distilled from events (usage snapshots + run.finished). */
export interface RunSummary {
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  /** Model reported by run.started. */
  model?: string;
  /** Cost in USD, present on run.finished. */
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  /** Message from run.error, if the run failed. */
  error?: string;
  cancelledReason?: string;
  /** Summed across every usage event (per-message snapshots). */
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** False when the run produced no usage events (provider reported no usage). */
  usageReported: boolean;
}

export interface RunTimeline {
  tools: ToolCallEntry[];
  summary: RunSummary;
  /** Approval gates in stream order, including resolved ones. */
  approvals: ApprovalEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return out.length > 0 ? out : undefined;
}

function asRoleRef(value: unknown): { id: string; name: string } | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  if (!id) return undefined;
  return { id, name: asString(value.name) ?? id };
}

/**
 * Event-payload keys that must never be rendered. The run stream carries
 * internal identifiers (notably `userId`, e.g. `local_james@...`) on
 * lifecycle events such as run.created / run.queued; they are needed
 * server-side for ownership scoping but are not user-facing.
 */
const SENSITIVE_EVENT_KEYS: ReadonlySet<string> = new Set(["userId", "user_id", "email"]);

/**
 * Deep copy of an event payload with sensitive keys removed at every level,
 * for rendering raw event JSON (e.g. Telemetry's expandable event rows).
 * Primitives pass through unchanged.
 */
export function redactEventData(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(redactEventData);
  if (isRecord(data)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_EVENT_KEYS.has(key)) continue;
      out[key] = redactEventData(value);
    }
    return out;
  }
  return data;
}

/**
 * Short human line for a run lifecycle event, or null when the kind has no
 * safe one-liner of its own. Only whitelisted fields are read — the raw
 * payload (prompt, userId, seq, timestamps) is never rendered.
 */
export function lifecycleEventLine(kind: string, data: unknown): string | null {
  if (kind === "run.queued") {
    const position = isRecord(data) ? data.position : undefined;
    return typeof position === "number" ? `Queued · position ${position}` : "Queued";
  }
  return null;
}

/**
 * Apply one stream item to the approval list. Shared by the full reducer and
 * the approvals-only extraction so both derive identical entries.
 */
function applyApprovalItem(approvals: ApprovalEntry[], kind: string, data: Record<string, unknown>, ts: number): void {
  if (kind === "approval.required") {
    // The payload nests the approval object (`{type, approval:{...}}`); accept
    // a flat shape too so replayed/legacy items still surface.
    const raw = isRecord(data.approval) ? data.approval : data;
    const id = asString(raw.id);
    if (!id) return;
    const expiresAt = asNumber(raw.expiresAt);
    const cwd = asString(raw.cwd) ?? asString(raw.workingDir) ?? asString(raw.dir);
    const impact = asString(raw.impact);
    const fromRole = asRoleRef(raw.fromRole);
    const toRole = asRoleRef(raw.toRole);
    const addedPermissions = asStringArray(raw.addedPermissions);
    const addedTools = asStringArray(raw.addedTools);
    const addedMcpServers = asStringArray(raw.addedMcpServers);
    const entry: ApprovalEntry = {
      id,
      ...(raw.kind === "role_escalation" ? { kind: "role_escalation" as const } : {}),
      tool: asString(raw.tool) ?? "tool",
      action: asString(raw.action) ?? "",
      ...(cwd ? { cwd } : {}),
      reason: asString(raw.reason) ?? "",
      ...(impact ? { impact } : {}),
      riskLevel: raw.riskLevel === "deny" ? "deny" : raw.riskLevel === "allow" ? "allow" : "ask",
      status: "pending",
      ts,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(fromRole ? { fromRole } : {}),
      ...(toRole ? { toRole } : {}),
      ...(addedPermissions ? { addedPermissions } : {}),
      ...(addedTools ? { addedTools } : {}),
      ...(addedMcpServers ? { addedMcpServers } : {}),
    };
    // A replayed required event refreshes the entry in place.
    const existing = approvals.findIndex((a) => a.id === id);
    if (existing >= 0) approvals[existing] = entry;
    else approvals.push(entry);
    return;
  }
  if (kind === "approval.timeout") {
    const id = asString(data.id);
    if (!id) return;
    const entry = approvals.find((a) => a.id === id);
    if (!entry) return;
    entry.status = "expired";
    entry.timedOut = true;
    const expiresAt = asNumber(data.expiresAt);
    if (expiresAt !== undefined) entry.expiresAt = expiresAt;
    return;
  }
  if (kind === "approval.resolved") {
    const id = asString(data.id);
    if (!id) return;
    const entry = approvals.find((a) => a.id === id);
    if (!entry) return;
    const verdict = asString(data.verdict);
    entry.status =
      verdict === "approved" || verdict === "denied" || verdict === "expired" ? verdict : entry.status;
  }
}

/**
 * Approvals-only view over the stream: the same entries reduceRunTimeline
 * produces, for views (e.g. the terminal) that don't need the tool timeline.
 */
export function extractApprovals(items: readonly RunStreamItem[]): ApprovalEntry[] {
  const approvals: ApprovalEntry[] = [];
  for (const it of items) {
    const data = isRecord(it.data) ? it.data : {};
    applyApprovalItem(approvals, it.kind, data, it.ts);
  }
  return approvals;
}

/** Approvals still waiting on a human decision. */
export function pendingApprovals(approvals: readonly ApprovalEntry[]): ApprovalEntry[] {
  return approvals.filter((a) => a.status === "pending");
}

/**
 * The run's slowest tool calls, longest first. Only finished calls with a
 * measured duration are included (still-running calls have no duration yet).
 */
export function slowestTools(tools: readonly ToolCallEntry[], limit = 5): ToolCallEntry[] {
  return tools
    .filter((t) => t.durationMs !== undefined && (t.status === "done" || t.status === "error"))
    .slice()
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, Math.max(0, limit));
}

export function reduceRunTimeline(items: readonly RunStreamItem[]): RunTimeline {
  const tools: ToolCallEntry[] = [];
  const approvals: ApprovalEntry[] = [];
  const summary: RunSummary = { tokensIn: 0, tokensOut: 0, tokensCached: 0, usageReported: false };
  let callCounter = 0;

  for (const item of items) {
    const data = isRecord(item.data) ? item.data : {};
    switch (item.kind) {
      case "tool.call": {
        const name = asString(data.name) ?? "tool";
        const id = asString(data.id) ?? `call-${++callCounter}`;
        // A repeated call with the same id (rare replay) refreshes in place
        // rather than duplicating the row.
        const existing = tools.find((t) => t.id === id);
        if (existing) {
          existing.name = name;
          existing.input = data.input;
          existing.status = "running";
          existing.startedAt = existing.startedAt ?? item.ts;
          existing.endedAt = undefined;
          existing.durationMs = undefined;
          existing.ok = undefined;
          existing.output = undefined;
          existing.truncated = undefined;
        } else {
          tools.push({ id, name, input: data.input, status: "running", startedAt: item.ts });
        }
        break;
      }

      case "tool.result": {
        const id = asString(data.id);
        const ok = data.ok !== false;
        // Prefer an explicit id match; otherwise (or when the id no longer
        // matches, e.g. the call scrolled out of retention) close the most
        // recent still-running call — the stream's natural round-trip order.
        const entry =
          (id ? tools.find((t) => t.id === id) : undefined) ??
          [...tools].reverse().find((t) => t.status === "running");
        if (entry) {
          entry.status = ok ? "done" : "error";
          entry.ok = ok;
          entry.output = asString(data.output);
          entry.truncated = data.truncated === true;
          entry.endedAt = item.ts;
          entry.durationMs =
            entry.startedAt !== undefined
              ? Math.max(0, item.ts - entry.startedAt)
              : 0;
        } else {
          // A result with no matching call (e.g. replayed after the call
          // scrolled out of the retained list): surface it as a zero-duration
          // entry so the outcome is never silently dropped.
          tools.push({
            id: id ?? `result-${++callCounter}`,
            name: "tool",
            input: undefined,
            status: ok ? "done" : "error",
            ok,
            output: asString(data.output),
            truncated: data.truncated === true,
            startedAt: item.ts,
            endedAt: item.ts,
            durationMs: 0,
          });
        }
        break;
      }

      case "usage": {
        summary.usageReported = true;
        summary.tokensIn += asNumber(data.inputTokens) ?? 0;
        summary.tokensOut += asNumber(data.outputTokens) ?? 0;
        summary.tokensCached += asNumber(data.cachedTokens) ?? 0;
        break;
      }

      case "run.started": {
        summary.startedAt = item.ts;
        summary.model = asString(data.model) ?? summary.model;
        break;
      }

      case "run.finished": {
        summary.finishedAt = item.ts;
        summary.exitCode = asNumber(data.exitCode);
        summary.costUsd = asNumber(data.costUsd);
        summary.durationMs = asNumber(data.durationMs);
        summary.numTurns = asNumber(data.numTurns);
        break;
      }

      case "run.error": {
        summary.finishedAt = summary.finishedAt ?? item.ts;
        summary.exitCode = asNumber(data.exitCode) ?? summary.exitCode;
        summary.error = asString(data.message) ?? summary.error;
        break;
      }

      case "run.cancelled": {
        summary.finishedAt = summary.finishedAt ?? item.ts;
        summary.cancelledReason = asString(data.reason);
        break;
      }

      case "approval.required":
      case "approval.resolved":
      case "approval.timeout": {
        applyApprovalItem(approvals, item.kind, data, item.ts);
        break;
      }

      default:
        // assistant.text and any future event kinds do not shape the tool
        // timeline; ignore them.
        break;
    }
  }

  return { tools, summary, approvals };
}
