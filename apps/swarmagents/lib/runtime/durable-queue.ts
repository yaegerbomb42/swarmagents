/**
 * Durable per-user run state: the active cloud run and the FIFO prompt queue.
 *
 * The RuntimeManager's control plane is in memory by design (fast, one active
 * run per user), but a deploy or crash used to erase the queue along with the
 * process. This store snapshots the small part that must survive a restart:
 *
 *   - the active run's metadata (enough to identify it and abort it cleanly),
 *   - every queued prompt, in FIFO order, with the full fields it needs to
 *     start (the telemetry log only keeps a 300-char prompt preview, so it
 *     cannot reconstruct a queued run).
 *
 * It follows the same storage layout as the session store: one JSON file in
 * the board/user storage dir (SWARM_HOME -> ~/.swarmagents -> /data -> tmp),
 * written atomically (tmp + rename, mode 600). A missing or corrupt file is an
 * empty state, never a startup failure. Persistence is best-effort: a write
 * error is logged and the live run continues.
 *
 * State is intentionally *not* a scheduler: it restores the queue the previous
 * process accepted, then drains it through the normal one-active-run path.
 */

import fs from "node:fs";
import path from "node:path";
import { getStoragePaths } from "../board/store";
import type { RunCompute } from "../computers/compute";
import type { RunModeInfo } from "../providers/capabilities";
import type { RoleDefinition, RunRolePolicy } from "../roles";
import type { ResumePoint } from "./checkpoints";

export const RUNTIME_STATE_SCHEMA = "swarm-runtime-state";
export const RUNTIME_STATE_VERSION = 1;
export const RUNTIME_STATE_FILE = "runtime_state.json";

/** Run ids are minted as `run_<uuid>`; this is the same guard telemetry uses. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_USER_ID_LEN = 256;
const MAX_PROMPT_LEN = 200_000;
const MAX_AGENT_CARD_LEN = 4000;
const MAX_QUEUE_PER_USER = 100;
const FORBIDDEN_USER_IDS = new Set(["__proto__", "constructor", "prototype"]);

/** The active run fields a restart needs: identity plus display metadata. */
export interface PersistedActiveRun {
  runId: string;
  userId: string;
  prompt: string;
  agentCard?: string;
  sessionId?: string;
  model?: string;
  role?: RoleDefinition;
  rolePolicy: RunRolePolicy;
  projectId?: string;
  contextPrefix?: string;
  compute?: RunCompute;
  fullAuto?: boolean;
  runMode?: RunModeInfo;
  createdAt: number;
  startedAt?: number;
  /** Recorded resume point from the run's latest auto-checkpoint. */
  resumePoint?: ResumePoint;
  /** Watchdog recoveries already spent on this run (bounded; survives restarts). */
  recoveryAttempts?: number;
}

/** A prompt waiting behind the active run; everything startNext() needs. */
export interface PersistedQueuedRun {
  runId: string;
  userId: string;
  prompt: string;
  agentCard?: string;
  sessionId?: string;
  model?: string;
  role?: RoleDefinition;
  rolePolicy: RunRolePolicy;
  projectId?: string;
  projectContext?: string;
  compute?: RunCompute;
  fullAuto?: boolean;
  runMode?: RunModeInfo;
  /** Recorded resume point, when this queued run resumes from a checkpoint. */
  resumePoint?: ResumePoint;
  /** Watchdog recoveries already spent on this run (bounded; survives restarts). */
  recoveryAttempts?: number;
  createdAt: number;
}

export interface PersistedUserState {
  active: PersistedActiveRun | null;
  queue: PersistedQueuedRun[];
}

export interface PersistedRuntimeState {
  schema: typeof RUNTIME_STATE_SCHEMA;
  version: typeof RUNTIME_STATE_VERSION;
  updatedAt: number;
  users: Record<string, PersistedUserState>;
}

export interface RunStateStoreOptions {
  /** Explicit file path (tests / alternate deployments). */
  filePath?: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

function emptyState(): PersistedRuntimeState {
  return {
    schema: RUNTIME_STATE_SCHEMA,
    version: RUNTIME_STATE_VERSION,
    updatedAt: 0,
    users: Object.create(null) as Record<string, PersistedUserState>,
  };
}

function defaultFilePath(): string {
  return path.join(getStoragePaths().STORAGE_DIR, RUNTIME_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A spent-recovery counter: a non-negative integer, or absent when invalid. */
function normalizeRecoveryAttempts(value: unknown): number | undefined {
  const n = finiteNumber(value);
  if (n === undefined || n < 0) return undefined;
  return Math.floor(n);
}

function normalizeCompute(value: unknown): RunCompute | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "cloud") return { kind: "cloud" };
  if (value.kind !== "computer") return undefined;
  const computerId = str(value.computerId, 128);
  if (!computerId) return undefined;
  const name = str(value.name, 128);
  return { kind: "computer", computerId, ...(name ? { name } : {}) };
}

/** The role/policy are our own JSON, but normalize the outer shape defensively. */
function normalizeJsonObject<T>(value: unknown): T | undefined {
  return isRecord(value) ? (value as T) : undefined;
}

function normalizeRunMode(value: unknown): RunModeInfo | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode !== "gui" && value.mode !== "text" && value.mode !== "chat") return undefined;
  const label = typeof value.label === "string" ? value.label : value.mode;
  const reason = typeof value.reason === "string" ? value.reason : "";
  return { ...(value as unknown as RunModeInfo), mode: value.mode, label, reason };
}

function normalizeUserState(value: unknown): PersistedUserState | null {
  if (!isRecord(value)) return null;
  const rawQueue = Array.isArray(value.queue) ? value.queue : [];
  const queue: PersistedQueuedRun[] = [];
  for (const entry of rawQueue.slice(0, MAX_QUEUE_PER_USER)) {
    const run = normalizeQueued(entry);
    if (run) queue.push(run);
  }
  const active = value.active === null ? null : normalizeActive(value.active);
  return { active, queue };
}

function normalizeCommon(record: Record<string, unknown>):
  | Pick<
      PersistedQueuedRun,
      | "runId"
      | "userId"
      | "prompt"
      | "agentCard"
      | "sessionId"
      | "model"
      | "role"
      | "rolePolicy"
      | "projectId"
      | "compute"
      | "fullAuto"
      | "runMode"
      | "recoveryAttempts"
      | "createdAt"
    >
  | null {
  const runId = str(record.runId, 64);
  const userId = str(record.userId, MAX_USER_ID_LEN);
  const prompt = str(record.prompt, MAX_PROMPT_LEN);
  const rolePolicy = normalizeJsonObject<RunRolePolicy>(record.rolePolicy);
  const createdAt = finiteNumber(record.createdAt);
  if (!runId || !RUN_ID_RE.test(runId) || !userId || FORBIDDEN_USER_IDS.has(userId)) return null;
  if (!prompt || !rolePolicy || createdAt === undefined) return null;
  const role = normalizeJsonObject<RoleDefinition>(record.role);
  const compute = normalizeCompute(record.compute);
  const runMode = normalizeRunMode(record.runMode);
  const recoveryAttempts = normalizeRecoveryAttempts(record.recoveryAttempts);
  return {
    runId,
    userId,
    prompt,
    ...(str(record.agentCard, MAX_AGENT_CARD_LEN) ? { agentCard: str(record.agentCard, MAX_AGENT_CARD_LEN) } : {}),
    ...(str(record.sessionId, 256) ? { sessionId: str(record.sessionId, 256) } : {}),
    ...(str(record.model, 128) ? { model: str(record.model, 128) } : {}),
    ...(role ? { role } : {}),
    rolePolicy,
    ...(str(record.projectId, 128) ? { projectId: str(record.projectId, 128) } : {}),
    ...(compute ? { compute } : {}),
    ...(typeof record.fullAuto === "boolean" ? { fullAuto: record.fullAuto } : {}),
    ...(runMode ? { runMode } : {}),
    ...(recoveryAttempts !== undefined ? { recoveryAttempts } : {}),
    createdAt,
  };
}

function normalizeResumePoint(value: unknown): ResumePoint | undefined {
  if (!isRecord(value)) return undefined;
  const runId = str(value.runId, 64);
  const checkpointLabel = str(value.checkpointLabel, 64);
  const stepSeq = finiteNumber(value.stepSeq);
  if (!runId || !checkpointLabel || stepSeq === undefined || stepSeq <= 0) return undefined;
  const sessionId = str(value.sessionId, 128);
  return {
    runId,
    checkpointLabel,
    stepSeq,
    ...(sessionId ? { sessionId } : {}),
  };
}

function normalizeActive(value: unknown): PersistedActiveRun | null {
  if (!isRecord(value)) return null;
  const common = normalizeCommon(value);
  if (!common) return null;
  const resumePoint = normalizeResumePoint(value.resumePoint);
  return {
    ...common,
    ...(str(value.contextPrefix, MAX_PROMPT_LEN) ? { contextPrefix: str(value.contextPrefix, MAX_PROMPT_LEN) } : {}),
    ...(finiteNumber(value.startedAt) !== undefined ? { startedAt: finiteNumber(value.startedAt) } : {}),
    ...(resumePoint ? { resumePoint } : {}),
  };
}

function normalizeQueued(value: unknown): PersistedQueuedRun | null {
  if (!isRecord(value)) return null;
  const common = normalizeCommon(value);
  if (!common) return null;
  const resumePoint = normalizeResumePoint(value.resumePoint);
  return {
    ...common,
    ...(str(value.projectContext, MAX_PROMPT_LEN)
      ? { projectContext: str(value.projectContext, MAX_PROMPT_LEN) }
      : {}),
    ...(resumePoint ? { resumePoint } : {}),
  };
}

/**
 * One JSON snapshot of every user with live work. Writes are synchronous and
 * atomic: the runtime already does synchronous telemetry appends, and a queue
 * transition (accept / shift / finalize) must be durable before it returns.
 */
export class RunStateStore {
  private readonly explicitPath: string | undefined;
  private readonly now: () => number;

  constructor(options: RunStateStoreOptions = {}) {
    this.explicitPath = options.filePath;
    this.now = options.now ?? Date.now;
  }

  get filePath(): string {
    return this.explicitPath ?? defaultFilePath();
  }

  load(): PersistedRuntimeState {
    const state = emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch {
      return state;
    }
    if (!isRecord(parsed)) return state;
    if (parsed.schema !== RUNTIME_STATE_SCHEMA || parsed.version !== RUNTIME_STATE_VERSION) {
      return state;
    }
    const users = isRecord(parsed.users) ? parsed.users : {};
    for (const [userId, value] of Object.entries(users)) {
      if (!userId || userId.length > MAX_USER_ID_LEN || FORBIDDEN_USER_IDS.has(userId)) continue;
      const normalized = normalizeUserState(value);
      if (!normalized || (!normalized.active && normalized.queue.length === 0)) continue;
      state.users[userId] = normalized;
    }
    state.updatedAt = finiteNumber(parsed.updatedAt) ?? 0;
    return state;
  }

  save(users: Record<string, PersistedUserState>): void {
    const state: PersistedRuntimeState = {
      schema: RUNTIME_STATE_SCHEMA,
      version: RUNTIME_STATE_VERSION,
      updatedAt: this.now(),
      users,
    };
    const file = this.filePath;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(path.dirname(file), 0o700);
      } catch {
        // Best effort; the volume may be foreign-owned.
      }
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmp, file);
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // Best effort.
      }
    } catch (error) {
      // Losing the snapshot makes the restart non-durable, but it must never
      // break the live run or the request that triggered the transition.
      console.error(`[runtime] could not persist run state to ${file}:`, error);
    }
  }

  /** Test/reset hook: drop the persisted snapshot. */
  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // Best effort.
    }
  }
}
