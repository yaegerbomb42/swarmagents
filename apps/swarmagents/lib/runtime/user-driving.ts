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
/** One-shot hand-back notes, delivered to the agent on its next desktop action. */
const pendingNoteByRun = new Map<string, string>();

/** The deny reason while the user still holds the desktop. */
export const USER_DRIVING_DENY_REASON =
  "the user is controlling the desktop; wait or call describe_screen";

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
  const result = formatHandback(entry, now);
  pendingNoteByRun.set(runId, result.note);
  return result;
}

function formatHandback(
  entry: UserDrivingEntry | undefined,
  now: () => number,
): { wasDriving: boolean; durationSec: number; note: string } {
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

/** Take (and clear) the hand-back note waiting for the run's next desktop action. */
export function takeHandbackNote(runId: string): string | undefined {
  const note = pendingNoteByRun.get(runId);
  pendingNoteByRun.delete(runId);
  return note;
}

/** Forget all user-driving state for a run (call when the run ends). */
export function clearUserDriving(runId: string): void {
  activeByRun.delete(runId);
  pendingNoteByRun.delete(runId);
}

export interface UserDrivingGateOptions {
  /** Aborts the wait (the run was cancelled). */
  signal?: AbortSignal;
  /**
   * Longest a held call waits for hand-back. Must stay below the in-VM
   * PreToolUse hook's own timeout (305 s), which would otherwise deny it.
   */
  maxWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_USER_DRIVING_MAX_WAIT_MS = 240_000;

/**
 * Gate one mutating desktop action against user takeover. Called only from
 * the pre-execution hook path, where a deny is a message to the model (the
 * run keeps going), never from the post-hoc gate, where a deny halts it.
 *
 * - User driving: hold the call until hand-back, idle expiry, abort, or
 *   `maxWaitMs`. Still driving at the bound: deny with a "wait" reason.
 * - A hand-back note pending: deny once with it, so the model re-inspects
 *   the screen before acting on coordinates the user may have invalidated.
 * - Otherwise: null (no opinion; the normal classifier decides).
 */
export async function gateUserDriving(
  runId: string,
  options: UserDrivingGateOptions = {},
): Promise<{ decision: "deny"; reason: string } | null> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_USER_DRIVING_MAX_WAIT_MS;
  const pollMs = options.pollMs ?? 500;
  const started = now();
  let held = false;
  while (isUserDriving(runId, now)) {
    if (options.signal?.aborted) return { decision: "deny", reason: "run was cancelled" };
    if (now() - started >= maxWaitMs) return { decision: "deny", reason: USER_DRIVING_DENY_REASON };
    held = true;
    await sleep(pollMs);
  }
  // A takeover that idle-expired without an explicit hand-back still moved
  // the screen under the agent: it gets the generic note.
  const note = takeHandbackNote(runId) ?? (held ? formatHandback(undefined, now).note : undefined);
  return note ? { decision: "deny", reason: note } : null;
}

/** Test helper: reset all in-memory user-driving flags. */
export function clearAllUserDrivingForTests(): void {
  activeByRun.clear();
  pendingNoteByRun.clear();
}
