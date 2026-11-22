/**
 * F4 — "Test-Drive in Isolated Ephemeral Snapshot".
 *
 * POST /api/library/public/{id}/test-drive  {action:"start", prompt?}
 *   -> 201 {drive, runId, snapshotLabel}
 * POST /api/library/public/{id}/test-drive  {action:"keep"|"rollback", driveId}
 *   -> 200 {drive}
 * POST /api/library/public/{id}/test-drive  {action:"sweep"}
 *   -> 200 {swept: string[], failed: {id, error}[]} — rolls back the
 *   caller's "awaiting-decision" drives older than the abandonment window
 *   (see sweepAbandonedDrives in lib/library/test-drive.ts).
 * GET  /api/library/public/{id}/test-drive?driveId=<id>
 *   -> {drive} (auto-finalizes a finished drive: see below)
 * GET  /api/library/public/{id}/test-drive
 *   -> {drives} (the caller's drives for this item, newest first)
 *
 * Both GET paths also run the abandonment sweep for the caller, so a drive
 * the user never revisits is rolled back the next time any drive list is
 * read — the sweep is the background cleanup, and the explicit sweep
 * action is the manual trigger. Every path that can restore a snapshot
 * (keep, rollback, start, both GET sweeps, the sweep action) runs behind
 * the user's Test-Drive lock, so a background restore can never race a
 * keep and wipe a kept VM. (There is no app-level periodic hook for
 * library records to piggyback on: the RuntimeManager watchdog and the
 * VM idle sweeper are run/VM-scoped, so the route reads + the sweep
 * action are the mechanism, not a new timer.)
 *
 * The start sequence is the whole point of the feature:
 *   1. Refuse while the user has an active or queued run — snapshotting
 *      mid-run would capture a moving target and the drive would queue
 *      behind work the user did not mean to disturb.
 *   2. Roll back any earlier drive for this user left "awaiting-decision"
 *      (abandoned: the user moved on without choosing). Best effort; a
 *      restore failure is recorded on the old drive, never fatal here.
 *   3. Snapshot the VM first (via the snapshots API's manager — the same
 *      `VmManager.snapshot` the snapshots route and F1 checkpoints use, so
 *      the pre-drive state includes the /workspace volume backup from job
 *      zero). A snapshot failure aborts the drive: nothing runs.
 *   4. Start a fresh-session agent run whose prompt carries the
 *      `[test-drive:<publicId>]` marker and the item's content inline. The
 *      unreviewed item is NOT installed first.
 *   5. If the run refuses to start, restore the snapshot immediately and
 *      report the error — no drive record is left behind.
 *
 * Keep/rollback semantics:
 *   - "keep" only works once the drive run finished successfully
 *     (status "awaiting-decision"); the pre-drive snapshot is left in
 *     place and the VM keeps the post-drive state.
 *   - "rollback" restores the pre-drive snapshot; a restore failure is a
 *     500 and the drive stays "awaiting-decision" so the user can retry.
 *   - A run that errors or is cancelled auto-rolls back the first time its
 *     status is read (GET or a keep/rollback attempt): a failed drive must
 *     never leave the VM in the post-drive state. An auto-rollback failure
 *     is recorded on the drive (`lastError`) and surfaced, not swallowed.
 *
 * Abandoned drives are also rolled back by a background timer for every
 * account once an hour (see startTestDriveSweeper in
 * lib/library/test-drive-sweeper.ts, wired in getRuntimeManager next to the
 * VM idle sweeper) — so a drive abandoned by a user who never returns is
 * still rolled back; the route reads and the explicit sweep action are the
 * manual / on-demand cleanup path, not the only mechanism.
 *
 * Auth comes from the middleware-set x-swarm-user header (see lib/auth).
 * Drives are strictly per-account: every lookup checks `userId`.
 */

import { NextResponse } from "next/server";
import { getVmManager } from "../../../../../../lib/vm/manager";
import { getRuntimeManager } from "../../../../../../lib/runtime/manager";
import { getRunSummary } from "../../../../../../lib/runtime/run-store";
import { readRunReport } from "../../../../../../lib/runtime/run-report";
import type { RunReport } from "../../../../../../lib/runtime/run-report-types";
import {
  errorResponse,
  jsonError,
  libraryOwner,
  NO_STORE,
  readJson,
  routeParam,
  unauthorized,
} from "../../../../../../lib/library/http";
import { findPublicItem, latestVersion } from "../../../../../../lib/library/public-store";
import {
  createTestDrive,
  getTestDrive,
  listTestDrivesForUser,
  sweepAbandonedDrives,
  testDrivePrompt,
  testDriveSnapshotLabel,
  updateTestDrive,
  type TestDriveRecord,
  type TestDriveRollbackReason,
} from "../../../../../../lib/library/test-drive";
import { withUserLock } from "../../../../../../lib/library/test-drive-mutex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_LEN = 4000;

/** Client-safe drive view, including the drive run's outcome when known. */
export interface TestDriveView {
  id: string;
  publicId: string;
  publicName: string;
  version: number;
  snapshotLabel: string;
  runId: string;
  status: TestDriveRecord["status"];
  startedAt: number;
  finishedAt?: number;
  rollbackReason?: TestDriveRollbackReason;
  lastError?: string;
  /** Live run status ("running" | "queued" | "finished" | ... | "unknown"). */
  runStatus: string;
  /** The drive run's report, trimmed for the diff display, once finished. */
  report?: {
    status: RunReport["status"];
    costUsd?: number;
    durationMs?: number;
    model?: string;
    providers: string[];
    steps: RunReport["steps"];
    artifacts: RunReport["artifacts"];
    couldNotDo: string[];
    shots: number;
  };
}

function caller(req: Request): string | null {
  return libraryOwner(req);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function driveView(drive: TestDriveRecord, userId: string): TestDriveView {
  const report = readRunReport(drive.runId);
  const live = getRuntimeManager()
    .list(userId)
    .find((run) => run.runId === drive.runId);
  let runStatus = "unknown";
  if (live) runStatus = live.status;
  else if (report) runStatus = report.status;
  else {
    const summary = getRunSummary(drive.runId);
    if (summary) runStatus = summary.status;
  }
  const view: TestDriveView = {
    id: drive.id,
    publicId: drive.publicId,
    publicName: drive.publicName,
    version: drive.version,
    snapshotLabel: drive.snapshotLabel,
    runId: drive.runId,
    status: drive.status,
    startedAt: drive.startedAt,
    runStatus,
    ...(drive.finishedAt !== undefined ? { finishedAt: drive.finishedAt } : {}),
    ...(drive.rollbackReason ? { rollbackReason: drive.rollbackReason } : {}),
    ...(drive.lastError ? { lastError: drive.lastError } : {}),
  };
  if (report) {
    view.report = {
      status: report.status,
      ...(report.meta.costUsd !== undefined ? { costUsd: report.meta.costUsd } : {}),
      ...(report.meta.durationMs !== undefined ? { durationMs: report.meta.durationMs } : {}),
      ...(report.meta.model ? { model: report.meta.model } : {}),
      providers: report.meta.providers,
      steps: report.steps.slice(0, 100),
      artifacts: report.artifacts,
      couldNotDo: report.couldNotDo,
      shots: report.shots.length,
    };
  }
  return view;
}

/**
 * Advance a "running" drive once its run report exists: a finished run
 * becomes "awaiting-decision"; a failed/cancelled run is rolled back on the
 * spot (its restore failure is recorded, never thrown).
 */
async function finalizeDriveIfNeeded(
  drive: TestDriveRecord,
  userId: string,
): Promise<TestDriveRecord> {
  // Every caller holds the user's Test-Drive lock, so this re-read sees the
  // record as the last transition behind that lock left it — never a
  // concurrently-moving mid-transition state.
  const current = getTestDrive(drive.id) ?? drive;
  if (current.status !== "running") return current;
  const report = readRunReport(drive.runId);
  if (!report) return drive;
  if (report.status === "finished") {
    return (
      updateTestDrive(drive.id, { status: "awaiting-decision", finishedAt: report.finishedAt }) ??
      drive
    );
  }
  try {
    await getVmManager().restore(userId, drive.snapshotLabel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      updateTestDrive(drive.id, {
        lastError: `Automatic roll-back after the failed drive run failed: ${message}`,
      }) ?? drive
    );
  }
  return (
    updateTestDrive(drive.id, {
      status: "rolled-back",
      rollbackReason: "run-failed",
      finishedAt: report.finishedAt,
    }) ?? drive
  );
}

/** Roll back one abandoned drive; returns false when the restore failed. */
async function rollbackAbandoned(drive: TestDriveRecord): Promise<boolean> {
  try {
    await getVmManager().restore(drive.userId, drive.snapshotLabel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTestDrive(drive.id, {
      lastError: `Superseded roll-back failed (retry it from the drive list): ${message}`,
    });
    return false;
  }
  updateTestDrive(drive.id, { status: "rolled-back", rollbackReason: "superseded" });
  return true;
}

/**
 * Background sweeper entry point for this route: roll back the caller's
 * stale awaiting-decision drives (all items, not just this one — the
 * abandonment is a per-user VM-state problem, and the item in the path is
 * only how the endpoint is reached). Best-effort and non-throwing: a
 * sweep failure must never fail a read.
 */
async function sweepStaleDrives(userId: string): Promise<void> {
  try {
    await sweepAbandonedDrives(userId, (drive) =>
      getVmManager().restore(drive.userId, drive.snapshotLabel),
    );
  } catch {
    /* the sweep is best-effort; the read it rides on still succeeds */
  }
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return unauthorized();
  let id: string;
  try {
    id = await routeParam(context);
  } catch {
    return jsonError("Invalid request id.", 400);
  }
  const driveId = new URL(req.url).searchParams.get("driveId") ?? "";
  // A GET drives VM transitions (the sweep + finalize), so it must not run
  // concurrently with a locked keep/rollback/start: the lock is what keeps a
  // background restore from wiping a drive the user is keeping.
  return withUserLock(user, async () => {
    if (driveId) {
      const drive = getTestDrive(driveId);
      if (!drive || drive.userId !== user || drive.publicId !== id) {
        return jsonError("Test-drive not found.", 404);
      }
      await sweepStaleDrives(user);
      const finalized = await finalizeDriveIfNeeded(drive, user);
      return NextResponse.json({ drive: driveView(finalized, user) }, { headers: NO_STORE });
    }
    await sweepStaleDrives(user);
    const drives = listTestDrivesForUser(user)
      .filter((drive) => drive.publicId === id)
      .slice(0, 10);
    const views: TestDriveView[] = [];
    for (const drive of drives) {
      const finalized = await finalizeDriveIfNeeded(drive, user);
      views.push(driveView(finalized, user));
    }
    return NextResponse.json({ drives: views }, { headers: NO_STORE });
  });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const user = caller(req);
  if (!user) return unauthorized();
  let id: string;
  try {
    id = await routeParam(context);
  } catch {
    return jsonError("Invalid request id.", 400);
  }
  const record = findPublicItem(id);
  if (!record) return jsonError("Item not found.", 404);
  if (record.moderation === "unpublished" && record.ownerId !== user) {
    return jsonError("Item not found.", 404);
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    return errorResponse(error);
  }
  if (!isRecord(body)) return jsonError("Body must be a JSON object.", 400);
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";

  if (action === "keep" || action === "rollback") {
    return withUserLock(user, async () => {
      const driveId = typeof body.driveId === "string" ? body.driveId : "";
      if (!driveId) return jsonError("driveId is required.", 400);
      const drive = getTestDrive(driveId);
      if (!drive || drive.userId !== user || drive.publicId !== id) {
        return jsonError("Test-drive not found.", 404);
      }
      const finalized = await finalizeDriveIfNeeded(drive, user);
      if (finalized.status === "rolled-back") {
        // A failed run already auto-rolled this back; the decision is moot.
        return NextResponse.json({ drive: driveView(finalized, user) }, { headers: NO_STORE });
      }
      if (finalized.status !== "awaiting-decision") {
        return jsonError(
          finalized.status === "running"
            ? "The test-drive run is still going. Wait for it to finish before keeping or rolling back."
            : `This test-drive is already ${finalized.status}.`,
          409,
        );
      }
      if (action === "keep") {
        const kept =
          updateTestDrive(finalized.id, { status: "kept", finishedAt: Date.now() }) ?? finalized;
        return NextResponse.json({ drive: driveView(kept, user) }, { headers: NO_STORE });
      }
      try {
        await getVmManager().restore(user, finalized.snapshotLabel);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not restore the snapshot.";
        updateTestDrive(finalized.id, { lastError: `Roll-back failed: ${message}` });
        return jsonError(`Roll-back failed: ${message}`, 500);
      }
      const rolled =
        updateTestDrive(finalized.id, {
          status: "rolled-back",
          rollbackReason: "user",
          finishedAt: Date.now(),
        }) ?? finalized;
      return NextResponse.json({ drive: driveView(rolled, user) }, { headers: NO_STORE });
    });
  }

  if (action === "sweep") {
    return withUserLock(user, async () => {
      const result = await sweepAbandonedDrives(user, (drive) =>
        getVmManager().restore(drive.userId, drive.snapshotLabel),
      );
      return NextResponse.json(result, { headers: NO_STORE });
    });
  }

  if (action !== "start") {
    return jsonError('action must be "start", "keep", "rollback", or "sweep".', 400);
  }

  // --- start: snapshot first, run second, never the other way round. ---
  return withUserLock(user, async () => {
    const active = getRuntimeManager()
      .list(user)
      .some((run) => run.status === "running" || run.status === "queued");
    if (active) {
      return jsonError(
        "Finish or cancel your current run first — a test-drive snapshots your VM, and it must not capture a run in progress.",
        409,
      );
    }

    const version = latestVersion(record);
    const label = testDriveSnapshotLabel();
    const vm = getVmManager();
    const userPrompt =
      typeof body.prompt === "string" && body.prompt.trim()
        ? body.prompt.trim().slice(0, MAX_PROMPT_LEN)
        : undefined;

    // Abandoned drives (user never chose keep/rollback) are rolled back now.
    for (const old of listTestDrivesForUser(user)) {
      if (old.status === "awaiting-decision") await rollbackAbandoned(old);
    }

    try {
      await vm.snapshot(user, label);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not snapshot your VM.";
      return jsonError(`Could not snapshot your VM before the test-drive: ${message}`, 500);
    }

    const prompt = testDrivePrompt({
      publicId: record.id,
      name: record.name,
      kind: record.kind,
      version: version.version,
      payload: version.payload,
      ...(userPrompt ? { userPrompt } : {}),
    });
    const started = getRuntimeManager().start(user, { prompt, freshSession: true });
    if (!started.accepted) {
      // Nothing ran — restore the snapshot immediately so the VM is untouched.
      try {
        await vm.restore(user, label);
      } catch {
        /* best effort: the snapshot remains for a manual restore */
      }
      return jsonError(started.error ?? "Could not start the test-drive run.", 400);
    }

    const drive = createTestDrive({
      userId: user,
      publicId: record.id,
      publicName: record.name,
      version: version.version,
      snapshotLabel: label,
      runId: started.runId,
    });
    return NextResponse.json(
      { drive: driveView(drive, user), runId: started.runId, snapshotLabel: label, queued: started.queued },
      { status: 201, headers: NO_STORE },
    );
  });
}
