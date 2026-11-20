// Per-user VM quotas: prevent a single user from exhausting the host.
//
// Independent limits, all enforced by VmManager.exec():
//  - maxConcurrentExecsPerUser: how many execs may be in flight (running or
//    queued behind the per-user lock) at once. Extra attempts are rejected.
//  - maxExecDurationMs / maxOutputBytes: short terminal-exec wall-clock and
//    combined stdout+stderr caps. On expiry the exec's signal is aborted;
//    excess output is truncated with a marker.
//  - agentMaxExecDurationMs / agentMaxOutputBytes: separate, larger caps for
//    the whole Claude Code invocation selected with quotaProfile: "agent".
//  - diskQuotaMb: cap on the /workspace disk footprint (measured with du,
//    cached for 60 s). New runs are refused while the user is over it.
//
// A limit of 0 disables that quota. Limits resolve from constructor options,
// falling back to SWARM_VM_* env vars, then to the defaults below.

export type QuotaKind =
  | "max_concurrent_execs"
  | "max_exec_duration"
  | "max_output_bytes"
  | "disk_quota";

/** Typed error thrown when a quota is exceeded. */
export class QuotaError extends Error {
  readonly kind: QuotaKind;
  readonly limit: number;
  readonly userId: string;

  constructor(kind: QuotaKind, limit: number, userId: string, message?: string) {
    super(message ?? `VM quota exceeded (${kind}, limit ${limit})`);
    this.name = "QuotaError";
    this.kind = kind;
    this.limit = limit;
    this.userId = userId;
  }
}

export interface VmQuotaOptions {
  /** Max execs in flight per user (0 = unlimited). Default 2. */
  maxConcurrentExecsPerUser: number;
  /** Max wall-clock duration of a short terminal exec, ms (0 = unlimited). Default 5 min. */
  maxExecDurationMs: number;
  /** Max terminal stdout+stderr bytes forwarded through exec callbacks (0 = unlimited). Default 1 MiB. */
  maxOutputBytes: number;
  /** Max wall-clock duration of one Claude Code invocation, ms (0 = unlimited). Default 2 hours. */
  agentMaxExecDurationMs: number;
  /** Max Claude Code stdout+stderr bytes, including its final result (0 = unlimited). Default 64 MiB. */
  agentMaxOutputBytes: number;
  /** Max /workspace disk usage in MB (0 = disabled). Default 0 (off). */
  diskQuotaMb: number;
}

export const DEFAULT_VM_QUOTAS: VmQuotaOptions = {
  maxConcurrentExecsPerUser: 2,
  maxExecDurationMs: 5 * 60_000,
  maxOutputBytes: 1024 * 1024,
  agentMaxExecDurationMs: 2 * 60 * 60_000,
  agentMaxOutputBytes: 64 * 1024 * 1024,
  diskQuotaMb: 0,
};

/** Appended once to the output stream when the byte cap is hit. */
export const TRUNCATION_MARKER = "\n[output truncated: VM output quota exceeded]";

function parseLimit(raw: number | string | null | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Merge explicit options over SWARM_VM_* env vars over defaults.
 * Env: SWARM_VM_MAX_CONCURRENT_EXECS, SWARM_VM_MAX_EXEC_MS, SWARM_VM_MAX_OUTPUT_BYTES,
 * SWARM_VM_AGENT_MAX_EXEC_MS, SWARM_VM_AGENT_MAX_OUTPUT_BYTES,
 * SWARM_VM_DISK_QUOTA_MB.
 */
export function resolveVmQuotas(partial?: Partial<VmQuotaOptions>): VmQuotaOptions {
  const env = process.env;
  const d = DEFAULT_VM_QUOTAS;
  return {
    maxConcurrentExecsPerUser: parseLimit(
      partial?.maxConcurrentExecsPerUser ?? env.SWARM_VM_MAX_CONCURRENT_EXECS,
      d.maxConcurrentExecsPerUser,
    ),
    maxExecDurationMs: parseLimit(
      partial?.maxExecDurationMs ?? env.SWARM_VM_MAX_EXEC_MS,
      d.maxExecDurationMs,
    ),
    maxOutputBytes: parseLimit(
      partial?.maxOutputBytes ?? env.SWARM_VM_MAX_OUTPUT_BYTES,
      d.maxOutputBytes,
    ),
    agentMaxExecDurationMs: parseLimit(
      partial?.agentMaxExecDurationMs ?? env.SWARM_VM_AGENT_MAX_EXEC_MS,
      d.agentMaxExecDurationMs,
    ),
    agentMaxOutputBytes: parseLimit(
      partial?.agentMaxOutputBytes ?? env.SWARM_VM_AGENT_MAX_OUTPUT_BYTES,
      d.agentMaxOutputBytes,
    ),
    diskQuotaMb: parseLimit(
      partial?.diskQuotaMb ?? env.SWARM_VM_DISK_QUOTA_MB,
      d.diskQuotaMb,
    ),
  };
}

/**
 * Byte-limited output tap. Forwards chunks to an optional sink until the
 * total utf8 byte count would exceed the cap, then emits the truncation
 * marker once and drops everything after. limit <= 0 forwards unbounded.
 */
export interface OutputBudget {
  bytes: number;
  truncated: boolean;
}

export class OutputCap {
  readonly sink?: (chunk: string) => void;
  readonly limit: number;
  private readonly local: OutputBudget = { bytes: 0, truncated: false };
  private readonly budget: OutputBudget;

  constructor(limit: number, sink?: (chunk: string) => void, shared?: OutputBudget) {
    this.limit = limit;
    this.sink = sink;
    this.budget = shared ?? this.local;
  }

  get byteCount(): number {
    return this.budget.bytes;
  }

  get didTruncate(): boolean {
    return this.budget.truncated;
  }

  write(chunk: string): void {
    if (this.budget.truncated || !chunk) return;
    if (this.limit <= 0) {
      this.budget.bytes += Buffer.byteLength(chunk, "utf8");
      this.sink?.(chunk);
      return;
    }
    const remaining = this.limit - this.budget.bytes;
    const size = Buffer.byteLength(chunk, "utf8");
    if (size <= remaining) {
      this.budget.bytes += size;
      this.sink?.(chunk);
      return;
    }
    const slice = sliceToByteLimit(chunk, remaining);
    if (slice) {
      this.budget.bytes += Buffer.byteLength(slice, "utf8");
      this.sink?.(slice);
    }
    this.budget.truncated = true;
    this.sink?.(TRUNCATION_MARKER);
  }
}

/** Trim a string so its utf8 encoding fits in `maxBytes` (never splits a code point). */
export function sliceToByteLimit(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let end = Math.min(s.length, maxBytes);
  while (end > 0 && Buffer.byteLength(s.slice(0, end), "utf8") > maxBytes) {
    end--;
  }
  return s.slice(0, end);
}
