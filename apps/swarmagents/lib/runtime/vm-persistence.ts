/**
 * VM persistence decisions (lib/runtime/vm-persistence.ts).
 *
 * Pure helpers for the per-user VM persistence toggle (spec 3d): given the
 * user's chosen mode (lib/providers/settings.ts `VmPersistenceMode`) and the
 * shape of the run, decide whether the runtime resets the VM before a task
 * starts or stops it when a task ends. Kept separate from the manager so
 * the policy is unit-testable without a VM.
 */

import type { VmPersistenceMode } from "../providers/settings";

/** The run-shape facts the start-side decision needs. */
export interface VmStartFacts {
  /** F1 fork seed: the run restores a checkpoint's workspace at start. */
  seedSnapshotLabel?: string;
}

/**
 * Should the VM be reset (destroyed, volume wiped) before this run starts?
 *
 * Only "fresh-per-task" resets. The one exemption is a fork seed: it
 * restores its checkpoint workspace right after ensure, so wiping first
 * would destroy the state the run is about to use (checkpoint-resume runs
 * carry a seed label too). A resumed conversation session is NOT exempt —
 * choosing fresh-per-task means each task starts on a clean machine even
 * when the conversation continues.
 */
export function shouldResetVmAtRunStart(mode: VmPersistenceMode, facts: VmStartFacts): boolean {
  if (mode !== "fresh-per-task") return false;
  if (facts.seedSnapshotLabel) return false;
  return true;
}

/** The run-shape facts the end-side decision needs. */
export interface VmEndFacts {
  /** True when another run for this user is active or queued after this one. */
  hasRemainingWork: boolean;
}

/**
 * Should the VM be stopped (compute terminated, volume kept) now that this
 * run has finished?
 *
 * Only "terminate-at-project-end" stops eagerly, and only when the project
 * has no work left: while another run is active or queued the VM stays up
 * for it. "persistent" leaves stopping to the idle sweeper, and
 * "fresh-per-task" resets at the next start instead.
 */
export function shouldStopVmAtRunEnd(mode: VmPersistenceMode, facts: VmEndFacts): boolean {
  if (mode !== "terminate-at-project-end") return false;
  return !facts.hasRemainingWork;
}
