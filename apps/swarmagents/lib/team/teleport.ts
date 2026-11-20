/**
 * Cloud → BYOC teleport (session, /workspace diff, memory).
 *
 * The runner that can receive a teleported session lives on
 * feat/g10-deepseek15-byoc-node (packages/swarm-node, lib/byoc), which is
 * PR #95 and is not merged. This module reports that block. It does not
 * pretend a sync happened.
 */
export interface TeleportStatus {
  available: false;
  blockedBy: string;
}

export function teleportAvailability(): TeleportStatus {
  return {
    available: false,
    blockedBy:
      "PR #95 (feat/g10-deepseek15-byoc-node) is open and unmerged. Teleport needs its swarm-node runner before a cloud session can move onto a paired computer.",
  };
}
