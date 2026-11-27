/**
 * schedules.ts — client helpers for 1-click "Schedule This Task" from a
 * finished run and tracking unread completed scheduled (cron) runs.
 */

export const SCHEDULES_ENDPOINT = "/api/runtime/schedules";
export const DEFAULT_SCHEDULE_INTERVAL_MINUTES = 60;

export interface ScheduleSummary {
  id: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  lastRunId?: string;
}

export interface UnreadScheduledRun {
  scheduleId: string;
  scheduleName: string;
  runId: string;
  ranAt: number;
  intervalMinutes: number;
}

/** Derive a concise schedule name + valid interval (>= 5 min) from a run prompt. */
export function buildScheduleFromRunInput(
  prompt: string,
  intervalMinutes: number = DEFAULT_SCHEDULE_INTERVAL_MINUTES,
): { name: string; prompt: string; intervalMinutes: number } {
  const trimmed = prompt.trim() || "Scheduled task";
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() || trimmed;
  const name = firstLine.length > 48 ? `${firstLine.slice(0, 45).trimEnd()}...` : firstLine;
  const mins = Number.isFinite(intervalMinutes) ? Math.max(5, Math.min(10_080, Math.floor(intervalMinutes))) : DEFAULT_SCHEDULE_INTERVAL_MINUTES;
  return { name, prompt: trimmed, intervalMinutes: mins };
}

/** Create a recurring schedule from a finished run via POST /api/runtime/schedules. */
export async function createScheduleFromRun(
  input: { prompt: string; intervalMinutes?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; schedule: ScheduleSummary } | { ok: false; error: string }> {
  const payload = buildScheduleFromRunInput(input.prompt, input.intervalMinutes);
  try {
    const res = await fetchImpl(SCHEDULES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as { schedule?: ScheduleSummary; error?: unknown } | null;
    if (!res.ok) {
      return {
        ok: false,
        error: typeof body?.error === "string" && body.error ? body.error : `HTTP ${res.status}`,
      };
    }
    if (!body?.schedule) return { ok: false, error: "Server returned no schedule." };
    return { ok: true, schedule: body.schedule };
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.message ? err.message : "Network error" };
  }
}

/** Fetch the caller's schedules. Never throws. */
export async function fetchSchedules(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ ok: true; schedules: ScheduleSummary[] } | { ok: false }> {
  try {
    const res = await fetchImpl(SCHEDULES_ENDPOINT, { cache: "no-store", signal });
    if (!res.ok) return { ok: false };
    const body = (await res.json().catch(() => null)) as { schedules?: unknown } | null;
    if (!Array.isArray(body?.schedules)) return { ok: false };
    return { ok: true, schedules: body.schedules as ScheduleSummary[] };
  } catch {
    return { ok: false };
  }
}

/**
 * Return completed scheduled runs whose `lastRunId` is not yet in
 * `seenRunIds` and that ran at or after `sinceMs` — the moment this browser
 * started tracking. Without that floor a fresh browser (empty seen list)
 * would flag every schedule's old last run as unread.
 */
export function unreadScheduledRuns(
  schedules: readonly ScheduleSummary[],
  seenRunIds: ReadonlySet<string> | readonly string[],
  sinceMs = 0,
): UnreadScheduledRun[] {
  const seen = seenRunIds instanceof Set ? seenRunIds : new Set(seenRunIds);
  const unread: UnreadScheduledRun[] = [];
  for (const s of schedules) {
    if (!s.lastRunId || !s.lastRunAt) continue;
    if (s.lastRunAt < sinceMs) continue;
    if (seen.has(s.lastRunId)) continue;
    unread.push({
      scheduleId: s.id,
      scheduleName: s.name,
      runId: s.lastRunId,
      ranAt: s.lastRunAt,
      intervalMinutes: s.intervalMinutes,
    });
  }
  return unread.sort((a, b) => b.ranAt - a.ranAt);
}
