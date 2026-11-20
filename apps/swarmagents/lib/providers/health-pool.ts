import { createHash } from "node:crypto";
import { HealthChecker } from "./health";
import { routerProviders } from "./store";

/** Upper bound on live per-user checkers; the least recently used is stopped. */
export const MAX_CHECKERS = 64;

/** How long before an idle checker is stopped if no request arrives (5 minutes). */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface CheckerEntry {
  checker: HealthChecker;
  signature: string;
  lastAccessedAt: number;
}

/** One background checker per user, pinging only that user's providers. */
const checkers = new Map<string, CheckerEntry>();

/** Background sweeper timer that prunes checkers idle for >= IDLE_TIMEOUT_MS. */
let idleSweeperTimer: NodeJS.Timeout | null = null;

export function fingerprintKeys(keys?: string[]): string {
  if (!keys || keys.length === 0) return "none";
  return createHash("sha256").update(keys.join("\0")).digest("hex").slice(0, 16);
}

function stopEntry(entry: CheckerEntry): void {
  entry.checker.stop();
}

/** Stop and prune any checkers that have been idle for more than timeoutMs. */
export function pruneIdleCheckers(timeoutMs: number = IDLE_TIMEOUT_MS, now: number = Date.now()): number {
  let pruned = 0;
  for (const [owner, entry] of checkers.entries()) {
    if (now - entry.lastAccessedAt >= timeoutMs) {
      stopEntry(entry);
      checkers.delete(owner);
      pruned++;
    }
  }
  if (checkers.size === 0 && idleSweeperTimer) {
    clearInterval(idleSweeperTimer);
    idleSweeperTimer = null;
  }
  return pruned;
}

function ensureIdleSweeper(): void {
  if (idleSweeperTimer || checkers.size === 0) return;
  idleSweeperTimer = setInterval(() => {
    pruneIdleCheckers();
  }, 30_000);
  (idleSweeperTimer as unknown as { unref?: () => void }).unref?.();
}

export function getHealthChecker(owner: string): HealthChecker {
  const providers = routerProviders(owner);
  const signature = providers
    .map(
      (p) =>
        `${p.id}:${p.kind}:${p.enabled ?? true}:${fingerprintKeys(p.keys)}:${p.baseUrl ?? ""}:${JSON.stringify(p.models ?? "")}`,
    )
    .join(",");
  const existing = checkers.get(owner);
  const now = Date.now();

  if (existing && existing.signature === signature) {
    // Refresh LRU position and access timestamp.
    existing.lastAccessedAt = now;
    checkers.delete(owner);
    checkers.set(owner, existing);
    ensureIdleSweeper();
    return existing.checker;
  }

  if (existing) {
    stopEntry(existing);
    checkers.delete(owner);
  }

  const checker = new HealthChecker({ providers });
  checker.start();
  const entry: CheckerEntry = {
    checker,
    signature,
    lastAccessedAt: now,
  };
  checkers.set(owner, entry);
  ensureIdleSweeper();

  while (checkers.size > MAX_CHECKERS) {
    const [oldest, oldestEntry] = checkers.entries().next().value as [string, CheckerEntry];
    stopEntry(oldestEntry);
    checkers.delete(oldest);
  }
  return checker;
}

// Helpers for testing state inspection and cleanup
export function _testInspectCheckers(): Map<string, { checker: HealthChecker; lastAccessedAt: number; isStopped: boolean }> {
  const result = new Map<string, { checker: HealthChecker; lastAccessedAt: number; isStopped: boolean }>();
  for (const [owner, entry] of checkers.entries()) {
    result.set(owner, {
      checker: entry.checker,
      lastAccessedAt: entry.lastAccessedAt,
      isStopped: (entry.checker as unknown as { stopped: boolean }).stopped,
    });
  }
  return result;
}

export function _testResetCheckers(): void {
  if (idleSweeperTimer) {
    clearInterval(idleSweeperTimer);
    idleSweeperTimer = null;
  }
  for (const entry of checkers.values()) {
    stopEntry(entry);
  }
  checkers.clear();
}
