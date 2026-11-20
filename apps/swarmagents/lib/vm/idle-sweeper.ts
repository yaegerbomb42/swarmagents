// Idle sweeper: periodically asks the VmManager to hibernate VMs that have
// been idle for longer than the configured idle window (SWARM_VM_IDLE_MIN).
//
// The sweeper owns the timer only — all decisions (who is idle, is an exec
// running, is it safe to stop) live in VmManager. The timer functions are
// injectable so tests can drive the sweeper with a fake clock instead of
// waiting for wall-clock time.

import type { VmManager } from "./manager";

/** Handle returned by the injected interval scheduler. */
export type SweepTimerHandle = unknown;

/** Injectable setInterval (tests pass a fake). */
export type SetIntervalFn = (fn: () => void, ms: number) => SweepTimerHandle;

/** Injectable clearInterval (tests pass a fake). */
export type ClearIntervalFn = (handle: SweepTimerHandle) => void;

export interface IdleSweeperOptions {
  /** Manager that owns the VMs to sweep. */
  manager: VmManager;
  /** Sweep cadence in ms (defaults to the manager's idle policy). */
  intervalMs?: number;
  /** Injectable clock — tests drive it with a fake timer. */
  now?: () => number;
  /** Injectable interval scheduler. */
  setIntervalFn?: SetIntervalFn;
  /** Injectable interval clearer. */
  clearIntervalFn?: ClearIntervalFn;
  /** Called with the ids of the VMs that were hibernated. */
  onHibernated?: (userIds: string[]) => void;
  /**
   * Called with users still inside the pre-hibernate idle window, before
   * sweepIdle. Must not throw into the sweep; failures are logged.
   */
  onIdleWindow?: (userIds: string[]) => void | Promise<void>;
  /** Called when a sweep throws. */
  onError?: (err: unknown) => void;
}

const defaultSetInterval: SetIntervalFn = (fn, ms) => setInterval(fn, ms);
const defaultClearInterval: ClearIntervalFn = (handle) => clearInterval(handle as NodeJS.Timeout);

export class IdleSweeper {
  readonly manager: VmManager;
  readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: SetIntervalFn;
  private readonly clearIntervalFn: ClearIntervalFn;
  private readonly onHibernated?: (userIds: string[]) => void;
  private readonly onIdleWindow?: (userIds: string[]) => void | Promise<void>;
  private readonly onError?: (err: unknown) => void;
  private timer: SweepTimerHandle | null = null;
  private sweeping = false;
  private queued = false;

  constructor(opts: IdleSweeperOptions) {
    this.manager = opts.manager;
    this.intervalMs = opts.intervalMs ?? opts.manager.idle.sweepIntervalMs;
    this.now = opts.now ?? Date.now;
    this.setIntervalFn = opts.setIntervalFn ?? defaultSetInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? defaultClearInterval;
    this.onHibernated = opts.onHibernated;
    this.onIdleWindow = opts.onIdleWindow;
    this.onError = opts.onError;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Start the sweep timer. Calling it twice is a no-op. */
  start(): void {
    if (this.timer !== null) return;
    if (this.intervalMs <= 0) return; // hibernate disabled
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
   * Run one sweep now. Returns the ids of the users that were hibernated.
   * Overlapping sweeps are collapsed into a single follow-up sweep, so a
   * slow sweep never piles up timers (and never misses an idle window).
   */
  async sweep(): Promise<string[]> {
    if (this.sweeping) {
      this.queued = true;
      return [];
    }
    this.sweeping = true;
    try {
      let hibernated: string[] = [];
      do {
        this.queued = false;
        hibernated = await this.runSweep();
      } while (this.queued);
      return hibernated;
    } finally {
      this.sweeping = false;
    }
  }

  /** One sweep pass over the manager's VMs. */
  private async runSweep(): Promise<string[]> {
    try {
      const now = this.now();
      if (this.onIdleWindow) {
        try {
          await this.onIdleWindow(this.manager.usersInPreHibernateWindow(now));
        } catch (err) {
          this.onError?.(err);
          console.error("[vm] idle-window hook failed:", err);
        }
      }
      const hibernated = await this.manager.sweepIdle(now);
      if (hibernated.length > 0) this.onHibernated?.(hibernated);
      return hibernated;
    } catch (err) {
      this.onError?.(err);
      console.error("[vm] idle sweep failed:", err);
      return [];
    }
  }
}

/** One sweeper per manager, so repeated wiring does not stack timers. */
const sweepers = new WeakMap<VmManager, IdleSweeper>();

/** Start (or return) the idle sweeper for a manager. */
export function startVmIdleSweeper(manager: VmManager, opts?: Omit<IdleSweeperOptions, "manager">): IdleSweeper {
  const existing = sweepers.get(manager);
  if (existing) {
    existing.start();
    return existing;
  }
  const sweeper = new IdleSweeper({ ...opts, manager });
  sweepers.set(manager, sweeper);
  sweeper.start();
  return sweeper;
}

/** Stop the idle sweeper of a manager (if any). */
export function stopVmIdleSweeper(manager: VmManager): void {
  const existing = sweepers.get(manager);
  if (!existing) return;
  existing.stop();
  sweepers.delete(manager);
}
