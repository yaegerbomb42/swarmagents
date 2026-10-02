// Per-user run quotas on a server: how many agent runs one account may have going at once (chat turns and
// background tasks together) and how many steps one run may take. Storage has its own module (./storage).
// Locally there are no limits unless the env vars are set.
//
//   SWARM_QUOTA_RUNS   concurrent runs per account (server default 2)
//   SWARM_QUOTA_STEPS  model steps per run (server default 1000; a stopped run continues on the next message)

import { currentUser } from "../store";

const num = (v: string | undefined, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

export function runQuota(userId = currentUser()) {
  const local = userId === "local";
  return {
    runs: num(process.env.SWARM_QUOTA_RUNS, local ? Infinity : 2),
    steps: num(process.env.SWARM_QUOTA_STEPS, local ? Infinity : 1000),
  };
}

const g = globalThis as unknown as { __swarmRunSlots?: Map<string, Set<string>> };
const slots = (g.__swarmRunSlots ??= new Map());

export class RunQuotaError extends Error {
  readonly status = 429;
  constructor(limit: number) {
    super(`You already have ${limit} run${limit === 1 ? "" : "s"} going, the most one account can run at once. Wait for one to finish or stop it, then try again.`);
    this.name = "RunQuotaError";
  }
}

/**
 * Take a run slot for `key` (a session id, or task id). Re-acquiring a key you hold is free. Returns a release
 * function; throws RunQuotaError when the account is at its limit.
 */
export function acquireRun(key: string, userId = currentUser()): () => void {
  const held = slots.get(userId) ?? new Set<string>();
  const { runs } = runQuota(userId);
  if (!held.has(key) && held.size >= runs) throw new RunQuotaError(runs);
  held.add(key);
  slots.set(userId, held);
  return () => {
    held.delete(key);
  };
}

/** Runs the account has going right now. */
export const activeRuns = (userId = currentUser()) => [...(slots.get(userId) ?? [])];

/** Message to stop a run with once it has taken `steps` steps, or null while it may continue. */
export function stepLimitReached(steps: number, userId = currentUser()): string | null {
  const { steps: max } = runQuota(userId);
  return steps >= max ? `Stopped after ${max} steps, the per-run limit on this server. Send a message to continue.` : null;
}
