/**
 * Readiness probes for GET /api/health?ready=1.
 *
 * Unlike the bare liveness signal (healthSnapshot), readiness verifies the
 * things a real run depends on: the VM driver is reachable (docker version or
 * fake), the SWARM_HOME directory is writable, and the filesystem that backs
 * it has enough free disk. When any check fails the caller should surface a
 * 503 with these per-check results.
 *
 * The full report carries operator detail (paths, byte counts, driver
 * diagnostics) and must stay server-side: only `publicReadinessReport` is safe
 * to return from the public probe. Failures are also tagged with stable,
 * non-sensitive reason codes so clients get an actionable signal without the
 * underlying path or raw error text.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { defaultDriverName } from "./vm/driver-default";

/** Stable, non-sensitive failure codes — safe to include in a public payload. */
export type ReadinessReason =
  | "HOME_MISSING"
  | "HOME_NOT_WRITABLE"
  | "DISK_LOW"
  | "DISK_UNAVAILABLE"
  | "DOCKER_UNREACHABLE";

/** Internal check result. `message` is a fixed diagnostic, never a raw error. */
export interface ReadinessResult {
  ok: boolean;
  reason?: ReadinessReason;
  message?: string;
}

export interface ReadinessReport {
  ready: boolean;
  vmDriver: ReadinessResult & { kind: string };
  home: ReadinessResult & { dir: string; writable: boolean };
  disk: ReadinessResult & { freeBytes: number; freeMb: number; low: boolean };
}

/** One check as exposed publicly: no paths, raw errors, or byte counts. */
export interface PublicCheck {
  ok: boolean;
  writable?: boolean;
  /**
   * Present only when the check failed. `low` on disk is the only size hint
   * the public payload ever gets.
   */
  reason?: ReadinessReason;
}

export interface PublicReadinessReport {
  ready: boolean;
  vmDriverKind: string;
  vmDriver: PublicCheck;
  home: PublicCheck & { writable: boolean };
  disk: PublicCheck & { low: boolean };
}

/** Operator-only detail (admin view and server logs). */
export interface ReadinessDetail {
  vmDriver: { kind: string; message?: string };
  home: { dir: string; writable: boolean; message?: string };
  disk: { freeBytes: number; freeMb: number; message?: string };
}

/** Detail available to an authenticated operator, never to the public probe. */
export type AdminReadinessReport = PublicReadinessReport & { detail: ReadinessDetail };

export interface ReadinessOptions {
  /** Override the docker version probe (tests). */
  dockerChecker?: () => Promise<ReadinessResult>;
  /** Override fs.statfsSync (tests). */
  statfsSync?: (dir: string) => { bavail: number | bigint; bsize: number | bigint };
}

/** Minimum free disk on the SWARM_HOME filesystem for a healthy environment. */
export const MIN_FREE_DISK_MB = 256;

const DOCKER_TIMEOUT_MS = 5000;

function spawnExitCode(cmd: string, args: readonly string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: "ignore" });
    } catch {
      settle(1);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(1);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      settle(1);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      settle(code ?? 1);
    });
  });
}

async function checkDocker(): Promise<ReadinessResult> {
  const code = await spawnExitCode("docker", ["version"], DOCKER_TIMEOUT_MS);
  return code === 0
    ? { ok: true }
    : { ok: false, reason: "DOCKER_UNREACHABLE", message: "docker unreachable" };
}

function homeDirFor(env: Readonly<Record<string, string | undefined>>): string {
  return env.SWARM_HOME?.trim() || path.join(os.homedir(), ".swarmagents");
}

/** Nearest existing ancestor directory of a path (which may not exist yet). */
function nearestExistingDir(dir: string): string {
  let d = dir;
  for (;;) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {
      // Walk up to the nearest existing ancestor.
    }
    const up = path.dirname(d);
    if (up === d) return d;
    d = up;
  }
}

function checkHome(home: string): ReadinessResult & { dir: string; writable: boolean } {
  // An existing directory must itself be writable. Walking up to a writable
  // parent would report "ok" for a home the process cannot actually use.
  try {
    if (!fs.statSync(home).isDirectory()) {
      return { ok: false, dir: home, writable: false, reason: "HOME_NOT_WRITABLE", message: "home is not a directory" };
    }
    fs.accessSync(home, fs.constants.W_OK);
    return { ok: true, dir: home, writable: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, dir: home, writable: false, reason: "HOME_NOT_WRITABLE", message: "home is not writable" };
    }
  }

  // The home does not exist yet: the nearest existing parent must be
  // writable so the directory can be created. If it is not, the root cause
  // is the missing home, so report HOME_MISSING (never the raw fs error).
  let d = home;
  for (;;) {
    const up = path.dirname(d);
    if (up === d) {
      return { ok: false, dir: home, writable: false, reason: "HOME_MISSING", message: "home is missing" };
    }
    d = up;
    try {
      if (!fs.statSync(d).isDirectory()) {
        return { ok: false, dir: home, writable: false, reason: "HOME_MISSING", message: "home is missing" };
      }
      fs.accessSync(d, fs.constants.W_OK);
      return { ok: true, dir: home, writable: true };
    } catch (err) {
      // A missing ancestor is fine; a permission/stat error is not.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, dir: home, writable: false, reason: "HOME_MISSING", message: "home is missing" };
      }
    }
  }
}

function checkDisk(
  statfsImpl: (dir: string) => { bavail: number | bigint; bsize: number | bigint },
  dir: string,
): ReadinessResult & { freeBytes: number; freeMb: number; low: boolean } {
  try {
    const s = statfsImpl(dir);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const freeMb = Math.floor(freeBytes / (1024 * 1024));
    const low = freeMb < MIN_FREE_DISK_MB;
    return {
      ok: !low,
      freeBytes,
      freeMb,
      low,
      ...(low ? { reason: "DISK_LOW" as const, message: "free disk below minimum" } : {}),
    };
  } catch {
    // Never echo the fs error: it embeds the probed path.
    return {
      ok: false,
      freeBytes: 0,
      freeMb: 0,
      low: false,
      reason: "DISK_UNAVAILABLE",
      message: "disk usage unavailable",
    };
  }
}

/**
 * Build a readiness report for the current environment. Checks the VM driver
 * (docker version or fake), SWARM_HOME writability and free disk on the
 * filesystem backing it. `ready` is true only when every check passes.
 *
 * The result is operator detail: callers must pass it through
 * `publicReadinessReport` before returning it from the public probe.
 */
export async function readinessSnapshot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: ReadinessOptions = {},
): Promise<ReadinessReport> {
  const driverKind = env.SWARM_VM_DRIVER?.trim() || defaultDriverName(env);
  const dockerChecker = opts.dockerChecker ?? checkDocker;
  const statfsImpl = opts.statfsSync ?? ((dir: string) => fs.statfsSync(dir));

  const vmDriver = driverKind === "docker" ? await dockerChecker() : { ok: true };

  const home = homeDirFor(env);
  const homeCheck = checkHome(home);
  const diskCheck = checkDisk(statfsImpl, nearestExistingDir(home));

  const ready = vmDriver.ok && homeCheck.ok && diskCheck.ok;
  return {
    ready,
    vmDriver: { ...vmDriver, kind: driverKind },
    home: homeCheck,
    disk: diskCheck,
  };
}

/**
 * Redact a report for the public probe: per-check booleans, the home
 * `writable` flag, and stable reason codes only. Paths, exact byte counts and
 * raw/diagnostic messages are dropped.
 */
export function publicReadinessReport(report: ReadinessReport): PublicReadinessReport {
  const failure = (ok: boolean, reason: ReadinessReason | undefined, fallback: ReadinessReason) =>
    ok ? {} : { reason: reason ?? fallback };

  return {
    ready: report.ready,
    vmDriverKind: report.vmDriver.kind,
    vmDriver: {
      ok: report.vmDriver.ok,
      ...failure(report.vmDriver.ok, report.vmDriver.reason, "DOCKER_UNREACHABLE"),
    },
    home: {
      ok: report.home.ok,
      writable: report.home.writable,
      ...failure(report.home.ok, report.home.reason, "HOME_NOT_WRITABLE"),
    },
    disk: {
      ok: report.disk.ok,
      low: report.disk.low,
      ...failure(report.disk.ok, report.disk.reason, "DISK_UNAVAILABLE"),
    },
  };
}

/** Operator-only detail for an authenticated admin view or server logs. */
export function readinessDetail(report: ReadinessReport): ReadinessDetail {
  return {
    vmDriver: { kind: report.vmDriver.kind, ...(report.vmDriver.message ? { message: report.vmDriver.message } : {}) },
    home: {
      dir: report.home.dir,
      writable: report.home.writable,
      ...(report.home.message ? { message: report.home.message } : {}),
    },
    disk: {
      freeBytes: report.disk.freeBytes,
      freeMb: report.disk.freeMb,
      ...(report.disk.message ? { message: report.disk.message } : {}),
    },
  };
}

/** Public payload plus operator detail, for an authenticated admin only. */
export function adminReadinessReport(report: ReadinessReport): AdminReadinessReport {
  return { ...publicReadinessReport(report), detail: readinessDetail(report) };
}
