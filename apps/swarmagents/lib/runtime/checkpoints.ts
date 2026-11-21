/**
 * Time-travel checkpoints (F1): automatic pre-mutation snapshots + fork-from-here.
 *
 * Two names exist for every checkpoint:
 *
 *   - the *display* label, `auto-pre-step-<seq>`, is what the timeline shows
 *     and what the fork API accepts. `<seq>` is the step the checkpoint
 *     precedes — it equals the bus sequence the checkpoint.created event
 *     itself receives, so a checkpoint and the tool call it guards sit next
 *     to each other in the timeline.
 *   - the *VM* label, stored in the VM driver. For a normal run it is
 *     `<runId>-auto-pre-step-<seq>`; for a team lane it is
 *     `<runId>-<laneId>-step-<seq>`. Snapshots are namespaced per user, not
 *     per run, so the runId prefix keeps one run's checkpoints from
 *     colliding with another run's — including a fork's, which gets its own
 *     runId and therefore its own lineage. Team lanes of the same run share
 *     the runId, so the laneId is what keeps two concurrent lanes from
 *     overwriting each other's checkpoints when they checkpoint the same step.
 *
 * Both labels fit the driver's snapshot charset (lowercase alphanumerics
 * plus `.`, `_`, `-`, 1–64 chars, no `..`): a runId is `run_` + a 36-char
 * uuid (40 chars), the lane id is short (e.g. `a1`, `planner`), and the
 * step seq is a small integer, so VM labels stay under 64 characters.
 */

import type { VmManager } from "../vm/manager";

export interface ForkInfo {
  /** The run the fork was cut from. */
  runId: string;
  /** Display label of the checkpoint, e.g. "auto-pre-step-12". */
  checkpointLabel: string;
  /** Step sequence the checkpoint precedes. */
  stepSeq: number;
}

/**
 * Resume point recorded at an auto-checkpoint so a server restart can restore
 * and resume the run safely without repeating mutating side effects.
 */
export interface ResumePoint {
  runId: string;
  checkpointLabel: string;
  stepSeq: number;
  sessionId?: string;
}

/**
 * Result of one auto-checkpoint attempt. The hook contract is outcome-based,
 * never throw-based: a snapshot failure is returned as `{ok:false}` so the
 * run continues and the failure surfaces in telemetry as checkpoint.failed
 * instead of silently vanishing — or blocking the agent's work.
 */
export type CheckpointOutcome =
  | {
      ok: true;
      label: string;
      vmLabel: string;
      stepSeq: number;
      /** Epoch ms the snapshot was created. */
      createdAt: number;
    }
  | {
      ok: false;
      label: string;
      vmLabel: string;
      stepSeq: number;
      error: string;
    };

/** Snapshot function a checkpoint taker calls with the VM label it computed. */
export type CheckpointSnapshotFn = (vmLabel: string) => Promise<{ createdAt: number }>;

/**
 * Shared core of every auto-checkpoint: snapshot the VM for step `stepSeq`
 * of `runId` and shape the outcome. Never throws — a snapshot failure is
 * returned as `{ok:false}` so the run continues and the failure surfaces
 * as `checkpoint.failed` telemetry instead of blocking the agent's work.
 *
 * Both call paths use this: RuntimeManager's gate-time checkpoints (whose
 * step comes from the telemetry bus) and team lanes (whose step comes from
 * the per-lane counter in {@link createCheckpointTaker}).
 */
export async function takeRunCheckpoint(
  takeSnapshot: CheckpointSnapshotFn,
  runId: string,
  stepSeq: number,
  laneId?: string,
): Promise<CheckpointOutcome> {
  const label = checkpointDisplayLabel(stepSeq);
  const vmLabel = checkpointVmLabel(runId, stepSeq, laneId);
  try {
    const snapshot = await takeSnapshot(vmLabel);
    return { ok: true, label, vmLabel, stepSeq, createdAt: snapshot.createdAt };
  } catch (error) {
    return {
      ok: false,
      label,
      vmLabel,
      stepSeq,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build a `takeCheckpoint` callback (the `EvaluateToolApprovalOptions`
 * hook) for a run whose step sequence is not tracked on the
 * RuntimeManager bus. Team lanes own their own event stream (see
 * lib/team/harness.ts) and never publish to the manager's bus, so there
 * is no bus seq to anchor the label to — this taker keeps its own
 * per-lane counter instead: the lane's first checkpoint is step 1, the
 * next step 2, and so on. Labels stay in the same `auto-pre-step-<seq>`
 * / `<runId>-auto-pre-step-<seq>` scheme, so a lane's checkpoints fork
 * and list exactly like a normal run's.
 *
 * The snapshot goes through `snapshotDuringRun`, the read-lock path the
 * normal gate uses: the lane's long-lived claude exec holds the VM read
 * lock, so a write-lock snapshot here would deadlock (see
 * VmManager.snapshotDuringRun). The `info` argument (tool name + reason)
 * is accepted for the hook signature; the checkpoint telemetry that
 * carries it is emitted by evaluateToolApproval, not here.
 */
export function createCheckpointTaker(
  vm: Pick<VmManager, "snapshotDuringRun">,
  userId: string,
  runId: string,
  laneId: string,
): (info: { toolName: string; reason: string }) => Promise<CheckpointOutcome> {
  let stepSeq = 0;
  return (_info) =>
    takeRunCheckpoint(
      (vmLabel) => vm.snapshotDuringRun(userId, vmLabel),
      runId,
      (stepSeq += 1),
      laneId,
    );
}

export const CHECKPOINT_LABEL_PREFIX = "auto-pre-step-";

/** Display label for the checkpoint preceding step `stepSeq`. */
export function checkpointDisplayLabel(stepSeq: number): string {
  return `${CHECKPOINT_LABEL_PREFIX}${stepSeq}`;
}

/** VM snapshot label for `runId`'s checkpoint preceding step `stepSeq`. Normal runs (no `laneId`) use `<runId>-auto-pre-step-<seq>`; team lanes pass a `laneId` to produce `<runId>-<laneId>-step-<seq>`, so concurrent lanes of one run never share a label. */
export function checkpointVmLabel(
  runId: string,
  stepSeq: number,
  laneId?: string,
): string {
  return laneId
    ? `${runId}-${laneId}-step-${stepSeq}`
    : `${runId}-${checkpointDisplayLabel(stepSeq)}`;
}

const CHECKPOINT_VM_LABEL_RE = /^(run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-auto-pre-step-(\d+)$/;
const CHECKPOINT_VM_LABEL_LANE_RE = /^(run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([a-z0-9_-]+)-step-(\d+)$/;

/**
 * Split a VM snapshot label back into its run + (optional lane) + step, or
 * null when it is not one of ours. Accepts both the normal-run form
 * `<runId>-auto-pre-step-<seq>` (laneId undefined) and the lane form
 * `<runId>-<laneId>-step-<seq>`. The normal-run form is checked first so a
 * label like `<runId>-auto-pre-step-1` is not misread as a lane named
 * `auto-pre`.
 */
export function parseCheckpointVmLabel(
  label: string,
): { runId: string; laneId: string | undefined; stepSeq: number } | null {
  const match = CHECKPOINT_VM_LABEL_RE.exec(label);
  if (match) return { runId: match[1], laneId: undefined, stepSeq: Number(match[2]) };
  const laneMatch = CHECKPOINT_VM_LABEL_LANE_RE.exec(label);
  if (laneMatch)
    return { runId: laneMatch[1], laneId: laneMatch[2], stepSeq: Number(laneMatch[3]) };
  return null;
}

const CHECKPOINT_DISPLAY_LABEL_RE = /^auto-pre-step-(\d+)$/;

/**
 * Accept a step sequence (number) or a display label ("auto-pre-step-12")
 * and return the step sequence, or null when it is neither. Step sequences
 * start at 1: seq 0 is the run's own creation, never a tool step.
 */
export function resolveCheckpointStepSeq(checkpoint: number | string): number | null {
  if (typeof checkpoint === "number") {
    return Number.isSafeInteger(checkpoint) && checkpoint > 0 ? checkpoint : null;
  }
  const match = CHECKPOINT_DISPLAY_LABEL_RE.exec(checkpoint.trim());
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}
