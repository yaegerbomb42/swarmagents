import type { ReportCardMeta } from "../runtime/run-report-types";

export type ThreadStatus = "queued" | "running" | "paused" | "finished" | "error" | "cancelled";

/** Where a run executed: the SwarmAgents cloud pool or one of the user's computers. */
export interface ThreadRunCompute {
  kind: "cloud" | "computer";
  computerId?: string;
  name?: string;
}

export interface ThreadRunInput {
  runId: string;
  prompt?: string;
  finalText?: string;
  status?: string;
  /** Where the run executed (cloud pool or a paired computer). */
  compute?: ThreadRunCompute;
  /** Why the run is paused (currently only when its computer went offline). */
  pausedReason?: "computer_offline" | "user";
  /** "shell" for direct terminal execs — those stay in the terminal and never
      become thread entries. Absent (legacy summaries) means "agent". */
  kind?: "agent" | "shell";
  createdAt?: number;
  finishedAt?: number;
  sessionId?: string;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  /** False when the run recorded no usage event (provider reported no usage). */
  tokensReported?: boolean;
  costUsd?: number;
  /** Compact report card counts, present once the run's report exists. */
  report?: ReportCardMeta;
}

export interface ThreadEntry {
  runId: string;
  prompt: string;
  finalText?: string;
  status: ThreadStatus;
  compute?: ThreadRunCompute;
  pausedReason?: "computer_offline" | "user";
  kind: "agent" | "shell";
  createdAt: number;
  finishedAt?: number;
  sessionId?: string;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  /** False when the run recorded no usage event (provider reported no usage). */
  tokensReported: boolean;
  costUsd?: number;
  report?: ReportCardMeta;
}

export interface ThreadState {
  entries: ThreadEntry[];
}

/** One conversation thread as returned by GET /api/runtime/threads. */
export interface ThreadSummary {
  /** The harness sessionId, or the runId for a sessionless one-run thread. */
  id: string;
  /** Title: the thread's first prompt, truncated server-side. */
  title: string;
  createdAt: number;
  updatedAt: number;
  runCount: number;
}

/** Short relative time for the thread list ("just now", "5m ago", "3h ago"). */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export const EMPTY_THREAD: ThreadState = { entries: [] };

export type ThreadAction =
  | { type: "merge"; runs: readonly ThreadRunInput[]; limit?: number }
  | { type: "reset" };

const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "paused", "finished", "error", "cancelled"]);
const DEFAULT_LIMIT = 50;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStatus(value: unknown): ThreadStatus {
  return typeof value === "string" && STATUSES.has(value) ? (value as ThreadStatus) : "running";
}

function asTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function mergeThreadEntries(
  existing: readonly ThreadEntry[],
  runs: readonly ThreadRunInput[],
  limit: number = DEFAULT_LIMIT,
): ThreadEntry[] {
  const byId = new Map<string, ThreadEntry>();
  for (const entry of existing) byId.set(entry.runId, entry);

  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const runId = nonEmpty(run.runId);
    if (!runId) continue;
    // Direct terminal execs stay in the terminal: never list a typed command
    // as an agent prompt (it would show with an empty "No response text."
    // reply). Dropping a previously merged shell entry here too, so a run
    // that arrived before its kind was known still disappears on the next
    // poll.
    if (run.kind === "shell") {
      byId.delete(runId);
      continue;
    }
    const prev = byId.get(runId);
    byId.set(runId, {
      runId,
      prompt: nonEmpty(run.prompt) ?? prev?.prompt ?? "",
      finalText: nonEmpty(run.finalText) ?? prev?.finalText,
      status: asStatus(run.status ?? prev?.status),
      compute: run.compute ?? prev?.compute,
      pausedReason: run.pausedReason ?? prev?.pausedReason,
      kind: "agent",
      createdAt: asTimestamp(run.createdAt) ?? prev?.createdAt ?? 0,
      finishedAt: asTimestamp(run.finishedAt) ?? prev?.finishedAt,
      sessionId: nonEmpty(run.sessionId) ?? prev?.sessionId,
      error: nonEmpty(run.error) ?? prev?.error,
      tokensIn: asNonNegative(run.tokensIn) ?? prev?.tokensIn,
      tokensOut: asNonNegative(run.tokensOut) ?? prev?.tokensOut,
      tokensCached: asNonNegative(run.tokensCached) ?? prev?.tokensCached,
      tokensReported: run.tokensReported === true || prev?.tokensReported === true,
      costUsd: asNonNegative(run.costUsd) ?? prev?.costUsd,
      report: run.report ?? prev?.report,
    });
  }

  const entries = [...byId.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId),
  );
  const cap = Math.max(1, Math.floor(limit));
  return entries.length > cap ? entries.slice(entries.length - cap) : entries;
}

export function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case "merge": {
      const entries = mergeThreadEntries(state.entries, action.runs, action.limit);
      if (entries.length === state.entries.length && entries.every((entry, i) => entry === state.entries[i])) {
        return state;
      }
      return { entries };
    }
    case "reset":
      return EMPTY_THREAD;
    default:
      return state;
  }
}

// ---- Friendly failure display ----

/** Status chip shown next to a failed/stopped/empty run. */
export type RunFailureChip = "failed" | "stopped" | "empty";

export type RunFailureKind =
  | "auth"
  | "model"
  | "rate_limited"
  | "overloaded"
  | "session"
  | "empty"
  | "cancelled"
  | "paused"
  | "unknown";

export interface RunFailureDisplay {
  kind: RunFailureKind;
  chip: RunFailureChip;
  /** Friendly one-line status text shown in place of the raw error. */
  title: string;
  /** Raw error, kept for the collapsed details row. */
  raw?: string;
}

/**
 * Map a thread entry with no reply text to a friendly failure display.
 *
 * Old thread entries used to show raw harness/provider failures verbatim
 * ("Not logged in · Please run /login", "There's an issue with the
 * selected model (clarke-1.0)…", "No response text." with "0 tokens in ·
 * 0 out"). Known failure classes get a plain-language title and a status
 * chip; the raw error is preserved for the collapsed details row, never
 * dropped. Returns null when the entry has reply text or is still running
 * — there is nothing to explain away.
 */
export function describeRunFailure(
  entry: Pick<ThreadEntry, "status" | "error" | "finalText" | "tokensIn" | "tokensOut">,
): RunFailureDisplay | null {
  if (entry.finalText) return null;
  if (entry.status === "running") return null;
  if (entry.status === "cancelled") {
    return { kind: "cancelled", chip: "stopped", title: "Stopped.", raw: entry.error };
  }
  if (entry.status === "paused") {
    return {
      kind: "paused",
      chip: "stopped",
      title: "Paused — your computer went offline. Bring it online, then resume.",
      raw: entry.error,
    };
  }
  if (entry.status === "error") {
    const raw = entry.error?.trim();
    if (!raw) return { kind: "unknown", chip: "failed", title: "Run failed." };
    if (/unknown[- ]?session|session[- ]?not[- ]?found|invalid[- ]?session/i.test(raw)) {
      return { kind: "session", chip: "failed", title: "Session expired — start a new thread.", raw };
    }
    if (/not logged in|please run \/login|not signed in|sign[- ]in required/i.test(raw)) {
      return { kind: "auth", chip: "failed", title: "Not signed in — run /login and retry.", raw };
    }
    if (/issue with the selected model|selected model|unknown model|model .* (not found|not available|does ?not exist|unsupported|rejected|not supported)/i.test(raw)) {
      return { kind: "model", chip: "failed", title: "Provider rejected the model — check Providers.", raw };
    }
    if (/401|unauthorized|authentication failed|invalid (api )?key/i.test(raw)) {
      return { kind: "auth", chip: "failed", title: "Provider sign-in failed — check Providers.", raw };
    }
    if (/429|rate[- ]limit|too many requests/i.test(raw)) {
      return { kind: "rate_limited", chip: "failed", title: "Provider rate-limited — retry in a moment.", raw };
    }
    if (/overload|529|capacity|try again later|server is busy/i.test(raw)) {
      return { kind: "overloaded", chip: "failed", title: "Provider is busy — retry in a moment.", raw };
    }
    if (/no result event|produced no result|no response text/i.test(raw)) {
      return { kind: "empty", chip: "empty", title: "Run ended with no reply.", raw };
    }
    if (/timed? ?out/i.test(raw)) {
      return { kind: "unknown", chip: "failed", title: "Run timed out — retry.", raw };
    }
    return { kind: "unknown", chip: "failed", title: "Run failed.", raw };
  }
  // Finished (or any other terminal state) with no reply text: an empty run.
  return { kind: "empty", chip: "empty", title: "Run ended with no reply.", raw: entry.error };
}
