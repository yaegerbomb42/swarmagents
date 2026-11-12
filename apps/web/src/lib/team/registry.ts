/**
 * Team Mode — in-memory run registry.
 *
 * Runs live on globalThis like the other server singletons (providerStore,
 * eventBus, harnessTasks) so they survive module reloads in dev. The registry
 * is the source of truth for the panel: the SSE route replays a snapshot and
 * then pushes a fresh snapshot per event.
 */

import { eventBus } from '@/lib/eventBus';
import { teamEventId, type TeamEvent, type TeamRun } from './types';

const MAX_RUNS = 25;
const MAX_EVENTS_PER_RUN = 200;

type Listener = (run: TeamRun) => void;

const g = globalThis as typeof globalThis & {
  __swarmTeamRuns?: Map<string, TeamRun>;
  __swarmTeamListeners?: Map<string, Set<Listener>>;
  __swarmTeamEvents?: Map<string, TeamEvent[]>;
};

function runs(): Map<string, TeamRun> {
  if (!g.__swarmTeamRuns) g.__swarmTeamRuns = new Map();
  return g.__swarmTeamRuns;
}

function listeners(): Map<string, Set<Listener>> {
  if (!g.__swarmTeamListeners) g.__swarmTeamListeners = new Map();
  return g.__swarmTeamListeners;
}

function events(): Map<string, TeamEvent[]> {
  if (!g.__swarmTeamEvents) g.__swarmTeamEvents = new Map();
  return g.__swarmTeamEvents;
}

export function createTeamRun(run: TeamRun): TeamRun {
  const map = runs();
  map.set(run.runId, run);
  while (map.size > MAX_RUNS) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
    listeners().delete(oldest);
    events().delete(oldest);
  }
  return run;
}

export function getTeamRun(runId: string): TeamRun | undefined {
  return runs().get(runId);
}

export function listTeamRuns(): TeamRun[] {
  return [...runs().values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getTeamRunEvents(runId: string): TeamEvent[] {
  return events().get(runId) ?? [];
}

/** Bump updatedAt and push the new snapshot to every subscriber. */
export function updateTeamRun(run: TeamRun): TeamRun {
  run.updatedAt = Date.now();
  const set = listeners().get(run.runId);
  if (!set || !set.size) return run;
  const snapshot: TeamRun = JSON.parse(JSON.stringify(run));
  for (const listener of set) {
    try {
      listener(snapshot);
    } catch {
      /* a dead subscriber never breaks the run */
    }
  }
  return run;
}

export function subscribeTeamRun(runId: string, listener: Listener): () => void {
  const set = listeners().get(runId) ?? new Set<Listener>();
  set.add(listener);
  listeners().set(runId, set);
  return () => {
    const current = listeners().get(runId);
    if (!current) return;
    current.delete(listener);
    if (!current.size) listeners().delete(runId);
  };
}

/** Record + publish a team telemetry event (team.plan, team.agent.*, team.review). */
export function emitTeamEvent(run: TeamRun, action: string, payload: Record<string, unknown> = {}): TeamEvent {
  const event: TeamEvent = {
    id: teamEventId(),
    runId: run.runId,
    type: 'team',
    action,
    payload: { runId: run.runId, ...payload },
    timestamp: Date.now(),
  };
  const list = events().get(run.runId) ?? [];
  list.push(event);
  if (list.length > MAX_EVENTS_PER_RUN) list.splice(0, list.length - MAX_EVENTS_PER_RUN);
  events().set(run.runId, list);

  eventBus.team(action, event.payload);
  updateTeamRun(run);
  return event;
}

export function clearTeamRuns(): void {
  runs().clear();
  listeners().clear();
  events().clear();
}