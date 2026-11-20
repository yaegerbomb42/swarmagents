/**
 * Live-room resolution: map a share token to the owner and the run guests can
 * spectate. Ownership is derived from the token index only — the owner id is
 * never exposed to the guest. A share that does not resolve (revoked, rotated,
 * project deleted) yields null so routes 404.
 */

import { getRuntimeManager, type RunSummary } from "../runtime/manager";
import { resolveShareOwner } from "../projects/store";

export interface ResolvedRoom {
  ownerId: string;
  projectId: string;
  /** The owner's run guests can watch (active, else first queued), if any. */
  run: RunSummary | null;
}

/** Pick the run a guest should spectate: the live run wins, else the first queued. */
export function pickSpectateRun(runs: RunSummary[]): RunSummary | null {
  return (
    runs.find((r) => r.status === "running") ??
    runs.find((r) => r.status === "queued") ??
    null
  );
}

export function resolveRoom(token: string): ResolvedRoom | null {
  const owner = resolveShareOwner(token);
  if (!owner) return null;
  const run = pickSpectateRun(getRuntimeManager().list(owner.ownerId));
  return { ownerId: owner.ownerId, projectId: owner.projectId, run };
}
