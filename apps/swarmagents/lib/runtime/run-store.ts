/**
 * Durable run history derived from the per-run telemetry JSONL written by the
 * TelemetryBus. The RuntimeManager keeps only an in-memory view, so after a
 * restart the event log is the source of truth for listing and replaying runs.
 */

import type { SequencedEvent } from "../telemetry/bus";
import { getRunsDir } from "../telemetry/paths";
import { appendRunEvent, listRunLogs, readRunEvents } from "../telemetry/run-log";
import { readReportMeta } from "./run-report";
import { readRunSummary, updateRunIndex } from "./run-index";
import { summarizeRun, type StoredRunSummary } from "./run-summary";
import type { ResumePoint } from "./checkpoints";

export type { StoredRunStatus, StoredRunSummary } from "./run-summary";
export { summarizeRun } from "./run-summary";

/** Re-exported for callers that used to import the fold from run-store. */
export { applyEventToSummary, emptyRunSummary } from "./run-summary";

export interface ListRunsOptions {
  runsDir?: string | null;
  limit?: number;
  userId?: string;
  since?: number;
  /**
   * Only runs belonging to this thread. A thread is identified by its harness
   * sessionId; a run with no sessionId is its own one-run thread, so a runId
   * also matches (it selects exactly that run).
   */
  sessionId?: string;
  /** Only runs that belong to this project (g5). */
  projectId?: string;
  /**
   * Keyset cursor: a runId or an epoch-ms timestamp. Only runs strictly before
   * the cursor (by createdAt, then runId) are returned, enabling stable
   * pagination across pages.
   */
  before?: string | number;
}

export interface ReplayedRun {
  runId: string;
  events: SequencedEvent[];
  summary: StoredRunSummary;
}

export function getRun(runId: string, runsDir: string | null = getRunsDir()): ReplayedRun | null {
  if (!runsDir) return null;
  const events = readRunEvents(runId, runsDir);
  if (events.length === 0) return null;
  return { runId, events, summary: summarizeRun(runId, events) };
}

/**
 * Summary for one run from the index, without reading its event segments in
 * the common case (same lazy rebuild/migration as listRuns). Used to validate
 * a pagination cursor before listing.
 */
export function getRunSummary(
  runId: string,
  runsDir: string | null = getRunsDir(),
): StoredRunSummary | null {
  if (!runsDir) return null;
  return readRunSummary(runId, runsDir);
}

/** A resolved before-cursor: a timestamp, or a {createdAt, runId} boundary. */
type BeforeCursor = number | { createdAt: number; runId: string };

/**
 * Resolve a before-cursor against the scoped summaries. A numeric cursor is a
 * pure timestamp. A string cursor is a runId: it resolves to that run's
 * {createdAt, runId} boundary. An unknown runId yields a boundary older than
 * anything (empty result) so a stale cursor never leaks too-recent runs.
 */
function resolveBeforeCursor(
  summaries: readonly StoredRunSummary[],
  before?: string | number,
): BeforeCursor | undefined {
  if (before === undefined) return undefined;
  if (typeof before === "number") return before;
  const target = summaries.find((s) => s.runId === before);
  if (!target) return { createdAt: Number.MIN_SAFE_INTEGER, runId: "" };
  return { createdAt: target.createdAt, runId: before };
}

function isBeforeCursor(createdAt: number, runId: string, cursor: BeforeCursor): boolean {
  if (typeof cursor === "number") return createdAt < cursor;
  return createdAt < cursor.createdAt || (createdAt === cursor.createdAt && runId < cursor.runId);
}

export function listRuns(options: ListRunsOptions = {}): StoredRunSummary[] {
  const runsDir = options.runsDir === undefined ? getRunsDir() : options.runsDir;
  if (!runsDir) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));

  // Read only the per-run summary index here: filtering and sorting never
  // parse event segments. The full log is read lazily, once, only for a run
  // whose sidecar is missing/corrupt (migration), never for filtering.
  const summaries: StoredRunSummary[] = [];
  for (const info of listRunLogs(runsDir)) {
    const summary = readRunSummary(info.runId, runsDir);
    if (!summary) continue;
    if (options.userId && summary.userId !== options.userId) continue;
    if (options.since !== undefined && summary.createdAt < options.since) continue;
    if (
      options.sessionId !== undefined &&
      summary.sessionId !== options.sessionId &&
      summary.runId !== options.sessionId
    ) {
      continue;
    }
    if (options.projectId !== undefined && summary.projectId !== options.projectId) continue;
    summaries.push(summary);
  }
  // Total order: newest first; runId desc breaks ties so pagination is stable.
  summaries.sort(
    (a, b) => b.createdAt - a.createdAt || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0),
  );

  const cursor = resolveBeforeCursor(summaries, options.before);
  const page = cursor
    ? summaries.filter((s) => isBeforeCursor(s.createdAt, s.runId, cursor)).slice(0, limit)
    : summaries.slice(0, limit);
  // Report meta is only needed for the runs actually returned, so defer those
  // reads until after the page has been cut.
  for (const summary of page) {
    const reportMeta = readReportMeta(summary.runId, runsDir);
    if (reportMeta) summary.report = reportMeta;
  }
  return page;
}

/** Reason recorded on runs orphaned by a server restart. */
export const ORPHANED_RUN_REASON = "server restarted";

/**
 * Recovery epoch: the wall-clock time this process started. Orphan recovery
 * only finalizes runs created before this instant — those belong to a previous
 * process that died, and no live owner remains. Runs created after this moment
 * are either this process's own or a live sibling process's (e.g. test-runner
 * workers sharing a runs dir), so they must never be orphaned. Captured at
 * module load, i.e. effectively at process start.
 */
let recoveryEpoch = Date.now();

/**
 * Test hook: shift the recovery epoch so a test can simulate a previous process
 * that wrote runs before this process existed (without back-dating every run
 * event). Not part of the production surface.
 */
export function setRecoveryEpochForTesting(ts: number): void {
  recoveryEpoch = ts;
}

/**
 * One conversation thread: all runs that share a harness sessionId. A run
 * with no sessionId (it never started, or the harness never reported one)
 * is its own one-run thread, keyed by its runId, so it stays reachable.
 */
export interface ThreadSummary {
  /** The harness sessionId, or the runId for a sessionless one-run thread. */
  id: string;
  /** Title: the thread's first prompt, truncated. */
  title: string;
  createdAt: number;
  updatedAt: number;
  runCount: number;
}

export const THREAD_TITLE_LEN = 60;

/** Collapse whitespace and cap a prompt to a readable thread title. */
export function threadTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (!flat) return "Untitled thread";
  return flat.length > THREAD_TITLE_LEN ? `${flat.slice(0, THREAD_TITLE_LEN - 1).trimEnd()}…` : flat;
}

export interface ListThreadsOptions {
  runsDir?: string | null;
  userId?: string;
  /** Max threads returned (default 20, capped at 50). */
  limit?: number;
  /** Only threads whose runs belong to this project (g5). */
  projectId?: string;
}

/**
 * Group the user's most recent runs (up to THREAD_SOURCE_LIMIT) into
 * threads, newest activity first. The source cap means a user with more
 * than 100 runs only sees threads among their 100 most recent runs.
 */
export const THREAD_SOURCE_LIMIT = 100;

export function listThreads(options: ListThreadsOptions = {}): ThreadSummary[] {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
  const runs = listRuns({
    runsDir: options.runsDir,
    userId: options.userId,
    limit: THREAD_SOURCE_LIMIT,
    projectId: options.projectId,
  });
  // Oldest first so the first run in each group sets the title/createdAt.
  const ascending = [...runs].sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  const byId = new Map<string, ThreadSummary>();
  for (const run of ascending) {
    const id = run.sessionId ?? run.runId;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, {
        id,
        title: threadTitle(run.prompt),
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
        runCount: 1,
      });
    } else {
      prev.updatedAt = Math.max(prev.updatedAt, run.createdAt);
      prev.runCount += 1;
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    .slice(0, limit);
}


/**
 * Finalize every persisted run still marked running or queued. The server
 * restarted mid-run, so no live process will ever finish it — and a queued
 * run can never start either, since the queue itself is in-memory. Leaving
 * either "running"/"queued" would strand it forever. Appends a run.error
 * event (seq = last persisted seq + 1, so the log stays gapless and
 * ordered) to each orphaned run's log, which flips its durable summary to
 * "error" with the restart reason. Finished, errored and cancelled runs are
 * left untouched. Returns the recovered runIds. Idempotent: a second call
 * finds nothing still running or queued.
 */
export function recoverOrphanedRuns(runsDir: string | null = getRunsDir()): string[] {
  if (!runsDir) return [];
  const recovered: string[] = [];
  for (const info of listRunLogs(runsDir)) {
    const run = getRun(info.runId, runsDir);
    if (!run || (run.summary.status !== "running" && run.summary.status !== "queued")) continue;
    // Skip anything born after this process started: it is either ours or a
    // live sibling process's run (test workers share a runs dir), never an
    // orphan of a dead process.
    if (run.summary.createdAt >= recoveryEpoch) continue;
    appendRestartError(run.runId, run.summary.lastSeq, runsDir);
    recovered.push(run.runId);
  }
  return recovered;
}

/**
 * Finalize one run named by the durable runtime snapshot. Unlike the epoch
 * sweep above this is authoritative: the previous process explicitly recorded
 * this run as active, so it is an orphan even in a test/sibling process where
 * the wall-clock epoch cannot prove it. Idempotent: a run already in a
 * terminal state is left alone. When the run has no log at all (the crash hit
 * between accepting the run and its first telemetry write), a minimal
 * run.created is seeded so the abort is visible in history instead of
 * vanishing.
 */
export function recoverRunOnRestart(
  runId: string,
  options: {
    runsDir?: string | null;
    userId?: string;
    prompt?: string;
    compute?: unknown;
    createdAt?: number;
    resumePoint?: ResumePoint;
  } = {},
): boolean {
  const runsDir = options.runsDir === undefined ? getRunsDir() : options.runsDir;
  if (!runsDir || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return false;
  const run = getRun(runId, runsDir);
  if (run) {
    if (run.summary.status !== "running" && run.summary.status !== "queued") return false;
    appendRestartError(runId, run.summary.lastSeq, runsDir);
    return true;
  }
  if (!options.userId || !options.prompt) return false;
  // Seed the identity the summary needs, then the same restart error the epoch
  // sweep appends. Both writes are direct (not through the bus) so a fresh
  // process's seq numbering starts where the previous log would have.
  const created: SequencedEvent = {
    type: "run.created",
    data: {
      prompt: options.prompt.slice(0, 300),
      userId: options.userId,
      ...(options.compute ? { compute: options.compute } : {}),
      kind: "agent",
    },
    seq: 1,
    runId,
    ts: options.createdAt ?? Date.now(),
  };
  appendRunEvent(created, runsDir);
  updateRunIndex(created, runsDir);
  appendRestartError(runId, 1, runsDir);
  return true;
}

function appendRestartError(runId: string, lastSeq: number, runsDir: string): void {
  const errorEvent: SequencedEvent & { message: string } = {
    type: "run.error",
    message: ORPHANED_RUN_REASON,
    seq: lastSeq + 1,
    runId,
    ts: Date.now(),
  };
  appendRunEvent(errorEvent, runsDir);
  updateRunIndex(errorEvent, runsDir);
}

