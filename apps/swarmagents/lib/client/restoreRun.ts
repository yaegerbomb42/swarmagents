export interface RestorableRun {
  runId: string;
  status?: string;
  prompt?: string;
  createdAt?: number;
  finishedAt?: number;
}

export interface RestoreSelection {
  runId: string;
  prompt?: string;
  createdAt?: number;
  finishedAt?: number;
  active: boolean;
}

function isLiveStatus(status?: string): boolean {
  return status === "queued" || status === "running";
}

/**
 * Pick the run to reattach to after a full page (re)load for a thread.
 * Prefers an active (queued/running) run so a live view resumes; otherwise
 * returns the most recent run so a run that finished while disconnected can
 * show its final result instead of "Working…".
 */
export function pickRunToRestore(runs: readonly RestorableRun[]): RestoreSelection | null {
  let newestActive: RestorableRun | undefined;
  for (const run of runs) {
    if (!run?.runId || !isLiveStatus(run.status)) continue;
    if (
      !newestActive ||
      (run.createdAt ?? 0) > (newestActive.createdAt ?? 0) ||
      ((run.createdAt ?? 0) === (newestActive.createdAt ?? 0) && run.runId > newestActive.runId)
    ) {
      newestActive = run;
    }
  }
  const target = newestActive ?? runs.find((r) => r?.runId);
  if (!target?.runId) return null;
  return {
    runId: target.runId,
    prompt: typeof target.prompt === "string" && target.prompt.length > 0 ? target.prompt : undefined,
    createdAt:
      typeof target.createdAt === "number" && Number.isFinite(target.createdAt)
        ? target.createdAt
        : undefined,
    finishedAt:
      typeof target.finishedAt === "number" && Number.isFinite(target.finishedAt)
        ? target.finishedAt
        : undefined,
    active: isLiveStatus(target.status),
  };
}

export interface RunClock {
  /** performance.now()-based start, suitable for the app's run timers. */
  runStart: number;
  /** performance.now()-based end for finished runs, when known. */
  runEnd?: number;
}

/**
 * Convert a durable run's epoch-ms timestamps into the app's performance.now()
 * timebase. When createdAt is missing, anchors runStart to "now" so the UI
 * still treats the run as present (hasRun) while reconnecting. For finished
 * runs, prefer the run's real finishedAt over "now" so the reported duration
 * matches the recorded run.
 */
export function runClockFromEpoch(opts: {
  createdAt?: number;
  finishedAt?: number;
  active: boolean;
  nowEpochMs?: number;
  nowPerfMs?: number;
}): RunClock {
  const nowEpoch = opts.nowEpochMs ?? Date.now();
  const nowPerf = opts.nowPerfMs ?? performance.now();
  const createdAt =
    typeof opts.createdAt === "number" && Number.isFinite(opts.createdAt) ? opts.createdAt : undefined;
  const finishedAt =
    typeof opts.finishedAt === "number" && Number.isFinite(opts.finishedAt) ? opts.finishedAt : undefined;

  const runStart = createdAt !== undefined ? nowPerf - (nowEpoch - createdAt) : nowPerf;
  if (opts.active) return { runStart };

  const endEpoch = finishedAt ?? (createdAt !== undefined ? nowEpoch : undefined);
  const runEnd = endEpoch !== undefined ? runStart + Math.max(0, endEpoch - (createdAt ?? nowEpoch)) : nowPerf;
  return { runStart, runEnd };
}
