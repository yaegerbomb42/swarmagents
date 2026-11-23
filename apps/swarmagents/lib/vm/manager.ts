// VM manager: picks the driver (env SWARM_VM_DRIVER=docker|fake),
// caches handles, serializes reset-vs-exec to avoid races, and hibernates
// VMs that have been idle for too long.

import type {
  VmDesktopEndpoint,
  VmDriver,
  VmHandle,
  ExecOptions,
  ExecResult,
  VmState,
  VmDirEntry,
  VmFileBytes,
  VmFileStat,
  VmSnapshot,
  RealpathOptions,
} from "./types";
import { DockerVmDriver, validateSnapshotLabel } from "./docker-driver";
import { FakeVmDriver } from "./fake-driver";
import { QuotaError, OutputCap, resolveVmQuotas, type OutputBudget, type VmQuotaOptions } from "./quotas";
import { resolveIdlePolicy, type VmIdleOptions, type VmIdlePolicy } from "./idle";
import { RwLock } from "./rw-lock";
import { defaultDriverName, type VmDriverName } from "./driver-default";
import {
  VmFileError,
  assertWorkspaceContainment,
  isWorkspacePath,
  resolveWorkspacePath,
} from "./files";

export type DriverName = VmDriverName;
export { defaultDriverName } from "./driver-default";

/** Where the user-writable data lives inside the VM; du measures this path. */
export const VM_WORKSPACE_DISK_PATH = "/workspace";
/** How long a du measurement is reused before it is re-run. */
export const DISK_USAGE_TTL_MS = 60_000;
/** du -sk prints "<kilobytes>\t<path>". */
export const DISK_USAGE_CMD = ["du", "-sk", VM_WORKSPACE_DISK_PATH];

/** /workspace disk usage for one user, against the configured quota. */
export interface VmDiskUsage {
  /** Measured usage in MB (rounded up). */
  usedMb: number;
  /** Configured quota in MB; 0 means unlimited. */
  quotaMb: number;
  /** True when the quota is enabled and usedMb exceeds it. */
  overQuota: boolean;
}

interface DiskUsageCacheEntry {
  usedMb: number;
  at: number;
}

export interface VmManagerOptions {
  driver?: DriverName;
  customDriver?: VmDriver;
  /** Per-user quotas (falls back to SWARM_VM_* env vars, then defaults). */
  quotas?: Partial<VmQuotaOptions>;
  /** Idle-hibernate policy (falls back to SWARM_VM_IDLE_MIN, then defaults). */
  idle?: VmIdleOptions;
  /** Injectable clock — tests drive it with a fake timer. */
  now?: () => number;
}

/** One activity record per user: when it happened and how many events so far. */
interface ActivityRecord {
  /** Epoch ms of the last activity. */
  at: number;
  /** Monotonic counter, bumped on every touch (so equal timestamps still differ). */
  seq: number;
}

function resolveDriver(name?: string): VmDriver {
  // Development/tests may opt into the transcript driver, but a production
  // process must never silently present simulated work as a real VM run.
  const n = (name ?? defaultDriverName()) as DriverName;
  if (n === "docker") return new DockerVmDriver();
  // One shared VM table across route bundles: the fake must behave like one
  // machine no matter which route touches it (a run's Write has to be visible
  // to the files API, and the terminal has to see the run's files).
  if (n === "fake") return new FakeVmDriver({ sharedStore: true });
  if (n === "byoc") {
    // The BYOC driver pulls in the node protocol (shared with the standalone
    // runner). Load it on demand so a deploy that only runs the docker driver
    // never depends on it — and so the desktop-proxy build, which compiles a
    // narrow tree rooted at lib/, does not have to include packages/.
    const { ByocVmDriver } = require("./drivers/byoc") as {
      ByocVmDriver: new () => VmDriver;
    };
    return new ByocVmDriver();
  }
  throw new Error(`Unknown VM driver: ${n}`);
}

/** Combine caller + quota abort signals into one. */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}

/**
 * Shared singleton that routes to the configured driver.
 * - Caches handles so the same userId reuses one container.
 * - Uses a per-user reader/writer lock: ensure/exec/readFile/writeFile run
 *   concurrently under shared access, while reset/stop/snapshot take
 *   exclusive access so they cannot interleave with an exec mid-flight and
 *   block new operations until they finish.
 * - Enforces per-user quotas (concurrency, exec duration, output bytes,
 *   workspace disk) and rejects violations with a typed QuotaError.
 * - Measures /workspace usage with `du` (cached 60 s) so new runs can be
 *   refused while a user is over SWARM_VM_DISK_QUOTA_MB.
 * - Tracks the last activity per user so idle VMs can be hibernated
 *   (stopped) by the idle sweeper and transparently restarted on next use.
 */
export class VmManager {
  readonly driver: VmDriver;
  readonly quotas: VmQuotaOptions;
  /** Idle-hibernate policy (idleMinutes / idleMs / sweepIntervalMs). */
  readonly idle: VmIdlePolicy;
  private readonly now: () => number;
  private cache = new Map<string, Promise<VmHandle>>();
  private handles = new Map<string, VmHandle>();
  private locks = new Map<string, RwLock>();
  private execSlots = new Map<string, number>();
  private activity = new Map<string, ActivityRecord>();
  private activitySeq = 0;
  private diskUsageCache = new Map<string, DiskUsageCacheEntry>();

  constructor(opts?: VmManagerOptions) {
    this.driver = opts?.customDriver ?? resolveDriver(opts?.driver ?? process.env.SWARM_VM_DRIVER);
    this.quotas = resolveVmQuotas(opts?.quotas);
    this.idle = resolveIdlePolicy({ idleMinutes: opts?.idle?.idleMinutes });
    this.now = opts?.now ?? Date.now;
  }

  private lockFor(userId: string): RwLock {
    let lock = this.locks.get(userId);
    if (!lock) {
      lock = new RwLock();
      this.locks.set(userId, lock);
    }
    return lock;
  }

  private async withRead<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const lock = this.lockFor(userId);
    await lock.acquireRead();
    try {
      return await fn();
    } finally {
      lock.releaseRead();
    }
  }

  private async withWrite<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const lock = this.lockFor(userId);
    await lock.acquireWrite();
    try {
      return await fn();
    } finally {
      lock.releaseWrite();
    }
  }

  /** Reserve an exec slot; throws QuotaError when the user is over the cap. */
  private acquireExecSlot(userId: string): void {
    const limit = this.quotas.maxConcurrentExecsPerUser;
    if (limit <= 0) return;
    const current = this.execSlots.get(userId) ?? 0;
    if (current >= limit) {
      throw new QuotaError(
        "max_concurrent_execs",
        limit,
        userId,
        `User ${userId} already has ${current} exec(s) in flight (limit ${limit}).`,
      );
    }
    this.execSlots.set(userId, current + 1);
  }

  private releaseExecSlot(userId: string): void {
    const current = this.execSlots.get(userId) ?? 0;
    if (current <= 1) this.execSlots.delete(userId);
    else this.execSlots.set(userId, current - 1);
  }

  // -------------------------------------------------------------------------
  // Activity tracking
  // -------------------------------------------------------------------------

  /**
   * Record activity for a user — resets the idle timer. Called by every
   * operation that touches the VM (ensure, exec, read, write).
   */
  touch(userId: string): number {
    const at = this.now();
    this.activity.set(userId, { at, seq: ++this.activitySeq });
    return at;
  }

  /** Epoch ms of the last recorded activity, or undefined when never seen. */
  lastActivityAt(userId: string): number | undefined {
    return this.activity.get(userId)?.at;
  }

  /** Milliseconds since the last activity (0 when the user is unknown). */
  idleForMs(userId: string, now: number = this.now()): number {
    const rec = this.activity.get(userId);
    if (!rec) return 0;
    return Math.max(0, now - rec.at);
  }

  /** True when the user's VM has been idle for longer than the idle window. */
  isIdle(userId: string, now: number = this.now()): boolean {
    if (this.idle.idleMs <= 0) return false;
    const rec = this.activity.get(userId);
    if (!rec) return false;
    return now - rec.at >= this.idle.idleMs;
  }

  /**
   * Users inside the pre-hibernate window: activity has started, no exec is
   * in flight, and idle time has not yet reached the hibernate threshold.
   * The idle sweeper calls this before sweepIdle so autopilot can use the
   * same clock without delaying or preventing hibernation.
   */
  usersInPreHibernateWindow(now: number = this.now()): string[] {
    if (this.idle.idleMs <= 0) return [];
    const ids: string[] = [];
    for (const [userId, record] of this.activity) {
      const idle = now - record.at;
      if (idle <= 0 || idle >= this.idle.idleMs) continue;
      if (this.hasActiveExec(userId)) continue;
      ids.push(userId);
    }
    return ids;
  }

  /** True while an exec is in flight for the user. */
  hasActiveExec(userId: string): boolean {
    return (this.execSlots.get(userId) ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Disk usage / quota
  // -------------------------------------------------------------------------

  /** A cached du measurement younger than the TTL, if any. */
  private cachedDiskUsageMb(userId: string): number | undefined {
    const cached = this.diskUsageCache.get(userId);
    if (!cached) return undefined;
    if (this.now() - cached.at >= DISK_USAGE_TTL_MS) return undefined;
    return cached.usedMb;
  }

  /** Drop any cached du measurement for a user (called on reset). */
  clearDiskUsage(userId: string): void {
    this.diskUsageCache.delete(userId);
  }

  /**
   * Measure /workspace usage by running `du -sk /workspace` in the VM.
   * Results are cached for DISK_USAGE_TTL_MS (60 s) so runs are not slowed by
   * repeated du calls. On measurement failure (e.g. du unavailable) the usage
   * reads as 0 MB — the quota fails open rather than blocking users.
   */
  async measureDiskUsageMb(userId: string): Promise<number> {
    try {
      return await this.withRead(userId, async () => {
        const handle = await this.ensureLocked(userId);
        let stdout = "";
        await this.driver.exec(handle, DISK_USAGE_CMD, {
          onStdout: (chunk) => {
            stdout += chunk;
          },
        });
        const kb = Number.parseInt(stdout.split("\t")[0].trim(), 10);
        return Number.isFinite(kb) && kb >= 0 ? Math.ceil(kb / 1024) : 0;
      });
    } catch (error) {
      console.error(`[vm] could not measure disk usage for ${userId}:`, error);
      return 0;
    }
  }

  /**
   * Current /workspace disk usage for a user, against the configured quota
   * (SWARM_VM_DISK_QUOTA_MB). The du measurement is cached for 60 s.
   */
  async diskUsage(userId: string): Promise<VmDiskUsage> {
    const quotaMb = this.quotas.diskQuotaMb;
    let usedMb = this.cachedDiskUsageMb(userId);
    if (usedMb === undefined) {
      usedMb = await this.measureDiskUsageMb(userId);
      this.diskUsageCache.set(userId, { usedMb, at: this.now() });
    }
    return { usedMb, quotaMb, overQuota: quotaMb > 0 && usedMb > quotaMb };
  }

  /**
   * Last known /workspace usage, without measuring it. Never calls
   * ensure()/touch(), so status polling can report disk usage while a VM is
   * hibernated without waking it. Reports 0 until the first measurement.
   */
  cachedDiskUsage(userId: string): VmDiskUsage {
    const usedMb = this.diskUsageCache.get(userId)?.usedMb ?? 0;
    const quotaMb = this.quotas.diskQuotaMb;
    return { usedMb, quotaMb, overQuota: quotaMb > 0 && usedMb > quotaMb };
  }

  /**
   * Refuse to continue while the user is over their workspace disk quota.
   * `incomingBytes` is the size of a write that is about to land: the check
   * is against the measured usage plus that incoming payload, so a user can
   * not fill the remaining headroom with one large upload.
   * No-op (and no du call) when the quota is disabled (0). Throws a typed
   * QuotaError (kind "disk_quota") with an actionable message.
   */
  async assertDiskQuota(userId: string, incomingBytes = 0): Promise<VmDiskUsage> {
    if (this.quotas.diskQuotaMb <= 0) {
      return { usedMb: 0, quotaMb: 0, overQuota: false };
    }
    const usage = await this.diskUsage(userId);
    const incomingMb = incomingBytes > 0 ? Math.ceil(incomingBytes / (1024 * 1024)) : 0;
    const projectedMb = usage.usedMb + incomingMb;
    if (usage.overQuota || projectedMb > usage.quotaMb) {
      throw new QuotaError(
        "disk_quota",
        usage.quotaMb,
        userId,
        `Workspace disk usage (${usage.usedMb} MB) plus the incoming write (${incomingMb} MB) ` +
          `exceeds the quota of ${usage.quotaMb} MB. ` +
          "Free space in /workspace or reset your VM, then try again.",
      );
    }
    return usage;
  }

  // -------------------------------------------------------------------------
  // Path safety (symlink containment)
  // -------------------------------------------------------------------------

  /**
   * Resolve a /workspace path with symlinks followed *inside the VM* and
   * require the result to stay under /workspace. This closes the gap where
   * the lexical resolveWorkspacePath check could be bypassed by a symlink
   * created in the workspace (git clone, snapshot restore, shell, upload).
   *
   * Paths outside /workspace (e.g. /tmp screenshots) are returned unchanged:
   * they are internal, not caller-supplied workspace paths.
   *
   * @throws VmPathError when the path escapes the workspace.
   */
  async resolveSafePath(
    userId: string,
    path: string,
    opts?: RealpathOptions,
  ): Promise<string> {
    const handle = await this.ensure(userId);
    return this.withRead(userId, () => this.resolveSafePathLocked(handle, path, opts));
  }

  /** resolveSafePath without taking the per-user lock (callers hold it). */
  private async resolveSafePathLocked(
    handle: VmHandle,
    path: string,
    opts?: RealpathOptions,
  ): Promise<string> {
    // Non-workspace paths are internal (screenshots, control files); leave
    // them alone — /workspace containment only applies to workspace paths.
    if (!isWorkspacePath(path)) return path;

    // Lexical normalization first: reject ".." and non-absolute forms before
    // asking the VM anything.
    const lexical = resolveWorkspacePath(path);
    if (!this.driver.realpath) return lexical;
    const resolved = await this.driver.realpath(handle, lexical, opts);
    return assertWorkspaceContainment(resolved);
  }

  // -------------------------------------------------------------------------
  // Ensure / exec
  // -------------------------------------------------------------------------

  /**
   * Idempotent: ensure a VM exists for the user, caching the handle.
   * Re-ensures (and therefore restarts) a VM that was hibernated, keeping
   * the /workspace volume.
   */
  async ensure(userId: string): Promise<VmHandle> {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    return this.withRead(userId, () => this.ensureLocked(userId));
  }

  /**
   * ensure() without taking the lock — callers must already hold the
   * per-user read lock (or the write lock).
   */
  private async ensureLocked(userId: string): Promise<VmHandle> {
    const existing = this.cache.get(userId);
    if (existing) return existing;

    const p = this.driver.ensure(userId);
    this.cache.set(userId, p);
    p.then(
      (handle) => {
        this.handles.set(userId, handle);
      },
      () => {
        // The cache entry is removed by the catch below; nothing to undo here.
      },
    );
    try {
      const handle = await p;
      this.touch(userId);
      return handle;
    } catch (err) {
      this.cache.delete(userId);
      throw err;
    }
  }

  /**
   * Execute a command (argv array) inside the user's VM.
   * Enforces per-user quotas: concurrency cap, max duration, max output
   * bytes. Violations reject with a typed QuotaError.
   *
   * The whole call (ensure + driver exec) holds the per-user read lock, so
   * an idle sweep can never stop the VM while this exec is running.
   */
  async exec(userId: string, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    let acquired = false;
    try {
      this.acquireExecSlot(userId);
      acquired = true;
      this.touch(userId);
      return await this.withRead(userId, async () => {
        const handle = await this.ensureLocked(userId);
        const result = await this.quotaGuardedExec(handle, cmd, opts);
        this.touch(userId);
        return result;
      });
    } finally {
      if (acquired) this.releaseExecSlot(userId);
    }
  }

  /** Run one driver exec under the duration + output-byte quotas. */
  private async quotaGuardedExec(
    handle: VmHandle,
    cmd: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const agent = opts?.quotaProfile === "agent";
    const maxExecDurationMs = agent
      ? this.quotas.agentMaxExecDurationMs
      : this.quotas.maxExecDurationMs;
    const maxOutputBytes = agent
      ? this.quotas.agentMaxOutputBytes
      : this.quotas.maxOutputBytes;

    // One shared budget for both streams: maxOutputBytes is a total cap, so
    // stdout and stderr together must not exceed it.
    const budget: OutputBudget = { bytes: 0, truncated: false };
    const stdoutCap = new OutputCap(maxOutputBytes, opts?.onStdout, budget);
    const stderrCap = new OutputCap(maxOutputBytes, opts?.onStderr, budget);
    const wrapped: ExecOptions = {
      ...opts,
      onStdout: (chunk) => stdoutCap.write(chunk),
      onStderr: (chunk) => stderrCap.write(chunk),
    };

    let clearTimer: (() => void) | undefined;
    let durationRace: Promise<never> | undefined;
    if (maxExecDurationMs > 0) {
      const quotaAbort = new AbortController();
      let fireQuotaTimeout: () => void = () => {};
      durationRace = new Promise<never>((_, reject) => {
        fireQuotaTimeout = () =>
          reject(
            new QuotaError(
              "max_exec_duration",
              maxExecDurationMs,
              handle.userId,
              `Exec exceeded max duration of ${maxExecDurationMs}ms.`,
            ),
          );
      });
      const timer = setTimeout(() => {
        quotaAbort.abort();
        fireQuotaTimeout();
      }, maxExecDurationMs);
      clearTimer = () => {
        clearTimeout(timer);
        quotaAbort.abort();
      };
      wrapped.signal = combineSignals([opts?.signal, quotaAbort.signal]);
    }

    try {
      const driverP = this.driver.exec(handle, cmd, wrapped);
      const result = await (durationRace ? Promise.race([driverP, durationRace]) : driverP);
      return stdoutCap.didTruncate || stderrCap.didTruncate ? { ...result, truncated: true } : result;
    } finally {
      clearTimer?.();
    }
  }

  async writeFile(userId: string, path: string, content: string): Promise<void> {
    // Every write path checks the disk quota with the incoming size so an
    // over-quota user cannot keep writing through the file APIs.
    await this.assertDiskQuota(userId, Buffer.byteLength(content, "utf8"));
    this.touch(userId);
    return this.withRead(userId, async () => {
      const handle = await this.ensureLocked(userId);
      const safePath = await this.resolveSafePathLocked(handle, path, { allowMissing: true });
      this.touch(userId);
      await this.driver.writeFile(handle, safePath, content);
    });
  }

  async readFile(userId: string, path: string): Promise<string> {
    this.touch(userId);
    return this.withRead(userId, async () => {
      const handle = await this.ensureLocked(userId);
      const safePath = await this.resolveSafePathLocked(handle, path);
      this.touch(userId);
      return this.driver.readFile(handle, safePath);
    });
  }

  /** Metadata for one path inside the user's VM. */
  async stat(userId: string, path: string): Promise<VmFileStat> {
    const handle = await this.ensure(userId);
    return this.withRead(userId, async () => {
      if (!this.driver.stat) {
        throw new VmFileError("unsupported", "This VM driver cannot stat files.");
      }
      const safePath = await this.resolveSafePathLocked(handle, path);
      return this.driver.stat(handle, safePath);
    });
  }

  /** One level of a directory inside the user's VM. */
  async listDir(userId: string, path: string): Promise<VmDirEntry[]> {
    const handle = await this.ensure(userId);
    return this.withRead(userId, async () => {
      if (!this.driver.listDir) {
        throw new VmFileError("unsupported", "This VM driver cannot list directories.");
      }
      const safePath = await this.resolveSafePathLocked(handle, path);
      return this.driver.listDir(handle, safePath);
    });
  }

  /** Raw bytes of a file inside the user's VM, capped at maxBytes. */
  async readFileBytes(userId: string, path: string, maxBytes: number): Promise<VmFileBytes> {
    const handle = await this.ensure(userId);
    return this.withRead(userId, async () => {
      if (!this.driver.readFileBytes) {
        throw new VmFileError("unsupported", "This VM driver cannot read raw file bytes.");
      }
      const safePath = await this.resolveSafePathLocked(handle, path);
      return this.driver.readFileBytes(handle, safePath, maxBytes);
    });
  }

  /**
   * Read-only status for the user's VM.
   *
   * This is called by the 30 s status poll, so it must never ensure() or
   * touch(): waking a hibernated VM from a poll would reset the idle timer
   * and the VM would never hibernate. A VM this process has not ensured
   * reads as "missing" (the UI maps that to hibernated), which is honest —
   * polling cannot know about a container without inspecting it.
   */
  async status(userId: string): Promise<VmState> {
    const known = this.handles.get(userId);
    if (known) return this.driver.status(known);
    // An ensure is in flight but has not produced a handle yet.
    if (this.cache.has(userId)) return { status: "creating" };
    return { status: "missing" };
  }

  /** Stop the VM (keeps the volume for later). The next exec re-ensures it. */
  async stop(userId: string): Promise<void> {
    this.touch(userId);
    const handle = await this.ensure(userId);
    await this.withWrite(userId, async () => {
      await this.driver.stop(handle);
      // Drop the cached handle promise so the next ensure() re-ensures (and
      // restarts) the VM. The volume is kept by the driver.
      this.cache.delete(userId);
    });
  }

  /** Destroy the VM and wipe its volume. Clears the handle cache. */
  async reset(userId: string): Promise<void> {
    const handle = await this.ensure(userId);
    await this.withWrite(userId, async () => {
      this.cache.delete(userId);
      this.handles.delete(userId);
      this.activity.delete(userId);
      this.diskUsageCache.delete(userId);
      await this.driver.reset(handle);
    });
  }

  /** Checkpoint the VM under a validated, per-user label. */
  async snapshot(userId: string, label: string): Promise<VmSnapshot> {
    validateSnapshotLabel(label);
    const handle = await this.ensure(userId);
    if (!this.driver.snapshot) {
      throw new Error("Current driver does not support snapshots");
    }
    return this.withWrite(userId, async () => {
      const snapshot = await this.driver.snapshot!(handle, label);
      this.touch(userId);
      return snapshot;
    });
  }

  /**
   * F1 auto-checkpoint: the same snapshot as {@link snapshot} (same driver
   * call, same image + workspace-volume backup), but taken under the *read*
   * lock instead of the write lock.
   *
   * Why: the approval gate runs *inside* the agent's long-lived claude exec,
   * which holds the read lock for the whole invocation. A write-lock
   * snapshot from the gate would wait for that exec to drain while the exec
   * waits for the gate's answer — a deadlock, not a slow snapshot. The
   * read lock still excludes concurrent writers (reset/stop/snapshot), so
   * no destructive operation can interleave with the checkpoint.
   *
   * Safety: at gate time the CLI is quiesced inside the hook and the flagged
   * tool has not executed, so the snapshot captures the true pre-mutation
   * state. Residual risk is a host-side bridge write (or an earlier
   * backgrounded command) landing mid-copy — a torn single file at worst —
   * and the driver already drops a half-created snapshot on failure. Use
   * only for gate-time checkpoints, never as a general snapshot path.
   */
  async snapshotDuringRun(userId: string, label: string): Promise<VmSnapshot> {
    validateSnapshotLabel(label);
    const handle = await this.ensure(userId);
    if (!this.driver.snapshot) {
      throw new Error("Current driver does not support snapshots");
    }
    return this.withRead(userId, async () => {
      const snapshot = await this.driver.snapshot!(handle, label);
      this.touch(userId);
      return snapshot;
    });
  }

  /** List the user's checkpoints, newest first. */
  async listSnapshots(userId: string): Promise<VmSnapshot[]> {
    const handle = await this.ensure(userId);
    if (!this.driver.listSnapshots) {
      throw new Error("Current driver does not support snapshots");
    }
    return this.withRead(userId, () => this.driver.listSnapshots!(handle));
  }

  /**
   * Boot the snapshot image and keep the current workspace volume.
   * Warm snapshots use this so a matching dependency cache is selected at
   * run start without rolling the user's files back.
   */
  async bootFromImage(userId: string, label: string): Promise<void> {
    validateSnapshotLabel(label);
    const handle = await this.ensure(userId);
    if (!this.driver.bootFromImage) {
      throw new Error("Current driver does not support image boot");
    }
    await this.withWrite(userId, async () => {
      await this.driver.bootFromImage!(handle, label);
      this.touch(userId);
    });
  }

  /** Delete a checkpoint (image + workspace backup). The next operation re-ensures the VM. */
  async deleteSnapshot(userId: string, label: string): Promise<void> {
    validateSnapshotLabel(label);
    const handle = await this.ensure(userId);
    if (!this.driver.deleteSnapshot) {
      throw new Error("Current driver does not support snapshots");
    }
    // Deleting is a mutation of the checkpoint set, not of the live VM, but
    // it still takes the write lock so it cannot interleave with a snapshot
    // or restore of the same label.
    await this.withWrite(userId, async () => {
      await this.driver.deleteSnapshot!(handle, label);
      this.touch(userId);
    });
  }

  /** Roll the VM back to a checkpoint. The next operation re-ensures it. */
  async restore(userId: string, label: string): Promise<void> {
    validateSnapshotLabel(label);
    // A restore can bring back a workspace that is larger than the quota;
    // refuse before melting the host disk.
    await this.assertDiskQuota(userId);
    if (!this.driver.restore) {
      throw new Error("Current driver does not support snapshots");
    }
    await this.withWrite(userId, async () => {
      try {
        // ensure + the driver's ownership inspect / remove / run sequence all
        // run under the per-user write lock, so no exec can interleave with
        // the rollback.
        const handle = await this.ensureLocked(userId);
        await this.driver.restore!(handle, label);
        this.touch(userId);
      } finally {
        // Restore recreates the container. If it failed after `docker rm`,
        // the old handle is stale too, so always drop the cache — the next
        // operation must re-ensure instead of reusing a handle whose
        // container no longer exists.
        this.cache.delete(userId);
        this.handles.delete(userId);
      }
    });
  }

  /**
   * The desktop viewer endpoint for the user's VM, when the driver is in
   * desktop mode (null otherwise — the caller should use the headless
   * browser path instead).
   */
  async desktopEndpoint(userId: string): Promise<VmDesktopEndpoint | null> {
    if (!this.driver.desktopEndpoint) return null;
    const handle = await this.ensure(userId);
    return this.withRead(userId, () => this.driver.desktopEndpoint!(handle));
  }

  /**
   * The VM image this manager's driver creates containers from (the run's
   * VM config), or undefined when the driver has no container image
   * (fake/transcript drivers). The RunReporter records it in the run
   * report so the proof bundle can assert the actual image.
   */
  vmImage(): string | undefined {
    return this.driver.image ?? undefined;
  }

  /**
   * The user's VM container IP on its docker network, for the preview proxy
   * (null when the driver has no container network or the VM is not
   * running). Same transport as desktopEndpoint's `host` — the app server
   * dials the container IP directly; the port is never published to the
   * host. Callers must first confirm the requested port is in the detected
   * listening set (lib/preview/ports) so an arbitrary port is never dialed.
   */
  async vmHost(userId: string): Promise<string | null> {
    if (!this.driver.containerIp) return null;
    const handle = await this.ensure(userId);
    return this.withRead(userId, () => this.driver.containerIp!(handle));
  }

  // -------------------------------------------------------------------------
  // Idle hibernation
  // -------------------------------------------------------------------------

  /**
   * Stop every VM that has been idle for longer than the idle window and
   * return the ids of the users that were hibernated.
   *
   * A VM with an exec in flight is never stopped. The stop happens under
   * the per-user write lock and the activity record is re-checked there, so
   * a VM that became busy while the sweep was waiting for the lock stays up.
   *
   * The driver's stop() keeps the /workspace volume; the cached handle
   * promise is dropped so the next ensure() re-ensures (restarts) the VM.
   */
  async sweepIdle(now: number = this.now()): Promise<string[]> {
    if (this.idle.idleMs <= 0) return [];

    const stopped: string[] = [];
    for (const [userId, record] of [...this.activity]) {
      if (now - record.at < this.idle.idleMs) continue;
      if (this.hasActiveExec(userId)) continue;
      const handle = this.handles.get(userId);
      if (!handle) continue;

      let hibernated = false;
      try {
        hibernated = await this.withWrite(userId, async () => {
          // Re-check under the exclusive lock: the user may have become
          // active (or started an exec) while we waited for the lock.
          const current = this.activity.get(userId);
          if (!current || current.seq !== record.seq) return false;
          if (this.hasActiveExec(userId)) return false;
          const live = this.handles.get(userId);
          if (!live) return false;
          await this.driver.stop(live);
          // Drop the cached handle promise so the next ensure() re-ensures
          // (and restarts) the VM. The volume is kept by the driver.
          this.cache.delete(userId);
          return true;
        });
      } catch (err) {
        console.error(`[vm] failed to hibernate idle VM for ${userId}:`, err);
        continue;
      }

      if (hibernated) {
        // The VM is hibernated: forget its activity until it is used again.
        this.activity.delete(userId);
        stopped.push(userId);
      }
    }
    return stopped;
  }
}

/** Global shared instance for the application. */
export const vmManager = new VmManager();

const g = globalThis as typeof globalThis & { __swarmVmManager?: VmManager };

/**
 * Process-wide VM manager used by route handlers (file API, runtime control
 * plane). Same instance as the exported `vmManager` unless a test swaps it.
 */
export function getVmManager(): VmManager {
  return g.__swarmVmManager ?? (g.__swarmVmManager = vmManager);
}

/** Test hook: swap the singleton for a manager backed by a fake driver. */
export function setVmManagerForTesting(manager: VmManager | null): void {
  g.__swarmVmManager = manager ?? undefined;
}

/** Minimal exec interface matching lib/harness's VmExec (for the harness adapter). */
export interface BoundVmExec {
  exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult>;
}

/**
 * Bind a VmManager to a userId, yielding `{ exec(cmd: string[], opts) }` —
 * the same shape lib/harness's VmExec expects, so a VmHandle-bound adapter is trivial.
 */
export function bindExec(manager: VmManager, userId: string): BoundVmExec {
  return {
    exec(cmd, opts) {
      // Claude Code is a long-lived, stream-json-producing invocation, not a
      // short terminal command. Keep explicit agent abuse limits without
      // applying the much smaller terminal duration/output defaults to it.
      return manager.exec(userId, cmd, { ...opts, quotaProfile: "agent" });
    },
  };
}
