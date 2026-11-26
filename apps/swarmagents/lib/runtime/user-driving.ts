/**
 * Per-run "user driving" state for user-initiated desktop takeover.
 *
 * When a user clicks or types on the live interactive desktop during an active
 * run, the UI pauses A1 by setting this per-run flag. While active, mutating
 * `computer-mcp` input tools are denied with a clear reason while read-only
 * inspection (`screenshot`, `describe_screen`, `inspect_ui`) stays allowed.
 * The flag auto-expires after 5 minutes of idle time so a disconnected tab
 * never leaves a run permanently paused.
 */

export const DEFAULT_USER_DRIVING_IDLE_MS = 5 * 60 * 1000;

interface UserDrivingEntry {
  startedAt: number;
  lastActivityAt: number;
}

const activeByRun = new Map<string, UserDrivingEntry>();

/** Mark a run as currently driven by the user; returns whether this started a new span. */
export function setUserDriving(
  runId: string,
  now: () => number = Date.now,
): { newlyActivated: boolean; startedAt: number } {
  const ts = now();
  const existing = activeByRun.get(runId);
  if (existing && ts - existing.lastActivityAt < DEFAULT_USER_DRIVING_IDLE_MS) {
    existing.lastActivityAt = ts;
    return { newlyActivated: false, startedAt: existing.startedAt };
  }
  activeByRun.set(runId, { startedAt: ts, lastActivityAt: ts });
  return { newlyActivated: true, startedAt: ts };
}

/** True when the user is currently driving `runId` (auto-expires after 5m idle). */
export function isUserDriving(
  runId: string,
  now: () => number = Date.now,
  idleMs: number = DEFAULT_USER_DRIVING_IDLE_MS,
): boolean {
  const entry = activeByRun.get(runId);
  if (!entry) return false;
  if (now() - entry.lastActivityAt >= idleMs) {
    activeByRun.delete(runId);
    return false;
  }
  return true;
}

/** Clear user-driving state and format the hand-back note for the agent. */
export function handbackUserDriving(
  runId: string,
  now: () => number = Date.now,
): { wasDriving: boolean; durationSec: number; note: string } {
  const entry = activeByRun.get(runId);
  activeByRun.delete(runId);
  if (!entry) {
    return {
      wasDriving: false,
      durationSec: 0,
      note: "User handed back desktop control. The screen may have changed. Call describe_screen before acting.",
    };
  }
  const durationSec = Math.max(1, Math.round((now() - entry.startedAt) / 1000));
  return {
    wasDriving: true,
    durationSec,
    note: `User controlled the desktop for ${durationSec}s. The screen may have changed. Call describe_screen before acting.`,
  };
}

/** Test helper: reset all in-memory user-driving flags. */
export function clearAllUserDrivingForTests(): void {
  activeByRun.clear();
}
