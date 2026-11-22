/**
 * Cross-process advisory file lock (lockfile created with O_EXCL).
 *
 * The user store (lib/users.ts) serializes its read-modify-write cycles
 * with an in-process promise lock, which cannot stop two app processes
 * sharing one data directory from loading the same snapshot and clobbering
 * each other's writes. This module is the second layer: an exclusive
 * lockfile next to the data file, created atomically with `openSync(...,
 * "wx")` (O_CREAT | O_EXCL), so exactly one process on the host holds it
 * at a time. See DEPLOY.md ("User store concurrency") for the FIX-45
 * decision record and its limits.
 *
 * Semantics:
 *  - The lock file holds an ownership token (`<pid>:<random>:<ts>`).
 *    Release only unlinks the file when the token still matches, so a
 *    holder whose lock was broken as stale never deletes the next
 *    holder's lock.
 *  - A lock file untouched for longer than `staleMs` is treated as
 *    abandoned (holder crashed) and broken — but only after a re-stat
 *    confirms it is still the same file (inode + mtime) that was judged
 *    stale, so a fresh lock created in the meantime is never removed.
 *  - Waiting is bounded by `timeoutMs`; on expiry a
 *    {@link FileLockTimeoutError} is thrown instead of waiting forever.
 *    Critical sections guarded by this lock are milliseconds long, so a
 *    timeout means a wedged holder, and failing loudly beats silently
 *    racing another writer.
 *
 * Limits: same-host, local-filesystem only. O_EXCL creation is atomic on
 * local filesystems; it is not a distributed lock and must not be used
 * over NFS or across hosts. The lock is advisory — only writers that go
 * through this module are serialized.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface FileLockOptions {
  /** Total time to wait for the lock before giving up. Default 15 s. */
  timeoutMs?: number;
  /**
   * A lock file whose mtime is older than this is treated as abandoned
   * (its holder crashed) and broken. Default 10 s — orders of magnitude
   * longer than the critical sections this lock guards.
   */
  staleMs?: number;
  /** Base poll interval while waiting (jittered up to 2×). Default 25 ms. */
  retryMs?: number;
}

/** Thrown when the lock cannot be acquired within `timeoutMs`. */
export class FileLockTimeoutError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for file lock ${lockPath}`);
    this.name = "FileLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export function isFileLockTimeoutError(err: unknown): err is FileLockTimeoutError {
  return err instanceof FileLockTimeoutError;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 10_000;
const DEFAULT_RETRY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create the lock file exclusively; false when another holder has it. */
function tryCreateLock(lockPath: string, token: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, token, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Break the lock at `lockPath` when it looks abandoned. Returns true when
 * the caller should retry creation (lock removed, or already gone); false
 * when a live holder still owns it.
 */
function breakIfStale(lockPath: string, staleMs: number): boolean {
  let first: fs.BigIntStats;
  try {
    first = fs.statSync(lockPath, { bigint: true });
  } catch {
    return true; // Vanished between create and stat — retry creation.
  }
  if (Date.now() - Number(first.mtimeMs) < staleMs) return false;
  // Re-stat and only unlink if it is still the same file we judged stale,
  // so we never remove a fresh lock another process just created.
  let second: fs.BigIntStats;
  try {
    second = fs.statSync(lockPath, { bigint: true });
  } catch {
    return true;
  }
  if (second.ino !== first.ino || second.mtimeNs !== first.mtimeNs) return false;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Another waiter broke it first; the creation retry arbitrates.
  }
  return true;
}

/**
 * Acquire the advisory lock at `lockPath`, waiting (with stale-breaking)
 * until it is free or `timeoutMs` elapses. Resolves to an idempotent
 * release function. The lock file's directory is created if needed.
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<() => void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}:${Date.now()}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreateLock(lockPath, token)) break;
    if (breakIfStale(lockPath, staleMs) && tryCreateLock(lockPath, token)) break;
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, timeoutMs);
    // CSPRNG-based retry jitter: backoff randomization does not need a PRNG
    // (SonarCloud S2245). A uniform [0,1) fraction from randomBytes is fine.
    const jitter = randomBytes(4).readUInt32BE(0) / 0xffffffff;
    await sleep(retryMs + Math.floor(jitter * retryMs));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      // Only remove the lock if it is still ours: if we were judged stale
      // and broken, the file now belongs to another holder.
      if (fs.readFileSync(lockPath, "utf-8") === token) fs.unlinkSync(lockPath);
    } catch {
      // Already gone or replaced — nothing to release.
    }
  };
}
