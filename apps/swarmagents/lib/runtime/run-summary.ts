/**
 * Folding a run's persisted telemetry events into a durable summary.
 *
 * The summary is what `listRuns` returns and what the run index caches next to
 * the logs. It lives in its own module (rather than in run-store) so both the
 * index writer and the index reader can depend on it without a cycle.
 */

import type { SequencedEvent } from "../telemetry/bus";
import type { ReportCardMeta } from "./run-report-types";
import type { RunCompute } from "../computers/compute";
import type { ForkInfo } from "./checkpoints";

export type StoredRunStatus = "queued" | "running" | "paused" | "finished" | "error" | "cancelled";

export interface StoredRunSummary {
  runId: string;
  userId?: string;
  status: StoredRunStatus;
  prompt: string;
  /** "shell" for direct terminal execs (POST /api/runtime/vm/exec); "agent"
      for agent-prompt runs. The thread lists agent runs only. */
  kind: "agent" | "shell";
  sessionId?: string;
  /** Project this run belongs to (g5), from run.created. */
  projectId?: string;
  /** Provider that served the run, from run.started / run.failover. */
  provider?: string;
  model?: string;
  /** Where the run executed: the cloud VM pool or one of the user's computers. */
  compute?: RunCompute;
  createdAt: number;
  finishedAt?: number;
  exitCode?: number;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  /** Input tokens consumed, summed from usage events. */
  tokensIn: number;
  /** Output tokens generated, summed from usage events. */
  tokensOut: number;
  /** Cached tokens folded in, summed from usage events. */
  tokensCached: number;
  /** False when no usage event was ever recorded (provider reported no usage). */
  tokensReported: boolean;
  cancelledReason?: "user" | "superseded" | "shutdown";
  /** Why a run is paused (currently only when its computer went offline). */
  pausedReason?: "computer_offline" | "user";
  finalText?: string;
  lastSeq: number;
  /** Compact report card counts; present once the run's report exists. */
  report?: ReportCardMeta;
  /** F1: which run + checkpoint this run was forked from, if it is a fork. */
  forkedFrom?: ForkInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A fresh summary for a run that has no events yet. */
function asCompute(value: unknown): RunCompute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "cloud") return { kind: "cloud" };
  if (record.kind !== "computer") return undefined;
  const computerId = typeof record.computerId === "string" && record.computerId ? record.computerId : undefined;
  if (!computerId) return undefined;
  return {
    kind: "computer",
    computerId,
    ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
  };
}

export function emptyRunSummary(runId: string): StoredRunSummary {
  return {
    runId,
    status: "running",
    prompt: "",
    kind: "agent",
    createdAt: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    tokensReported: false,
    lastSeq: 0,
  };
}

/**
 * Fold one event into a summary in place. Kept as a separate step (rather than
 * only exposing summarizeRun) so the run index can update a cached summary
 * incrementally as events are appended, without re-reading the log.
 */
export function applyEventToSummary(summary: StoredRunSummary, event: SequencedEvent): void {
  // The first event establishes createdAt; run.created later refines it.
  if (summary.lastSeq === 0 && typeof event.ts === "number") summary.createdAt = event.ts;
  summary.lastSeq = Math.max(summary.lastSeq, event.seq);
  const data = isRecord(event.data) ? event.data : {};
  // run.created carries a data payload; harness events carry their fields at
  // the top level. Read both so the summary works for either producer.
  const field = (name: string): unknown =>
    name in event ? (event as unknown as Record<string, unknown>)[name] : data[name];

  switch (event.type) {
    case "run.created":
      summary.prompt = str(data.prompt) ?? summary.prompt;
      summary.userId = str(data.userId) ?? summary.userId;
      // Logs written before shell runs were marked default to "agent";
      // only runs created by the terminal exec carry kind "shell".
      summary.kind = data.kind === "shell" ? "shell" : "agent";
      summary.sessionId = str(data.sessionId) ?? summary.sessionId;
      summary.projectId = str(data.projectId) ?? summary.projectId;
      summary.model = str(data.model) ?? summary.model;
      summary.compute = asCompute(data.compute) ?? summary.compute;
      // F1: a forked run records where it branched from (run + checkpoint).
      if (isRecord(data.forkedFrom)) {
        const forkedFrom = data.forkedFrom;
        if (
          typeof forkedFrom.runId === "string" &&
          typeof forkedFrom.checkpointLabel === "string" &&
          typeof forkedFrom.stepSeq === "number"
        ) {
          summary.forkedFrom = {
            runId: forkedFrom.runId,
            checkpointLabel: forkedFrom.checkpointLabel,
            stepSeq: forkedFrom.stepSeq,
          };
        }
      }
      if (typeof event.ts === "number") summary.createdAt = event.ts;
      break;
    case "run.queued":
      // A run waiting behind an active one is queued, not running: the
      // manager emits run.queued at enqueue time and run.started when the
      // run actually starts, which flips it back to running below.
      summary.status = "queued";
      break;
    case "assistant.text":
      summary.finalText = str(field("text")) ?? summary.finalText;
      break;
    case "run.started":
      summary.status = "running";
      summary.sessionId = str(field("sessionId")) ?? summary.sessionId;
      summary.model = str(field("model")) ?? summary.model;
      summary.provider = str(field("provider")) ?? summary.provider;
      break;
    case "run.failover":
      // The provider/model of the attempt that just failed over; a later
      // run.started (the retry) overrides both when it arrives.
      summary.provider = str(data.provider) ?? summary.provider;
      summary.model = str(data.model) ?? summary.model;
      break;
    case "usage":
      summary.tokensReported = true;
      summary.tokensIn += num(field("inputTokens")) ?? 0;
      summary.tokensOut += num(field("outputTokens")) ?? 0;
      summary.tokensCached += num(field("cachedTokens")) ?? 0;
      // A later llm event can fill a model gap left by run.started (the
      // harness attaches the generating model to usage events).
      summary.model = str(field("model")) ?? summary.model;
      break;
    case "run.finished":
      summary.status = "finished";
      summary.finishedAt = event.ts;
      summary.exitCode = num(field("exitCode")) ?? summary.exitCode;
      summary.sessionId = str(field("sessionId")) ?? summary.sessionId;
      summary.costUsd = num(field("costUsd"));
      summary.durationMs = num(field("durationMs"));
      summary.numTurns = num(field("numTurns"));
      break;
    case "run.error":
      summary.status = "error";
      summary.finishedAt = event.ts;
      summary.error = str(field("message")) ?? summary.error;
      summary.exitCode = num(field("exitCode")) ?? summary.exitCode;
      summary.sessionId = str(field("sessionId")) ?? summary.sessionId;
      break;
    case "run.cancelled":
      summary.status = "cancelled";
      summary.finishedAt = event.ts;
      summary.cancelledReason =
        field("reason") === "superseded"
          ? "superseded"
          : field("reason") === "shutdown"
            ? "shutdown"
            : "user";
      break;
    case "run.paused":
      // The selected computer went offline mid-run. The run is not failed or
      // cancelled: it keeps its prompt and can be resumed when the machine
      // comes back. The UI shows a banner instead of a generic stop.
      summary.status = "paused";
      summary.finishedAt = event.ts;
      summary.pausedReason = data.reason === "user" ? "user" : "computer_offline";
      summary.error = str(data.message) ?? summary.error;
      break;
    default:
      break;
  }
}

/** Fold a run's events into a summary (status/cost survive a server restart). */
export function summarizeRun(runId: string, events: SequencedEvent[]): StoredRunSummary {
  const summary = emptyRunSummary(runId);
  for (const event of events) applyEventToSummary(summary, event);
  return summary;
}
