/**
 * Durable snapshot of live BYOC jobs.
 *
 * A paired computer keeps executing a run independently of this server. When
 * the server restarts, dropping the job record loses the node's eventual
 * result and any queued work for that machine. This small JSON store keeps
 * only live jobs (queued/running/paused) plus the per-computer FIFO, so the
 * node's next claim/publish/complete call finds the job again and queued work
 * survives. Terminal jobs stay in the telemetry log, not here.
 *
 * Same storage dir and atomic write pattern as the cloud run snapshot.
 */

import fs from "node:fs";
import path from "node:path";
import { getStoragePaths } from "../board/store";
import type { RemoteJob } from "./remote";

export const REMOTE_RUNS_SCHEMA = "swarm-remote-runs";
export const REMOTE_RUNS_VERSION = 1;
export const REMOTE_RUNS_FILE = "remote_runs.json";

const MAX_USER_ID_LEN = 256;
const MAX_PROMPT_LEN = 200_000;
const MAX_JOBS = 1000;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_USER_IDS = new Set(["__proto__", "constructor", "prototype"]);

export interface RemoteRunSnapshot {
  jobs: RemoteJob[];
  queues: Record<string, string[]>;
}

interface RemoteRunsFile {
  schema: typeof REMOTE_RUNS_SCHEMA;
  version: typeof REMOTE_RUNS_VERSION;
  updatedAt: number;
  jobs: RemoteJob[];
  queues: Record<string, string[]>;
}

function defaultFilePath(): string {
  return path.join(getStoragePaths().STORAGE_DIR, REMOTE_RUNS_FILE);
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeJob(value: unknown): RemoteJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const runId = str(record.runId, 64);
  const userId = str(record.userId, MAX_USER_ID_LEN);
  const computerId = str(record.computerId, 128);
  const computerName = str(record.computerName, 128);
  const prompt = str(record.prompt, MAX_PROMPT_LEN);
  const createdAt = num(record.createdAt);
  const status = record.status;
  if (!runId || !RUN_ID_RE.test(runId) || !userId || FORBIDDEN_USER_IDS.has(userId)) return null;
  if (!computerId || !computerName || !prompt || createdAt === undefined) return null;
  if (status !== "queued" && status !== "running" && status !== "paused") return null;
  const pausedReason =
    record.pausedReason === "computer_offline" || record.pausedReason === "user"
      ? record.pausedReason
      : undefined;
  const startedAt = num(record.startedAt);
  const finishedAt = num(record.finishedAt);
  return {
    runId,
    userId,
    computerId,
    computerName,
    prompt,
    ...(str(record.agentCard, 4000) ? { agentCard: str(record.agentCard, 4000) } : {}),
    ...(str(record.sessionId, 256) ? { sessionId: str(record.sessionId, 256) } : {}),
    ...(str(record.projectId, 128) ? { projectId: str(record.projectId, 128) } : {}),
    status,
    createdAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(str(record.error, 2000) ? { error: str(record.error, 2000) } : {}),
    ...(pausedReason ? { pausedReason } : {}),
  };
}

function normalizeQueues(value: unknown): Record<string, string[]> {
  const queues: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return queues;
  for (const [computerId, list] of Object.entries(value)) {
    if (!computerId || FORBIDDEN_USER_IDS.has(computerId) || !Array.isArray(list)) continue;
    queues[computerId] = list
      .filter((runId): runId is string => typeof runId === "string" && RUN_ID_RE.test(runId))
      .slice(0, MAX_JOBS);
  }
  return queues;
}

export class RemoteRunStateStore {
  private readonly explicitPath: string | undefined;

  constructor(options: { filePath?: string } = {}) {
    this.explicitPath = options.filePath;
  }

  get filePath(): string {
    return this.explicitPath ?? defaultFilePath();
  }

  load(): RemoteRunSnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      return { jobs: [], queues: Object.create(null) as Record<string, string[]> };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { jobs: [], queues: Object.create(null) as Record<string, string[]> };
    }
    const file = parsed as Record<string, unknown>;
    if (file.schema !== REMOTE_RUNS_SCHEMA || file.version !== REMOTE_RUNS_VERSION) {
      return { jobs: [], queues: Object.create(null) as Record<string, string[]> };
    }
    const jobs = Array.isArray(file.jobs)
      ? file.jobs
          .map((entry) => normalizeJob(entry))
          .filter((entry): entry is RemoteJob => entry !== null)
          .slice(-MAX_JOBS)
      : [];
    return { jobs, queues: normalizeQueues(file.queues) };
  }

  save(jobs: Iterable<RemoteJob>, queues: Map<string, string[]>): void {
    const live = [...jobs].filter(
      (job) => job.status === "queued" || job.status === "running" || job.status === "paused",
    );
    const queueRecord: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const [computerId, list] of queues) {
      if (list.length > 0) queueRecord[computerId] = [...list];
    }
    const file: RemoteRunsFile = {
      schema: REMOTE_RUNS_SCHEMA,
      version: REMOTE_RUNS_VERSION,
      updatedAt: Date.now(),
      jobs: live.slice(-MAX_JOBS),
      queues: queueRecord,
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(path.dirname(this.filePath), 0o700);
      } catch {
        // Best effort.
      }
      const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Best effort.
      }
    } catch (error) {
      console.error(`[computers] could not persist live BYOC jobs to ${this.filePath}:`, error);
    }
  }
}
