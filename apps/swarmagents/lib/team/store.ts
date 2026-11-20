// Team Mode — in-memory run registry.
//
// The runtime routes ask this module who owns a run (so the existing
// /api/runtime/stream/[runId] SSE route can serve team telemetry) and whether
// the run is still active (the LLM proxy checks the same thing). Runs live on
// globalThis like the runtime manager, so dev reloads do not lose them.

import type { TeamRun } from "./types";

interface TeamRecord {
  run: TeamRun;
  active: boolean;
}

const g = globalThis as typeof globalThis & {
  __swarmTeamRuns?: Map<string, TeamRecord>;
};

function records(): Map<string, TeamRecord> {
  if (!g.__swarmTeamRuns) g.__swarmTeamRuns = new Map();
  return g.__swarmTeamRuns;
}

const MAX_RUNS = 25;

export function registerTeamRun(run: TeamRun): TeamRun {
  const map = records();
  map.set(run.runId, { run, active: true });
  while (map.size > MAX_RUNS) {
    // Evict the oldest *finished* run. Evicting an active one would make
    // hasActiveTeamRun()/ownsTeamRun() lie about a live run (and could let a
    // second team run start for the same account).
    let victim: string | undefined;
    for (const [runId, record] of map) {
      if (!record.active) {
        victim = runId;
        break;
      }
    }
    if (victim === undefined) break; // every record is active; keep them all
    map.delete(victim);
  }
  return run;
}

export function getTeamRun(runId: string): TeamRun | undefined {
  return records().get(runId)?.run;
}

export function ownsTeamRun(userId: string, runId: string): boolean {
  const record = records().get(runId);
  return !!record && record.run.userId === userId;
}

export function isTeamRunActive(runId: string): boolean {
  return records().get(runId)?.active === true;
}

export function endTeamRun(runId: string): void {
  const record = records().get(runId);
  if (record) record.active = false;
}

export function latestTeamRun(userId: string): TeamRun | undefined {
  let latest: TeamRun | undefined;
  for (const record of records().values()) {
    if (record.run.userId !== userId) continue;
    if (!latest || record.run.createdAt > latest.createdAt) latest = record.run;
  }
  return latest;
}

export function listTeamRuns(userId: string): TeamRun[] {
  return [...records().values()]
    .map((record) => record.run)
    .filter((run) => run.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** True when this user already has a team run in flight. */
export function hasActiveTeamRun(userId: string): boolean {
  for (const record of records().values()) {
    if (record.active && record.run.userId === userId) return true;
  }
  return false;
}

export function clearTeamRuns(): void {
  records().clear();
}