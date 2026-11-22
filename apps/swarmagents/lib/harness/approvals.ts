/**
 * Approval store for the harness risk gate.
 *
 * When the classifier flags a tool call "ask", the runner pauses and an
 * approval record is created here. The user decides via
 * `POST /api/runtime/approvals/{id}` (approve / deny); if nobody decides within
 * the TTL the approval auto-expires and is treated exactly like a denial.
 *
 * The store used to be purely per-process, so a restart silently dropped
 * pending approvals and their paused runs. It now persists approvals to
 * `<storage dir>/approvals.json` (atomic write, mode 600). The TTL is absolute
 * wall clock: restart does not pause it. A pending approval that was owned by
 * the run the restart killed is explicitly expired with
 * `expiredReason: "server_restart"` by the runtime's recovery path — it is
 * never silently reinterpreted as a user denial. Pending approvals whose run
 * is still considered live keep their remaining time and timer.
 *
 * Persistence is best-effort: a write failure is logged and approval handling
 * continues in memory.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile } from "../atomic-write";
import { getStoragePaths } from "../board/store";
import { recordAudit } from "../audit";

export type ApprovalVerdict = "approved" | "denied" | "expired";
export type ApprovalStatus = "pending" | ApprovalVerdict;
export type ApprovalExpiredReason = "ttl" | "run_cancelled" | "server_restart";

export type ApprovalKind = "tool" | "role_escalation";

export const APPROVALS_SCHEMA = "swarm-approvals";
export const APPROVALS_VERSION = 1;
export const APPROVALS_FILE = "approvals.json";
/** Keep decided approvals this long so a late decision still gets a clear 409. */
const DECIDED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED_APPROVALS = 500;

export interface PendingApproval {
  id: string;
  runId: string;
  userId: string;
  toolName: string;
  /** Human-readable summary of the flagged action (e.g. the shell command). */
  action: string;
  reason: string;
  /** What is being approved: a tool call (default) or a role escalation. */
  kind?: ApprovalKind;
  /** For role escalations: the role the agent is switching from. */
  fromRole?: { id: string; name: string };
  /** For role escalations: the role the agent is switching to. */
  toRole?: { id: string; name: string };
  /** For role escalations: capabilities the target adds over the run's baseline. */
  addedPermissions?: string[];
  addedTools?: string[];
  addedMcpServers?: string[];
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  decidedAt?: number;
  /** True when the approval expired because nobody decided before the TTL. */
  timedOut?: boolean;
  /** Why an expired approval expired (absent for approved/denied/legacy). */
  expiredReason?: ApprovalExpiredReason;
}

/** Called when a pending approval auto-denies itself after the TTL. */
export type ApprovalTimeoutHandler = (approval: PendingApproval) => void;

export interface ApprovalStoreOptions {
  /** How long a pending approval waits before auto-expiring. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Default timeout hook; a per-create `onTimeout` overrides it. */
  onTimeout?: ApprovalTimeoutHandler;
  /**
   * Durable snapshot path. Omitted/null keeps the store in memory (the default
   * for direct construction in tests); the process-wide singleton enables it.
   */
  persistPath?: string | null;
}

export interface CreateApprovalInput {
  runId: string;
  userId: string;
  toolName: string;
  action: string;
  reason: string;
  /** What is being approved: a tool call (default) or a role escalation. */
  kind?: ApprovalKind;
  fromRole?: { id: string; name: string };
  toRole?: { id: string; name: string };
  addedPermissions?: string[];
  addedTools?: string[];
  addedMcpServers?: string[];
  /** Called exactly once if this approval times out (never on a manual denial). */
  onTimeout?: ApprovalTimeoutHandler;
}

const DEFAULT_TTL_SEC = 300;

/**
 * TTL from SWARM_APPROVAL_TIMEOUT_SEC (seconds, default 300). The older
 * SWARM_APPROVAL_TIMEOUT_MS remains supported as a fallback for compatibility.
 */
function defaultTtlMs(): number {
  const fromSec = Number(process.env.SWARM_APPROVAL_TIMEOUT_SEC);
  if (Number.isFinite(fromSec) && fromSec > 0) return fromSec * 1000;
  const fromMs = Number(process.env.SWARM_APPROVAL_TIMEOUT_MS);
  if (Number.isFinite(fromMs) && fromMs > 0) return fromMs;
  return DEFAULT_TTL_SEC * 1000;
}

/** Default durable path, next to the run state snapshot and the session store. */
export function getApprovalStorePath(): string {
  return path.join(getStoragePaths().STORAGE_DIR, APPROVALS_FILE);
}

interface WaitEntry {
  promise: Promise<ApprovalVerdict>;
  decide: (verdict: ApprovalVerdict) => void;
  /** Timeout hook for this approval (per-create override, else the store default). */
  onTimeout?: ApprovalTimeoutHandler;
}

interface ApprovalsFile {
  schema: typeof APPROVALS_SCHEMA;
  version: typeof APPROVALS_VERSION;
  approvals: PendingApproval[];
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_USER_IDS = new Set(["__proto__", "constructor", "prototype"]);

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, 100);
  return out.length > 0 ? out : undefined;
}

function roleRef(value: unknown): { id: string; name: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = str(record.id, 64);
  const name = str(record.name, 128);
  return id && name ? { id, name } : undefined;
}

function normalizeApproval(value: unknown): PendingApproval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = str(record.id, 128);
  const runId = str(record.runId, 64);
  const userId = str(record.userId, 256);
  const toolName = str(record.toolName, 200);
  const action = str(record.action, 2000);
  const reason = str(record.reason, 2000);
  const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : undefined;
  const expiresAt = typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) ? record.expiresAt : undefined;
  const status = record.status;
  if (!id || !runId || !RUN_ID_RE.test(runId) || !userId || FORBIDDEN_USER_IDS.has(userId)) return null;
  if (!toolName || !action || !reason || createdAt === undefined || expiresAt === undefined) return null;
  if (status !== "pending" && status !== "approved" && status !== "denied" && status !== "expired") return null;
  const kind = record.kind === "role_escalation" ? "role_escalation" : record.kind === "tool" ? "tool" : undefined;
  const fromRole = roleRef(record.fromRole);
  const toRole = roleRef(record.toRole);
  const expiredReason =
    record.expiredReason === "ttl" || record.expiredReason === "run_cancelled" || record.expiredReason === "server_restart"
      ? record.expiredReason
      : undefined;
  const decidedAt =
    typeof record.decidedAt === "number" && Number.isFinite(record.decidedAt) ? record.decidedAt : undefined;
  return {
    id,
    runId,
    userId,
    toolName,
    action,
    reason,
    ...(kind ? { kind } : {}),
    ...(fromRole ? { fromRole } : {}),
    ...(toRole ? { toRole } : {}),
    ...(strArray(record.addedPermissions) ? { addedPermissions: strArray(record.addedPermissions) } : {}),
    ...(strArray(record.addedTools) ? { addedTools: strArray(record.addedTools) } : {}),
    ...(strArray(record.addedMcpServers) ? { addedMcpServers: strArray(record.addedMcpServers) } : {}),
    createdAt,
    expiresAt,
    status,
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    ...(record.timedOut === true ? { timedOut: true } : {}),
    ...(expiredReason ? { expiredReason } : {}),
  };
}

export class ApprovalStore {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly waiters = new Map<string, WaitEntry>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;
  private readonly defaultOnTimeout: ApprovalTimeoutHandler | undefined;
  private readonly persistPath: string | null;

  constructor(options: ApprovalStoreOptions = {}) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.defaultOnTimeout = options.onTimeout;
    this.persistPath = options.persistPath ?? null;
    if (this.persistPath) this.loadPersisted();
  }

  /** Create a pending approval for a flagged tool call. */
  create(input: CreateApprovalInput): PendingApproval {
    const id = `appr_${randomUUID()}`;
    const now = this.now();
    const ttlMs = this.ttlMs ?? defaultTtlMs();
    const approval: PendingApproval = {
      id,
      runId: input.runId,
      userId: input.userId,
      toolName: input.toolName,
      action: input.action,
      reason: input.reason,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.fromRole ? { fromRole: input.fromRole } : {}),
      ...(input.toRole ? { toRole: input.toRole } : {}),
      ...(input.addedPermissions ? { addedPermissions: input.addedPermissions } : {}),
      ...(input.addedTools ? { addedTools: input.addedTools } : {}),
      ...(input.addedMcpServers ? { addedMcpServers: input.addedMcpServers } : {}),
      createdAt: now,
      expiresAt: now + ttlMs,
      status: "pending",
    };
    this.approvals.set(id, approval);

    this.createWaiter(id, input.onTimeout ?? this.defaultOnTimeout);
    this.armTimer(id, ttlMs);
    this.persist();
    return approval;
  }

  get(id: string): PendingApproval | undefined {
    return this.approvals.get(id);
  }

  /** All pending approvals owned by one user, oldest first. */
  listPendingForUser(userId: string): PendingApproval[] {
    return [...this.approvals.values()]
      .filter((approval) => approval.userId === userId && approval.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Promise that settles when the approval is decided (or expires). */
  waitFor(id: string): Promise<ApprovalVerdict> {
    const waiter = this.waiters.get(id);
    if (waiter) return waiter.promise;
    // No waiter: the approval may already be decided (its waiter was
    // deleted on settle) or restored without one. Report its verdict
    // instead of a wrong "expired".
    const approval = this.approvals.get(id);
    if (approval && approval.status !== "pending") return Promise.resolve(approval.status);
    return Promise.resolve("expired");
  }

  /**
   * Resolve a pending approval. Idempotent: deciding twice keeps the first
   * verdict. A decision that arrives after the TTL has elapsed does not
   * resurrect the approval: it expires as a timeout instead.
   */
  resolve(id: string, verdict: "approved" | "denied"): PendingApproval | undefined {
    const approval = this.approvals.get(id);
    if (!approval) return undefined;
    if (approval.status === "pending") {
      if (this.now() >= approval.expiresAt) {
        // The TTL elapsed but the timer has not fired yet (timers can lag):
        // expire rather than apply a verdict to a dead approval.
        this.expireApproval(approval);
        return approval;
      }
      approval.status = verdict;
      approval.decidedAt = this.now();
      this.clearTimer(id);
      this.settleWaiter(id, verdict);
      this.persist();
    }
    return approval;
  }

  /**
   * Expire every pending approval for a run (cancel / restart). `reason`
   * distinguishes a user/system cancellation from a process restart so the
   * recorded outcome is never mistaken for the TTL auto-deny.
   */
  expirePendingForRun(
    runId: string,
    reason: Exclude<ApprovalExpiredReason, "ttl"> = "run_cancelled",
  ): void {
    let changed = false;
    for (const approval of this.approvals.values()) {
      if (approval.runId !== runId || approval.status !== "pending") continue;
      approval.status = "expired";
      approval.decidedAt = this.now();
      approval.expiredReason = reason;
      this.clearTimer(approval.id);
      this.settleWaiter(approval.id, "expired");
      changed = true;
      if (reason === "server_restart") {
        recordAudit({
          user: approval.userId,
          action: "approval.expire",
          target: approval.id,
          result: "success",
        });
      }
    }
    if (changed) this.persist();
  }

  /** Explicit restart path: the owning run was aborted by recovery. */
  expireForRunRestart(runId: string): void {
    this.expirePendingForRun(runId, "server_restart");
  }

  /** Test/reset hook: drop all state (and the durable snapshot). */
  clear(): void {
    for (const id of this.timers.keys()) this.clearTimer(id);
    this.approvals.clear();
    this.waiters.clear();
    if (this.persistPath) {
      try {
        fs.rmSync(this.persistPath, { force: true });
      } catch {
        // Best effort.
      }
    }
  }

  private createWaiter(id: string, onTimeout?: ApprovalTimeoutHandler): void {
    let decide!: (verdict: ApprovalVerdict) => void;
    const promise = new Promise<ApprovalVerdict>((resolve) => {
      decide = resolve;
    });
    this.waiters.set(id, { promise, decide, onTimeout });
  }

  /**
   * Decide a waiter's promise and drop the entry: a settled waiter is
   * never awaited again, so keeping it would leak one promise per
   * approval forever. Late waitFor() calls fall back to the stored
   * approval's verdict, so deleting here loses no information.
   */
  private settleWaiter(id: string, verdict: ApprovalVerdict): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.decide(verdict);
  }

  /**
   * Expire a pending approval because its TTL elapsed — either the timer
   * fired, or a decision arrived after the deadline. Fires the timeout
   * hook exactly once (read from the waiter before settling it) and
   * audits the expiry.
   */
  private expireApproval(approval: PendingApproval): void {
    const onTimeout = this.waiters.get(approval.id)?.onTimeout;
    approval.status = "expired";
    approval.decidedAt = this.now();
    approval.timedOut = true;
    approval.expiredReason = "ttl";
    this.clearTimer(approval.id);
    this.settleWaiter(approval.id, "expired");
    recordAudit({ user: approval.userId, action: "approval.expire", target: approval.id, result: "success" });
    try {
      onTimeout?.(approval);
    } catch {
      // A broken telemetry hook must never keep the run paused.
    }
    this.persist();
  }

  private armTimer(id: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const current = this.approvals.get(id);
      if (!current || current.status !== "pending") return;
      this.expireApproval(current);
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private loadPersisted(): void {
    if (!this.persistPath) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const file = parsed as Record<string, unknown>;
    if (file.schema !== APPROVALS_SCHEMA || file.version !== APPROVALS_VERSION) return;
    if (!Array.isArray(file.approvals)) return;
    const now = this.now();
    let repaired = false;
    for (const entry of file.approvals) {
      const approval = normalizeApproval(entry);
      if (!approval) continue;
      this.approvals.set(approval.id, approval);
      if (approval.status !== "pending") continue;
      if (approval.expiresAt <= now) {
        // The clock did not pause across the restart: an approval that ran out
        // while the process was down is expired, not still pending.
        approval.status = "expired";
        approval.decidedAt = approval.expiresAt;
        approval.timedOut = true;
        approval.expiredReason = "ttl";
        recordAudit({
          user: approval.userId,
          action: "approval.expire",
          target: approval.id,
          result: "success",
        });
        repaired = true;
        continue;
      }
      // Restored pending approvals need a waiter too: without one,
      // waitFor() would resolve "expired" immediately for an approval
      // that is still live, and the paused run would resume wrongly.
      this.createWaiter(approval.id, this.defaultOnTimeout);
      this.armTimer(approval.id, approval.expiresAt - now);
    }
    if (repaired) this.persist();
  }

  private persist(): void {
    if (!this.persistPath) return;
    const now = this.now();
    // Prune decided records older than the retention bound from memory
    // too: disk serialization already trimmed them, but the in-memory
    // map grew without bound.
    for (const [id, approval] of this.approvals) {
      if (
        approval.status !== "pending" &&
        approval.decidedAt !== undefined &&
        now - approval.decidedAt > DECIDED_RETENTION_MS
      ) {
        this.approvals.delete(id);
        this.waiters.delete(id);
        this.clearTimer(id);
      }
    }
    const entries = [...this.approvals.values()]
      .filter(
        (approval) =>
          approval.status === "pending" ||
          approval.decidedAt === undefined ||
          now - approval.decidedAt <= DECIDED_RETENTION_MS,
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-MAX_PERSISTED_APPROVALS);
    const file: ApprovalsFile = {
      schema: APPROVALS_SCHEMA,
      version: APPROVALS_VERSION,
      approvals: entries,
    };
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(path.dirname(this.persistPath), 0o700);
      } catch {
        // Best effort.
      }
      // Shared atomic writer: unique temp name (no same-millisecond
      // collision), fsync before the rename, temp removed on failure.
      atomicWriteFile(this.persistPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(`[approvals] could not persist to ${this.persistPath}:`, error);
    }
  }
}

/** Process-wide singleton shared by the runtime manager and the approvals route. */
const g = globalThis as typeof globalThis & { __swarmApprovalStore?: ApprovalStore };
export const approvalStore: ApprovalStore =
  g.__swarmApprovalStore ??
  (g.__swarmApprovalStore = new ApprovalStore({ persistPath: getApprovalStorePath() }));
export function getApprovalStore(): ApprovalStore {
  return g.__swarmApprovalStore ?? (g.__swarmApprovalStore = new ApprovalStore({ persistPath: getApprovalStorePath() }));
}
export function setApprovalStoreForTesting(store: ApprovalStore | null): void {
  g.__swarmApprovalStore = store ?? undefined;
}
