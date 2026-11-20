// Test-drive sweeper: periodically rolls back "awaiting-decision" drives
// whose owners never came back to choose keep or roll back.
//
// The on-demand sweep in the test-drive route (GET reads + POST sweep +
// next drive start) only runs while the user is looking at the library.
// A drive abandoned by a user who never returns would pin the VM's
// post-drive state forever, so this sweeper runs on a background timer and
// sweeps every account's stale drives without a manual trigger.
//
// It mirrors lib/vm/idle-sweeper.ts: the sweeper owns the timer only —
// staleness and roll-back live in sweepAbandonedDrives
// (lib/library/test-drive.ts) and the caller owns the VM restore. The
// timer functions are injectable so tests can drive the sweeper with a
// fake clock instead of waiting for wall-clock time.
//
// Wiring: getRuntimeManager() (lib/runtime/manager.ts) starts one next to
// the VM idle sweeper, so the timer lives as long as the server process
// and is started exactly once per process. The restore goes through the
// runtime's VmManager and users with a running or queued run are skipped:
// restoring a snapshot mid-run would clobber the run's VM state, so a
// busy user's drives wait for the next tick.

import {
  DEFAULT_TEST_DRIVE_ABANDONED_MAX_AGE_MS,
  readTestDrives,
  sweepAbandonedDrives,
  type SweepAbandonedDrivesResult,
  type TestDriveRecord,
} from "./test-drive";
import type { LibraryStoreOptions } from "./user-store";
import { parseSweepIntervalSeconds } from "../vm/idle";

/** Handle returned by the injected interval scheduler. */
export type TestDriveSweepTimerHandle = unknown;

/** Injectable setInterval (tests pass a fake). */
export type TestDriveSetIntervalFn = (fn: () => void, ms: number) => TestDriveSweepTimerHandle;

/** Injectable clearInterval (tests pass a fake). */
export type TestDriveClearIntervalFn = (handle: TestDriveSweepTimerHandle) => void;

/** Env: how often the test-drive sweeper runs, in seconds. */
export const TEST_DRIVE_SWEEP_INTERVAL_ENV = "SWARM_TEST_DRIVE_SWEEP_INTERVAL_SEC";

/** Default cadence of the test-drive sweeper: once an hour. */
export const DEFAULT_TEST_DRIVE_SWEEP_INTERVAL_SEC = 60 * 60;

/** Default cadence of the test-drive sweeper, in ms. */
export const DEFAULT_TEST_DRIVE_SWEEP_INTERVAL_MS =
  DEFAULT_TEST_DRIVE_SWEEP_INTERVAL_SEC * 1000;

/**
 * Resolve the sweep cadence: explicit options over the
 * SWARM_TEST_DRIVE_SWEEP_INTERVAL_SEC env var over the hourly default.
 */
export function resolveTestDriveSweepIntervalMs(opts?: { intervalMs?: number }): number {
  if (opts?.intervalMs !== undefined) return opts.intervalMs;
  return parseSweepIntervalSeconds(
    process.env[TEST_DRIVE_SWEEP_INTERVAL_ENV],
    DEFAULT_TEST_DRIVE_SWEEP_INTERVAL_SEC,
  ) * 1000;
}

export interface TestDriveSweeperOptions extends LibraryStoreOptions {
  /** Performs the VM roll-back for one drive (the caller owns the manager). */
  restore: (drive: TestDriveRecord) => Promise<void>;
  /** Sweep cadence in ms (defaults to the env var / hourly default). */
  intervalMs?: number;
  /** Staleness threshold in ms (default DEFAULT_TEST_DRIVE_ABANDONED_MAX_AGE_MS). */
  maxAgeMs?: number;
  /** Clock override for tests. */
  now?: number;
  /** Injectable interval scheduler. */
  setIntervalFn?: TestDriveSetIntervalFn;
  /** Injectable interval clearer. */
  clearIntervalFn?: TestDriveClearIntervalFn;
  /**
   * True while a user has a run in flight. A busy user's drives are left
   * for the next tick — restoring a snapshot mid-run would clobber it.
   */
  isUserBusy?: (userId: string) => boolean;
  /** Called with the per-user sweep results of each pass. */
  onSwept?: (results: Array<{ userId: string } & SweepAbandonedDrivesResult>) => void;
  /** Called when a sweep throws. */
  onError?: (err: unknown) => void;
}

const defaultSetInterval: TestDriveSetIntervalFn = (fn, ms) => setInterval(fn, ms);
const defaultClearInterval: TestDriveClearIntervalFn = (handle) =>
  clearInterval(handle as NodeJS.Timeout);

export class TestDriveSweeper {
  readonly intervalMs: number;
  private readonly restore: (drive: TestDriveRecord) => Promise<void>;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: TestDriveSetIntervalFn;
  private readonly clearIntervalFn: TestDriveClearIntervalFn;
  private readonly isUserBusy?: (userId: string) => boolean;
  private readonly onSwept?: TestDriveSweeperOptions["onSwept"];
  private readonly onError?: (err: unknown) => void;
  private readonly storeOptions: LibraryStoreOptions;
  private timer: TestDriveSweepTimerHandle | null = null;
  private sweeping = false;
  private queued = false;

  constructor(opts: TestDriveSweeperOptions) {
    this.restore = opts.restore;
    this.intervalMs = resolveTestDriveSweepIntervalMs(opts);
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_TEST_DRIVE_ABANDONED_MAX_AGE_MS;
    this.now = opts.now !== undefined ? () => opts.now as number : Date.now;
    this.setIntervalFn = opts.setIntervalFn ?? defaultSetInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? defaultClearInterval;
    this.isUserBusy = opts.isUserBusy;
    this.onSwept = opts.onSwept;
    this.onError = opts.onError;
    // LibraryStoreOptions is the data-dir override (dataDir); keep only
    // that — the rest of the options are sweeper config, not store config.
    this.storeOptions = opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {};
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Start the sweep timer. Calling it twice is a no-op. */
  start(): void {
    if (this.timer !== null) return;
    if (this.intervalMs <= 0) return; // sweeper disabled
    this.timer = this.setIntervalFn(() => {
      const running = this.sweep();
      // sweep() handles its own errors; this only guards the timer callback.
      running.catch(() => {});
      return running;
    }, this.intervalMs);
    // Never keep the process alive just for the sweeper.
    const handle = this.timer as { unref?: () => void } | null;
    handle?.unref?.();
  }

  /** Stop the sweep timer. Calling it twice is a no-op. */
  stop(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  /**
   * Run one sweep now. Returns the per-user results. Overlapping sweeps
   * are collapsed into a single follow-up sweep, so a slow sweep never
   * piles up timers (and never misses an abandonment window).
   */
  async sweep(): Promise<Array<{ userId: string } & SweepAbandonedDrivesResult>> {
    if (this.sweeping) {
      this.queued = true;
      return [];
    }
    this.sweeping = true;
    try {
      let results: Array<{ userId: string } & SweepAbandonedDrivesResult> = [];
      do {
        this.queued = false;
        results = await this.runSweep();
      } while (this.queued);
      return results;
    } finally {
      this.sweeping = false;
    }
  }

  /** One sweep pass over every account with test-drive records. */
  private async runSweep(): Promise<Array<{ userId: string } & SweepAbandonedDrivesResult>> {
    try {
      const now = this.now();
      const userIds = [...new Set(readTestDrives(this.storeOptions).map((d) => d.userId))];
      const results: Array<{ userId: string } & SweepAbandonedDrivesResult> = [];
      for (const userId of userIds) {
        if (this.isUserBusy?.(userId)) continue;
        const result = await sweepAbandonedDrives(userId, this.restore, {
          ...this.storeOptions,
          maxAgeMs: this.maxAgeMs,
          now,
        });
        results.push({ userId, ...result });
      }
      if (results.some((r) => r.swept.length > 0 || r.failed.length > 0)) {
        this.onSwept?.(results);
      }
      return results;
    } catch (err) {
      this.onError?.(err);
      console.error("[test-drive] background sweep failed:", err);
      return [];
    }
  }
}

/** One sweeper per process, so repeated wiring does not stack timers. */
let singleton: TestDriveSweeper | null = null;

/** Start (or return) the process-wide test-drive sweeper. */
export function startTestDriveSweeper(
  restore: (drive: TestDriveRecord) => Promise<void>,
  opts?: Omit<TestDriveSweeperOptions, "restore">,
): TestDriveSweeper {
  if (singleton) {
    singleton.start();
    return singleton;
  }
  const sweeper = new TestDriveSweeper({ ...opts, restore });
  singleton = sweeper;
  sweeper.start();
  return sweeper;
}

/** Stop the process-wide test-drive sweeper (if any). */
export function stopTestDriveSweeper(): void {
  if (!singleton) return;
  singleton.stop();
  singleton = null;
}
