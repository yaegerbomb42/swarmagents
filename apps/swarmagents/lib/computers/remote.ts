/**
 * Remote (BYOC) run control plane.
 *
 * A run dispatched to a paired computer is not executed on the server: the
 * computer's node polls for work (`claim`), streams agent events back
 * (`publishEvent`), and reports the terminal result (`complete`). The server
 * owns ordering, ownership checks and the offline policy.
 *
 * State is per-process, like the cloud RuntimeManager: a server restart drops
 * queued work (the run log remains durable for replay). The node token is
 * checked on every call by lib/computers/store, so a revoked computer gets
 * nothing.
 *
 * Offline policy: a light sweep pauses every queued/running job whose computer
 * stopped heartbeating. Pausing emits `run.paused` and keeps the job's prompt,
 * so `resume` can requeue it when the machine comes back.
 */

import { randomUUID } from "node:crypto";
import { telemetryBus, type TelemetryBus } from "../telemetry/bus";
import type { RunCompute } from "./compute";
import { getComputer, type Computer } from "./store";
import { RemoteRunStateStore } from "./remote-state";

export type RemoteRunStatus = "queued" | "running" | "paused" | "finished" | "error" | "cancelled";

/** Summary shape the tasks/run listing returns for a live BYOC run. */
export interface RemoteRunSummary {
  runId: string;
  userId: string;
  status: RemoteRunStatus;
  prompt: string;
  sessionId?: string;
  projectId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  compute: RunCompute;
  kind: "agent";
  position?: number;
  lastSeq: number;
  pausedReason?: "computer_offline" | "user";
}

export interface RemoteJob {
  runId: string;
  userId: string;
  computerId: string;
  computerName: string;
  prompt: string;
  agentCard?: string;
  sessionId?: string;
  projectId?: string;
  status: RemoteRunStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  pausedReason?: "computer_offline" | "user";
}

export interface RemoteStartInput {
  prompt: string;
  computerId: string;
  sessionId?: string;
  projectId?: string;
  agentCard?: string;
}

export interface RemoteStartResult {
  accepted: boolean;
  runId: string;
  error?: string;
  status?: number;
}

const HISTORY_LIMIT = 100;
/** Event types a node may never forge: the server owns lifecycle transitions. */
const RESERVED_EVENT_TYPES = new Set([
  "run.created",
  "run.queued",
  "run.started",
  "run.finished",
  "run.error",
  "run.cancelled",
  "run.paused",
  "stream.error",
]);
const MAX_EVENT_TYPE_LEN = 80;
const DEFAULT_SWEEP_MS = 10_000;

function safeEvent(event: unknown): { type: string; data: Record<string, unknown> } | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  if (!type || type.length > MAX_EVENT_TYPE_LEN || RESERVED_EVENT_TYPES.has(type)) return null;
  if (!/^[a-z][a-z0-9_.-]*$/i.test(type)) return null;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "type" || key === "runId" || key === "seq" || key === "ts") continue;
    data[key] = value;
  }
  return { type, data };
}

export class RemoteRunManager {
  private readonly bus: TelemetryBus;
  private readonly jobs = new Map<string, RemoteJob>();
  private readonly queues = new Map<string, string[]>();
  private readonly byUser = new Map<string, string[]>();
  private readonly sweepMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Durable live-job snapshot; null in direct test constructions. */
  private readonly stateStore: RemoteRunStateStore | null;

  constructor(options: {
    bus?: TelemetryBus;
    sweepMs?: number;
    autoSweep?: boolean;
    stateStore?: RemoteRunStateStore | null;
  } = {}) {
    this.bus = options.bus ?? telemetryBus;
    this.sweepMs = Math.max(20, options.sweepMs ?? DEFAULT_SWEEP_MS);
    this.stateStore = options.stateStore ?? null;
    this.restorePersisted();
    if (options.autoSweep !== false) {
      this.sweepTimer = setInterval(() => this.sweepOffline(), this.sweepMs);
      this.sweepTimer.unref();
    }
  }

  /**
   * Restore live jobs from the previous process. A job recorded as running is
   * kept running: the node may still be executing it, and its next
   * publish/complete call must find the record instead of a 404. If the node
   * also died, the existing offline sweep pauses it once the heartbeat window
   * lapses. Queued jobs are re-attached to their computer's FIFO.
   */
  private restorePersisted(): void {
    if (!this.stateStore) return;
    let snapshot;
    try {
      snapshot = this.stateStore.load();
    } catch (error) {
      console.error("[computers] could not read persisted BYOC jobs:", error);
      return;
    }
    for (const job of snapshot.jobs) {
      this.jobs.set(job.runId, job);
    }
    for (const [computerId, runIds] of Object.entries(snapshot.queues)) {
      const queue = runIds.filter((runId) => this.jobs.has(runId));
      if (queue.length > 0) this.queues.set(computerId, queue);
    }
    // Any queued job missing from its queue (older snapshot/corruption) is
    // appended so it is still claimable rather than stranded.
    for (const job of snapshot.jobs) {
      if (job.status !== "queued") continue;
      const queue = this.queueFor(job.computerId);
      if (!queue.includes(job.runId)) queue.push(job.runId);
    }
    const byUser: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const job of [...snapshot.jobs].sort((a, b) => a.createdAt - b.createdAt)) {
      (byUser[job.userId] ??= []).push(job.runId);
    }
    for (const [userId, runIds] of Object.entries(byUser)) {
      this.byUser.set(userId, runIds.reverse());
    }
  }

  private persist(): void {
    if (!this.stateStore) return;
    this.stateStore.save(this.jobs.values(), this.queues);
  }

  /** Stop the offline sweep (tests / shutdown). */
  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private computerFor(job: Pick<RemoteJob, "userId" | "computerId">): Computer | null {
    return getComputer(job.userId, job.computerId);
  }

  private pushUser(userId: string, runId: string): void {
    const list = this.byUser.get(userId) ?? [];
    list.unshift(runId);
    if (list.length > HISTORY_LIMIT) {
      for (const stale of list.splice(HISTORY_LIMIT)) this.jobs.delete(stale);
    }
    this.byUser.set(userId, list);
  }

  private queueFor(computerId: string): string[] {
    let queue = this.queues.get(computerId);
    if (!queue) {
      queue = [];
      this.queues.set(computerId, queue);
    }
    return queue;
  }

  /** Start a run on one of the caller's online computers. */
  start(userId: string, input: RemoteStartInput): RemoteStartResult {
    const computer = getComputer(userId, input.computerId);
    if (!computer) {
      return { accepted: false, runId: "", error: "Computer not found.", status: 404 };
    }
    if (!computer.online) {
      return {
        accepted: false,
        runId: "",
        error: `Computer "${computer.name}" is offline. Bring it online, or choose SwarmAgents cloud.`,
        status: 409,
      };
    }
    const runId = `run_${randomUUID()}`;
    const job: RemoteJob = {
      runId,
      userId,
      computerId: computer.id,
      computerName: computer.name,
      prompt: input.prompt,
      ...(input.agentCard ? { agentCard: input.agentCard } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      status: "queued",
      createdAt: Date.now(),
    };
    this.jobs.set(runId, job);
    this.pushUser(userId, runId);
    const queue = this.queueFor(computer.id);
    queue.push(runId);
    this.persist();
    const compute: RunCompute = { kind: "computer", computerId: computer.id, name: computer.name };
    this.bus.publish(runId, {
      type: "run.created",
      data: {
        prompt: input.prompt,
        userId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        compute,
        kind: "agent",
      },
    });
    this.bus.publish(runId, {
      type: "run.queued",
      data: { position: queue.length, prompt: input.prompt, userId, compute },
    });
    return { accepted: true, runId };
  }

  /**
   * Claim the next queued job for an already-authenticated computer. Returns
   * null when the queue is empty. Starting a job emits run.started so the UI
   * flips from queued to running.
   */
  claim(userId: string, computerId: string): { job: RemoteJobPublic } | null {
    const queue = this.queueFor(computerId);
    for (;;) {
      const next = queue.shift();
      if (!next) return null;
      const job = this.jobs.get(next);
      if (!job || job.userId !== userId) continue;
      if (job.status !== "queued") continue;
      job.status = "running";
      job.startedAt = Date.now();
      this.bus.publish(job.runId, {
        type: "run.started",
        data: {
          ...(job.sessionId ? { sessionId: job.sessionId } : {}),
          startedAt: job.startedAt,
          provider: "your computer",
          model: "byoc",
        },
      });
      this.persist();
      return {
        job: {
          runId: job.runId,
          prompt: job.prompt,
          ...(job.agentCard ? { agentCard: job.agentCard } : {}),
          ...(job.sessionId ? { sessionId: job.sessionId } : {}),
          ...(job.projectId ? { projectId: job.projectId } : {}),
          createdAt: job.createdAt,
        },
      };
    }
  }

  /** Forward one agent event from the node. Only running jobs may publish. */
  publishEvent(userId: string, computerId: string, runId: string, event: unknown): boolean {
    const job = this.jobs.get(runId);
    if (!job || job.userId !== userId || job.computerId !== computerId) return false;
    if (job.status !== "running") return false;
    const safe = safeEvent(event);
    if (!safe) return false;
    this.bus.publish(runId, { type: safe.type, data: safe.data });
    return true;
  }

  /** Finish (or fail) a job from the node's terminal report. */
  complete(
    userId: string,
    computerId: string,
    runId: string,
    result: {
      status?: unknown;
      exitCode?: unknown;
      error?: unknown;
      text?: unknown;
      sessionId?: unknown;
      costUsd?: unknown;
      durationMs?: unknown;
      numTurns?: unknown;
    },
  ): boolean {
    const job = this.jobs.get(runId);
    if (!job || job.userId !== userId || job.computerId !== computerId) return false;
    if (job.status !== "running" && job.status !== "queued") return false;
    if (typeof result.text === "string" && result.text.trim()) {
      this.bus.publish(runId, { type: "assistant.text", data: { text: result.text.slice(0, 200_000) } });
    }
    const exitCode = typeof result.exitCode === "number" && Number.isFinite(result.exitCode) ? Math.trunc(result.exitCode) : 0;
    const failed = result.status === "error" || exitCode !== 0;
    const sessionId = typeof result.sessionId === "string" && result.sessionId.trim()
      ? result.sessionId.trim().slice(0, 256)
      : job.sessionId ?? runId;
    job.status = failed ? "error" : "finished";
    job.finishedAt = Date.now();
    if (failed) {
      const message =
        typeof result.error === "string" && result.error.trim()
          ? result.error.trim().slice(0, 2000)
          : `Computer run exited with code ${exitCode}.`;
      job.error = message;
      this.bus.publish(runId, { type: "run.error", data: { message, exitCode, sessionId } });
    } else {
      job.sessionId = sessionId;
      this.bus.publish(runId, {
        type: "run.finished",
        data: {
          exitCode,
          sessionId,
          durationMs:
            typeof result.durationMs === "number" && Number.isFinite(result.durationMs)
              ? Math.max(0, Math.trunc(result.durationMs))
              : job.startedAt
                ? Date.now() - job.startedAt
                : 0,
          ...(typeof result.costUsd === "number" && Number.isFinite(result.costUsd) ? { costUsd: result.costUsd } : {}),
          ...(typeof result.numTurns === "number" && Number.isFinite(result.numTurns)
            ? { numTurns: Math.max(0, Math.trunc(result.numTurns)) }
            : {}),
        },
      });
    }
    this.dropFromQueue(job);
    this.persist();
    return true;
  }

  private dropFromQueue(job: RemoteJob): void {
    const queue = this.queues.get(job.computerId);
    if (!queue) return;
    const index = queue.indexOf(job.runId);
    if (index >= 0) queue.splice(index, 1);
  }

  /** Pause one job (or every live job for a computer) without losing the prompt. */
  pauseComputerRuns(computerId: string, reason: "computer_offline" | "user" = "computer_offline"): number {
    let paused = 0;
    for (const job of this.jobs.values()) {
      if (job.computerId !== computerId) continue;
      if (job.status !== "queued" && job.status !== "running") continue;
      this.pauseJob(job, reason);
      paused++;
    }
    return paused;
  }

  /** Pause one owned run. Returns false when it is not live or not theirs. */
  pauseRun(userId: string, runId: string, reason: "computer_offline" | "user" = "computer_offline"): boolean {
    const job = this.jobs.get(runId);
    if (!job || job.userId !== userId) return false;
    if (job.status !== "queued" && job.status !== "running") return false;
    this.pauseJob(job, reason);
    return true;
  }

  private pauseJob(job: RemoteJob, reason: "computer_offline" | "user"): void {
    job.status = "paused";
    job.pausedReason = reason;
    job.finishedAt = Date.now();
    this.dropFromQueue(job);
    this.bus.publish(job.runId, {
      type: "run.paused",
      data: {
        reason,
        message:
          reason === "computer_offline"
            ? `"${job.computerName}" went offline. The run was paused.`
            : "Run paused.",
        computerId: job.computerId,
        computerName: job.computerName,
      },
    });
    this.persist();
  }

  /**
   * Pause every live run whose computer stopped heartbeating. Called by the
   * sweep timer and directly by tests.
   */
  sweepOffline(): number {
    let paused = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== "queued" && job.status !== "running") continue;
      const computer = this.computerFor(job);
      if (!computer || !computer.online) {
        this.pauseJob(job, "computer_offline");
        paused++;
      }
    }
    return paused;
  }

  /**
   * Re-dispatch a paused run to the same computer (new run id), once it is
   * online again. Returns the new run id, or an error explaining why not.
   */
  resume(userId: string, runId: string): { runId?: string; error?: string; status?: number } {
    const job = this.jobs.get(runId);
    if (!job || job.userId !== userId) return { error: "Run not found.", status: 404 };
    if (job.status !== "paused") return { error: "Only a paused run can be resumed.", status: 409 };
    const computer = getComputer(userId, job.computerId);
    if (!computer) return { error: "That computer was revoked.", status: 410 };
    if (!computer.online) return { error: `"${computer.name}" is still offline.`, status: 409 };
    const started = this.start(userId, {
      prompt: job.prompt,
      computerId: job.computerId,
      ...(job.sessionId ? { sessionId: job.sessionId } : {}),
      ...(job.projectId ? { projectId: job.projectId } : {}),
      ...(job.agentCard ? { agentCard: job.agentCard } : {}),
    });
    return started.accepted ? { runId: started.runId } : { error: started.error, status: started.status };
  }

  /** Cancel every live job for one revoked computer. Returns how many. */
  cancelComputerRuns(userId: string, computerId: string): number {
    let cancelled = 0;
    for (const job of this.jobs.values()) {
      if (job.userId !== userId || job.computerId !== computerId) continue;
      if (!this.isLive(job)) continue;
      job.status = "cancelled";
      job.finishedAt = Date.now();
      this.dropFromQueue(job);
      this.bus.publish(job.runId, { type: "run.cancelled", data: { reason: "user" } });
      cancelled++;
    }
    this.persist();
    return cancelled;
  }

  /** Cancel one owned live run, or all of them when runId is omitted. */
  cancel(userId: string, runId?: string): { ok: boolean; runId?: string } {
    const targets: RemoteJob[] = [];
    if (runId !== undefined) {
      const job = this.jobs.get(runId);
      if (!job || job.userId !== userId || !this.isLive(job)) return { ok: false };
      targets.push(job);
    } else {
      for (const job of this.jobs.values()) {
        if (job.userId === userId && this.isLive(job)) targets.push(job);
      }
    }
    for (const job of targets) {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      this.dropFromQueue(job);
      this.bus.publish(job.runId, { type: "run.cancelled", data: { reason: "user" } });
    }
    this.persist();
    return targets.length > 0 ? { ok: true, runId: targets[0].runId } : { ok: false };
  }

  private isLive(job: RemoteJob): boolean {
    return job.status === "queued" || job.status === "running" || job.status === "paused";
  }

  /** True when `runId` belongs to the caller (live or remembered). */
  ownsRun(userId: string, runId: string): boolean {
    return this.jobs.get(runId)?.userId === userId;
  }

  /** Live (queued/running/paused) runs for one account, newest first. */
  list(userId: string): RemoteRunSummary[] {
    const out: RemoteRunSummary[] = [];
    for (const runId of this.byUser.get(userId) ?? []) {
      const job = this.jobs.get(runId);
      if (!job) continue;
      if (job.status === "finished" || job.status === "error" || job.status === "cancelled") continue;
      const queue = this.queues.get(job.computerId);
      out.push({
        runId: job.runId,
        userId: job.userId,
        status: job.status,
        prompt: job.prompt,
        ...(job.sessionId ? { sessionId: job.sessionId } : {}),
        ...(job.projectId ? { projectId: job.projectId } : {}),
        createdAt: job.createdAt,
        ...(job.startedAt ? { startedAt: job.startedAt } : {}),
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        ...(job.error ? { error: job.error } : {}),
        compute: { kind: "computer", computerId: job.computerId, name: job.computerName },
        kind: "agent",
        ...(job.status === "queued" && queue
          ? { position: Math.max(1, queue.indexOf(job.runId) + 1) }
          : {}),
        lastSeq: this.bus.latestSeq(job.runId),
        ...(job.pausedReason ? { pausedReason: job.pausedReason } : {}),
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}

export interface RemoteJobPublic {
  runId: string;
  prompt: string;
  agentCard?: string;
  sessionId?: string;
  projectId?: string;
  createdAt: number;
}

const g = globalThis as typeof globalThis & { __swarmRemoteRuns?: RemoteRunManager };
export function getRemoteRunManager(): RemoteRunManager {
  if (g.__swarmRemoteRuns) return g.__swarmRemoteRuns;
  const manager = new RemoteRunManager({ stateStore: new RemoteRunStateStore() });
  g.__swarmRemoteRuns = manager;
  return manager;
}

/** Test hook: install a specific manager (or drop it) for route tests. */
export function setRemoteRunManagerForTesting(manager: RemoteRunManager | null): void {
  if (manager) g.__swarmRemoteRuns = manager;
  else delete g.__swarmRemoteRuns;
}

/** Test hook: drop the process-wide manager. */
export function resetRemoteRunManagerForTesting(): void {
  g.__swarmRemoteRuns?.stop();
  delete g.__swarmRemoteRuns;
}
