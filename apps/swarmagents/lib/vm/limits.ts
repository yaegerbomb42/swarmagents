// Per-VM container resource limits for the Docker driver.
//
// A persistent VM runs for weeks on the host daemon, so every container must
// carry a hard CPU / memory / PID ceiling: one user's runaway process must
// not be able to starve the host (or its neighbours).
//
// The ceilings come from the environment (SWARM_VM_MEMORY / SWARM_VM_CPUS /
// SWARM_VM_PIDS) and are validated here, before they can ever reach a
// `docker run` argv. An invalid value is a configuration bug, so it fails
// loudly with a typed error instead of silently running an unlimited box.

/** Default per-VM memory ceiling (docker `--memory`). */
export const DEFAULT_VM_MEMORY = "2g";

/**
 * Default per-VM memory ceiling in desktop mode (docker `--memory`). A
 * desktop container carries XFCE + a browser, so it gets the same default
 * floor as a headless VM but never less — explicit env / option overrides
 * still win.
 */
export const DEFAULT_VM_DESKTOP_MEMORY = "2g";

/** Default per-VM CPU ceiling in cores (docker `--cpus`). */
export const DEFAULT_VM_CPUS = "2";

/** Default per-VM PID ceiling (docker `--pids-limit`). */
export const DEFAULT_VM_PIDS = "512";

/** Env var holding the per-VM memory ceiling. */
export const VM_MEMORY_ENV = "SWARM_VM_MEMORY";

/** Env var holding the per-VM CPU ceiling. */
export const VM_CPUS_ENV = "SWARM_VM_CPUS";

/** Env var holding the per-VM PID ceiling. */
export const VM_PIDS_ENV = "SWARM_VM_PIDS";

/** Legacy alias for {@link VM_PIDS_ENV}, still honored. */
export const VM_PIDS_LEGACY_ENV = "SWARM_VM_PIDS_LIMIT";

/** The three ceilings applied to every VM container. */
export interface VmLimits {
  /** docker `--memory` value, e.g. "2g". */
  memory: string;
  /** docker `--cpus` value, e.g. "2". */
  cpus: string;
  /** docker `--pids-limit` value, e.g. "512". */
  pids: string;
}

/** The subset of the environment the limits are read from. */
export type VmLimitEnv = Record<string, string | undefined>;

/** Typed error thrown when a configured limit is not usable. */
export class VmLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VmLimitError";
  }
}

/** docker memory syntax: a number with an optional `b`/`k`/`m`/`g` unit. */
const MEMORY_RE = /^(\d+(?:\.\d+)?)([bkmg])$/i;

/** docker memory syntax without a unit: plain bytes. */
const MEMORY_BYTES_RE = /^\d+$/;

/** docker `--cpus` syntax: a positive decimal number of cores. */
const CPU_RE = /^\d+(?:\.\d+)?$/;

/** docker `--pids-limit` syntax: a positive integer. */
const PIDS_RE = /^\d+$/;

/**
 * Validate a memory ceiling. Accepts docker's size syntax ("2g", "512m",
 * "1.5g") and plain bytes ("1073741824"). The unit is lower-cased so the
 * value handed to docker is canonical.
 */
export function validateMemoryLimit(value: string, label = "memory"): string {
  const raw = (value ?? "").trim();
  if (!raw) {
    throw new VmLimitError(
      `Invalid ${label} value: expected a docker memory size such as 512m or 2g.`,
    );
  }
  if (MEMORY_BYTES_RE.test(raw)) {
    if (Number(raw) <= 0) {
      throw new VmLimitError(`Invalid ${label} value ${JSON.stringify(value)}: must be greater than 0.`);
    }
    return raw;
  }
  const m = MEMORY_RE.exec(raw);
  if (!m) {
    throw new VmLimitError(
      `Invalid ${label} value ${JSON.stringify(value)}: expected a docker memory size such as 512m or 2g.`,
    );
  }
  if (Number(m[1]) <= 0) {
    throw new VmLimitError(`Invalid ${label} value ${JSON.stringify(value)}: must be greater than 0.`);
  }
  return `${m[1]}${m[2].toLowerCase()}`;
}

/** Validate a CPU ceiling (cores). Fractional values such as "0.5" are fine. */
export function validateCpuLimit(value: string, label = "cpus"): string {
  const raw = (value ?? "").trim();
  if (!CPU_RE.test(raw)) {
    throw new VmLimitError(
      `Invalid ${label} value ${JSON.stringify(value)}: expected a positive number of CPUs such as 2 or 0.5.`,
    );
  }
  if (Number(raw) <= 0) {
    throw new VmLimitError(
      `Invalid ${label} value ${JSON.stringify(value)}: must be greater than 0.`,
    );
  }
  return raw;
}

/**
 * Validate a PID ceiling. Only positive integers are allowed: "0" and "-1"
 * mean "no limit" to docker, which is exactly what must never reach the host.
 */
export function validatePidsLimit(value: string, label = "pids"): string {
  const raw = (value ?? "").trim();
  if (!PIDS_RE.test(raw)) {
    throw new VmLimitError(
      `Invalid ${label} value ${JSON.stringify(value)}: expected a positive integer such as 512.`,
    );
  }
  if (Number(raw) < 1) {
    throw new VmLimitError(
      `Invalid ${label} value ${JSON.stringify(value)}: must be at least 1.`,
    );
  }
  return raw;
}

/** Read an env var, treating blank values as unset. */
function envValue(env: VmLimitEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve the effective limits from the environment, with explicit overrides
 * (constructor options) taking precedence over env, and env over the
 * defaults. Invalid values throw a {@link VmLimitError} naming the variable
 * that has to be fixed.
 */
export function resolveVmLimits(
  env: VmLimitEnv = process.env,
  overrides: Partial<VmLimits> = {},
  defaults?: Partial<VmLimits>,
): VmLimits {
  const memoryOverride = overrides.memory?.trim();
  const memory = memoryOverride || envValue(env, VM_MEMORY_ENV) || defaults?.memory?.trim() || DEFAULT_VM_MEMORY;
  const memoryLabel = memoryOverride ? "memory" : VM_MEMORY_ENV;

  const cpusOverride = overrides.cpus?.trim();
  const cpus = cpusOverride || envValue(env, VM_CPUS_ENV) || defaults?.cpus?.trim() || DEFAULT_VM_CPUS;
  const cpusLabel = cpusOverride ? "cpus" : VM_CPUS_ENV;

  const pidsOverride = overrides.pids?.trim();
  const legacyPids = envValue(env, VM_PIDS_LEGACY_ENV);
  const pids =
    pidsOverride ||
    envValue(env, VM_PIDS_ENV) ||
    legacyPids ||
    defaults?.pids?.trim() ||
    DEFAULT_VM_PIDS;
  const pidsLabel = pidsOverride
    ? "pids"
    : envValue(env, VM_PIDS_ENV)
      ? VM_PIDS_ENV
      : legacyPids
        ? VM_PIDS_LEGACY_ENV
        : "pids";

  return {
    memory: validateMemoryLimit(memory, memoryLabel),
    cpus: validateCpuLimit(cpus, cpusLabel),
    pids: validatePidsLimit(pids, pidsLabel),
  };
}
