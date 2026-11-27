"use client";

/**
 * useActiveRun — reattach to the live run after a (re)load.
 *
 * The run id used to live only in React state, so a reload lost the live
 * view while the run kept going server-side. On mount this hook asks the
 * server which run the user should be looking at:
 *
 *   - the account's running (else next queued) run, or
 *   - the most recent finished run, when it ended within
 *     RECENT_FINISHED_WINDOW_MS (so a run that finished while the tab was
 *     closed still shows its final result instead of "Working…").
 *
 * The last run id is also kept in sessionStorage as a hint, so the stream
 * can attach to it before the first poll answers. Selection itself reuses
 * pickRunToRestore (lib/client/restoreRun); this hook only adds the
 * 10-minute window for finished runs, the shell-run exclusion, and the
 * sessionStorage hint.
 */

import { useEffect, useState } from "react";
import { fetchRuns } from "./runs";
import { pickRunToRestore, type RestorableRun } from "./restoreRun";
import type { ThreadRunInput } from "./thread";

/** How long after a run finishes it still counts as "the run to show". */
export const RECENT_FINISHED_WINDOW_MS = 10 * 60 * 1000;

/** sessionStorage key for the last run id, used as a reattach hint. */
export const LAST_RUN_HINT_KEY = "sa.lastRunId";

export function readLastRunHint(): string | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage.getItem(LAST_RUN_HINT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeLastRunHint(runId: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(LAST_RUN_HINT_KEY, runId);
  } catch {
    // Storage full or blocked: the poll still finds the run.
  }
}

export function clearLastRunHint(): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.removeItem(LAST_RUN_HINT_KEY);
  } catch {
    // ignore
  }
}

export interface ActiveRunSelection {
  runId: string;
  prompt?: string;
  /** The harness session this run belongs to (the conversation to open). */
  sessionId?: string;
  /** True for a running or queued run; false for a recently finished one. */
  active: boolean;
  createdAt?: number;
  finishedAt?: number;
}

/**
 * Pick the run the workspace should show, newest-first input. Shell runs
 * (direct terminal execs) never become thread entries, so they are skipped.
 * A finished run only counts when it ended within RECENT_FINISHED_WINDOW_MS
 * (finishedAt, falling back to createdAt when the finish time is unknown).
 */
export function selectActiveRun(
  runs: readonly ThreadRunInput[],
  nowMs: number = Date.now(),
): ActiveRunSelection | null {
  const agentRuns = runs.filter((run) => run.kind !== "shell");
  const picked = pickRunToRestore(agentRuns as RestorableRun[]);
  if (!picked) return null;
  if (!picked.active) {
    const endedAt = picked.finishedAt ?? picked.createdAt;
    if (endedAt === undefined || nowMs - endedAt > RECENT_FINISHED_WINDOW_MS) return null;
  }
  const source = agentRuns.find((run) => run.runId === picked.runId);
  return {
    runId: picked.runId,
    ...(picked.prompt ? { prompt: picked.prompt } : {}),
    ...(source?.sessionId ? { sessionId: source.sessionId } : {}),
    active: picked.active,
    ...(picked.createdAt !== undefined ? { createdAt: picked.createdAt } : {}),
    ...(picked.finishedAt !== undefined ? { finishedAt: picked.finishedAt } : {}),
  };
}

/** Fetch the account's runs and select the one to reattach to. Never throws. */
export async function loadActiveRun(
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<ActiveRunSelection | null> {
  const result = await fetchRuns("limit=20", { fetchImpl });
  if (!result.ok) return null;
  return selectActiveRun(result.runs, nowMs);
}

export interface ActiveRunState {
  /** The run to reattach to, once the mount fetch has answered. */
  selection: ActiveRunSelection | null;
  /** True once the mount fetch has answered (with or without a run). */
  ready: boolean;
  /** The last run id from sessionStorage, for attaching before the fetch lands. */
  hintRunId?: string;
}

export function useActiveRun(): ActiveRunState {
  const [hintRunId] = useState<string | undefined>(() => readLastRunHint());
  const [selection, setSelection] = useState<ActiveRunSelection | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const picked = await loadActiveRun();
      if (cancelled) return;
      if (picked) writeLastRunHint(picked.runId);
      setSelection(picked);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { selection, ready, hintRunId };
}
