/**
 * runPhase.ts — the one answer to "what is the run doing right now?".
 *
 * The workspace shows run state in three places (the header indicator, the
 * conversation turn, the board row). They all read this module so a run can
 * never look "running" in one place and "finished" in another. DOM-free so it
 * unit-tests with node:test.
 */

export type RunPhase =
  /** Sent from this page; the server has not accepted the run yet. */
  | "starting"
  | "queued"
  | "running"
  /** Waiting on an ask-tier approval. */
  | "approval"
  /** Waiting on an ask_user question or a desktop handoff. */
  | "question"
  | "paused"
  | "finished"
  | "error"
  | "cancelled";

/** The five status colors the whole UI uses. */
export type StatusTone = "accent" | "ok" | "warn" | "err" | "muted";

export interface RunPhaseInput {
  /** Run status from the runs API. */
  status?: string;
  /** Kind of the terminal stream event (run.finished, …) if one has arrived. */
  terminalEvent?: string;
  pendingApprovals?: number;
  pendingQuestions?: number;
  /** True between pressing Send and the server accepting the run. */
  dispatching?: boolean;
}

export interface RunPhaseMeta {
  label: string;
  tone: StatusTone;
  /** True while the run still occupies the agent (Stop is offered). */
  active: boolean;
}

export const RUN_PHASE_META: Record<RunPhase, RunPhaseMeta> = {
  starting: { label: "Starting", tone: "accent", active: true },
  queued: { label: "Queued", tone: "warn", active: true },
  running: { label: "Running", tone: "accent", active: true },
  approval: { label: "Needs approval", tone: "warn", active: true },
  question: { label: "Needs your answer", tone: "warn", active: true },
  paused: { label: "Paused", tone: "warn", active: false },
  finished: { label: "Finished", tone: "ok", active: false },
  error: { label: "Failed", tone: "err", active: false },
  cancelled: { label: "Stopped", tone: "muted", active: false },
};

const TERMINAL_STATUS: Record<string, RunPhase> = {
  finished: "finished",
  error: "error",
  cancelled: "cancelled",
  paused: "paused",
};

const TERMINAL_EVENT: Record<string, RunPhase> = {
  "run.finished": "finished",
  "run.error": "error",
  "run.cancelled": "cancelled",
  "run.paused": "paused",
};

/**
 * Resolve the phase. Precedence, most to least authoritative:
 *   1. a terminal status from the runs API;
 *   2. a terminal event on the live stream (it lands before the next poll);
 *   3. something waiting on the user (approval, then question);
 *   4. the polled live status;
 *   5. an in-flight dispatch.
 * Returns null when there is no run to describe.
 */
export function deriveRunPhase(input: RunPhaseInput): RunPhase | null {
  const polled = input.status ? TERMINAL_STATUS[input.status] : undefined;
  if (polled) return polled;
  const streamed = input.terminalEvent ? TERMINAL_EVENT[input.terminalEvent] : undefined;
  if (streamed) return streamed;
  if ((input.pendingApprovals ?? 0) > 0) return "approval";
  if ((input.pendingQuestions ?? 0) > 0) return "question";
  if (input.status === "queued") return "queued";
  if (input.status === "running") return "running";
  if (input.dispatching) return "starting";
  return null;
}

export function isRunActive(phase: RunPhase | null | undefined): boolean {
  return phase ? RUN_PHASE_META[phase].active : false;
}

/** "0:07", "1:24", "1:02:03" — a clock, not a sentence, so it never reflows. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

/** "42s", "3m 05s", "1h 02m" — for finished runs. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
}
