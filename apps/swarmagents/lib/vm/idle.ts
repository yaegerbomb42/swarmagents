// Idle-hibernate policy for persistent user VMs.
//
// A per-user VM is long lived: it holds CPU, memory and a container slot on
// the host even when nobody talks to it. After SWARM_VM_IDLE_MIN minutes
// without activity the VM is stopped; the /workspace volume survives, so the
// next exec() transparently restarts the container and the user keeps their
// files.
//
// Env:
//   SWARM_VM_IDLE_MIN          minutes of inactivity before hibernation (0 = never)
//   SWARM_VM_SWEEP_INTERVAL_SEC how often the idle sweeper runs, in seconds

/** Default idle window: 30 minutes without activity. */
export const DEFAULT_VM_IDLE_MIN = 30;

/** Default cadence of the idle sweeper. */
export const DEFAULT_VM_SWEEP_INTERVAL_SEC = 60;

export interface VmIdleOptions {
  /** Minutes of inactivity before a user's VM is stopped (0 disables hibernate). */
  idleMinutes: number;
}

export interface VmIdlePolicy {
  /** Idle window in minutes (0 when hibernate is disabled). */
  idleMinutes: number;
  /** Idle window in milliseconds (0 when hibernate is disabled). */
  idleMs: number;
  /** How often the sweeper should run, in milliseconds (0 when disabled). */
  sweepIntervalMs: number;
}

/**
 * Parse an idle window in minutes. Accepts fractional minutes so tests and
 * ops can use sub-minute values. Invalid / negative input falls back.
 */
export function parseIdleMinutes(
  raw: string | number | null | undefined,
  fallback: number = DEFAULT_VM_IDLE_MIN,
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Parse the sweeper cadence in seconds (invalid input falls back). */
export function parseSweepIntervalSeconds(
  raw: string | number | null | undefined,
  fallback: number = DEFAULT_VM_SWEEP_INTERVAL_SEC,
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Resolve the idle policy: explicit options over SWARM_VM_* env vars over
 * the defaults. The sweep cadence never exceeds the idle window, so an idle
 * VM is hibernated within one idle window at the latest.
 */
export function resolveIdlePolicy(opts?: {
  idleMinutes?: number;
  sweepIntervalMs?: number;
}): VmIdlePolicy {
  const env = process.env;
  const idleMinutes = parseIdleMinutes(opts?.idleMinutes ?? env.SWARM_VM_IDLE_MIN);
  const idleMs = Math.round(idleMinutes * 60_000);

  if (idleMinutes === 0) {
    // Hibernate disabled: never stop a VM for being idle.
    return { idleMinutes: 0, idleMs: 0, sweepIntervalMs: 0 };
  }

  const requested = opts?.sweepIntervalMs ?? parseSweepIntervalSeconds(env.SWARM_VM_SWEEP_INTERVAL_SEC) * 1000;
  const sweepIntervalMs = requested > 0 ? Math.min(requested, idleMs) : idleMs;

  return { idleMinutes, idleMs, sweepIntervalMs };
}
