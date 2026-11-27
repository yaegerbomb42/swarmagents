/**
 * Crash/restart recovery helpers (h2).
 *
 * 1. Startup reconciliation: marks any `running` / `queued` runs left over from
 *    a previous process as interrupted ("server restarted") immediately on boot.
 * 2. Per-user orphaned process cleanup: before the first agent run for a user
 *    after boot, kills any leftover `claude -p` process inside their VM so a
 *    new run never collides with an orphaned process from a crashed server.
 */

import { FakeVmDriver } from "../vm/fake-driver";
import type { VmManager } from "../vm/manager";
import { recoverOrphanedRuns } from "./run-store";

let lastStartupRecoveredCount = 0;

/**
 * Reconcile interrupted runs immediately on server boot (idempotent).
 * Returns the number of orphaned runs finalized.
 */
export function reconcileInterruptedRunsOnStartup(runsDir?: string | null): number {
  const recovered = recoverOrphanedRuns(runsDir);
  lastStartupRecoveredCount = recovered.length;
  return recovered.length;
}

/** Count of runs reconciled during this process's startup hook. */
export function startupRecoveredRunCount(): number {
  return lastStartupRecoveredCount;
}

/** Reset startup recovery state (tests only). */
export function resetRecoveryStateForTesting(): void {
  lastStartupRecoveredCount = 0;
}

/**
 * Kill any leftover `claude -p` agent processes inside `userId`'s VM once
 * per process boot, before their first new run starts.
 *
 * No-op under FakeVmDriver (tests) and ignores exit code 1 (no matching
 * process). Best-effort: never blocks a new run if cleanup fails.
 */
export async function killOrphanedAgentProcessesOnce(
  vm: Pick<VmManager, "driver" | "exec">,
  userId: string,
  sweptUsers: Set<string>,
): Promise<boolean> {
  if (sweptUsers.has(userId)) return false;
  sweptUsers.add(userId);
  if (vm.driver instanceof FakeVmDriver) return false;
  try {
    await vm.exec(userId, ["pkill", "-u", "agent", "-f", "claude -p"]);
  } catch {
    // Exit code 1 (no matching process) or transient exec failure is benign.
  }
  return true;
}
