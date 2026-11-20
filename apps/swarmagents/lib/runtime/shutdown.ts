/**
 * Graceful shutdown: on SIGTERM/SIGINT (e.g. a deploy), cancel in-flight
 * runs with reason "shutdown", flush run-log writers, then exit within a
 * configurable timeout. A hung flush cannot stall the exit — a force-exit
 * timer fires at the deadline — and a second signal kills the process
 * immediately (the listeners are registered with `process.once`, so the
 * second signal falls through to the default disposition).
 *
 * Registration is guarded by a globalThis flag so Next.js module reloads
 * (several bundles loading this file) register the handlers exactly once.
 * `handleShutdown` is exported so unit tests can call it directly with
 * fakes instead of sending real signals.
 */

import { getRuntimeManager } from "./manager";
import { telemetryBus } from "../telemetry/index";

export type ShutdownSignal = "SIGTERM" | "SIGINT";

/** Default budget for cancelling runs and flushing logs before exiting. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownDeps {
  /** Cancel every active run; defaults to the process-wide RuntimeManager. */
  cancelActiveRuns?: (reason: "shutdown") => string[];
  /** Flush run-log writers; defaults to the process-wide TelemetryBus. */
  flush?: () => Promise<void> | void;
  /** Exit the process; defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Force-exit if cancelling/flushing takes longer than this. */
  timeoutMs?: number;
}

/**
 * Run one graceful shutdown: cancel active runs, flush run logs, exit 0.
 * Always exits (code 0) within `timeoutMs`, even if cancelling or flushing
 * throws or hangs. Safe to call directly in tests with fakes.
 */
export async function handleShutdown(
  signal: ShutdownSignal,
  deps: ShutdownDeps = {},
): Promise<void> {
  const timeoutMs = Math.max(0, deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let exited = false;
  const doExit = (code: number): void => {
    if (!exited) {
      exited = true;
      exit(code);
    }
  };

  // Force-exit timer: deliberately kept referenced so it still fires if
  // flushing hangs. Cleared once the graceful path finishes.
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      doExit(0);
      resolve();
    }, timeoutMs);
  });

  try {
    const cancel = deps.cancelActiveRuns ?? (() => getRuntimeManager().cancelAll("shutdown"));
    try {
      cancel("shutdown");
    } catch (err) {
      console.error(`[shutdown] failed to cancel runs on ${signal}:`, err);
    }
    const flush = deps.flush ?? (() => telemetryBus.flush());
    await Promise.race([Promise.resolve().then(() => flush()), timedOut]);
  } catch (err) {
    console.error(`[shutdown] failed to flush run logs on ${signal}:`, err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  doExit(0);
}

const g = globalThis as typeof globalThis & { __swarmShutdownRegistered?: boolean };

/**
 * Listen for SIGTERM and SIGINT exactly once per process. Returns true on
 * the first call, false when the handlers are already registered.
 */
export function registerShutdownHandler(deps: ShutdownDeps = {}): boolean {
  if (g.__swarmShutdownRegistered) return false;
  g.__swarmShutdownRegistered = true;
  const onSignal = (signal: ShutdownSignal): void => {
    void handleShutdown(signal, deps);
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  return true;
}
