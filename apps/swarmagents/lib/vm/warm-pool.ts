/**
 * Bounded warm pool of pre-booted VMs.
 *
 * Cold-starting Docker + Xvnc + XFCE + Chromium takes seconds per fresh VM.
 * A warm pool keeps up to `size` pre-booted, unassigned VMs so a new user's
 * first ensure() hands them a running container instead of cold-booting one.
 *
 * The pool is driver-agnostic: any driver may implement the WarmPoolDriver
 * capability (prewarm + adoptWarm). Drivers without it simply never pool —
 * the manager falls back to the cold ensure path. The pool is off by
 * default (size 0) and is enabled with SWARM_VM_WARM_POOL_SIZE.
 *
 * Isolation contract (adoptWarm): the user never sees warm-phase state.
 * The adopted VM must get a fresh /workspace volume and a fresh VNC
 * password before its first exec — a warm container is treated as if it
 * were a brand-new machine.
 */

import type { VmDriver, VmHandle } from "./types";

export const SWARM_VM_WARM_POOL_SIZE_ENV = "SWARM_VM_WARM_POOL_SIZE";

/** Capability a driver implements to participate in the warm pool. */
export interface WarmPoolDriver extends VmDriver {
  /**
   * Boot one unassigned VM for the pool. The handle's userId is a driver-
   * internal warm identity, never a real user; adoptWarm reassigns it.
   */
  prewarm(): Promise<VmHandle>;
  /**
   * Hand a prewarmed VM to a real user: fresh /workspace volume and a fresh
   * VNC password before the first exec. Throws when the warm VM is gone or
   * the user already has one — the manager then cold-ensures instead.
   */
  adoptWarm(warm: VmHandle, userId: string): Promise<VmHandle>;
}

/**
 * Pool size from SWARM_VM_WARM_POOL_SIZE (default 0 in dev and prod).
 * Missing or invalid values disable the pool rather than throwing: a bad
 * env var must never take down VM boot.
 */
export function resolveWarmPoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[SWARM_VM_WARM_POOL_SIZE_ENV] ?? "").trim();
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export class WarmPool {
  /** The capability-aware driver, or null when the driver cannot pool. */
  private readonly driver: WarmPoolDriver | null;
  private readonly ready: VmHandle[] = [];
  private pending = 0;

  constructor(driver: VmDriver, readonly size: number) {
    const candidate = driver as Partial<WarmPoolDriver>;
    this.driver =
      typeof candidate.prewarm === "function" && typeof candidate.adoptWarm === "function"
        ? (candidate as WarmPoolDriver)
        : null;
  }

  /** True when the driver supports prewarm/adoptWarm. */
  get available(): boolean {
    return this.driver !== null;
  }

  /** Ready + in-flight prewarms; the bound the fill loop enforces. */
  depth(): number {
    return this.ready.length + this.pending;
  }

  /** Pop a pre-booted VM, or undefined when the pool is empty. */
  claim(): VmHandle | undefined {
    return this.ready.pop();
  }

  /**
   * Hand a claimed warm VM to a real user via the driver's isolation
   * contract (fresh workspace volume + fresh VNC password).
   */
  async adopt(warm: VmHandle, userId: string): Promise<VmHandle> {
    if (!this.driver) throw new Error("warm pool is unavailable for this driver");
    return this.driver.adoptWarm(warm, userId);
  }

  /**
   * Top the pool back up to its bound, asynchronously. Prewarm failures are
   * swallowed: the pool just stays smaller and the next claim cold-ensures.
   */
  fill(): void {
    if (!this.driver) return;
    while (this.depth() < this.size) {
      this.pending++;
      this.driver.prewarm().then(
        (handle) => {
          // Retire the slot before publishing the handle: a resolved
          // prewarm must count exactly once (pending XOR ready), or depth
          // transiently double-counts and a concurrent fill over-launches.
          this.pending--;
          this.ready.push(handle);
        },
        () => {
          // Best-effort: keep the pool optional, never throw at boot.
          this.pending--;
        },
      );
    }
  }
}
