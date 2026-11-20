import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRunToRestore, runClockFromEpoch } from "./restoreRun";

test("reconnect-while-running: prefers an active running run over newer finished runs", () => {
  const selected = pickRunToRestore([
    { runId: "run_done", status: "finished", prompt: "done", createdAt: 3000 },
    { runId: "run_live", status: "running", prompt: "still going", createdAt: 2000 },
    { runId: "run_old", status: "finished", prompt: "old", createdAt: 1000 },
  ]);

  assert.deepEqual(selected, {
    runId: "run_live",
    prompt: "still going",
    createdAt: 2000,
    finishedAt: undefined,
    active: true,
  });
});

test("reconnect-while-running: treats queued as active", () => {
  const selected = pickRunToRestore([
    { runId: "run_q", status: "queued", prompt: "waiting", createdAt: 5000 },
    { runId: "run_done", status: "finished", prompt: "done", createdAt: 4000 },
  ]);

  assert.equal(selected?.runId, "run_q");
  assert.equal(selected?.active, true);
});

test("reconnect-after-finish: selects the most recent run when none are active", () => {
  const selected = pickRunToRestore([
    { runId: "run_new", status: "finished", prompt: "latest", createdAt: 3000, finishedAt: 4500 },
    { runId: "run_err", status: "error", prompt: "err", createdAt: 2000, finishedAt: 2500 },
    { runId: "run_old", status: "cancelled", prompt: "old", createdAt: 1000 },
  ]);

  assert.deepEqual(selected, {
    runId: "run_new",
    prompt: "latest",
    createdAt: 3000,
    finishedAt: 4500,
    active: false,
  });
});

test("returns null when there are no runs to restore", () => {
  assert.equal(pickRunToRestore([]), null);
  assert.equal(pickRunToRestore([{ runId: "", status: "running" }]), null);
});

test("runClockFromEpoch converts createdAt epoch ms into the performance clock", () => {
  const clock = runClockFromEpoch({
    createdAt: 1_000,
    active: true,
    nowEpochMs: 5_000,
    nowPerfMs: 800,
  });

  assert.equal(clock.runStart, -3200);
  assert.equal(clock.runEnd, undefined);
});

test("runClockFromEpoch anchors missing createdAt to now so the run is present", () => {
  const clock = runClockFromEpoch({
    active: true,
    nowEpochMs: 5_000,
    nowPerfMs: 800,
  });

  assert.equal(clock.runStart, 800);
  assert.equal(clock.runEnd, undefined);
});

test("runClockFromEpoch prefers the run's real finishedAt for finished runs", () => {
  const clock = runClockFromEpoch({
    createdAt: 1_000,
    finishedAt: 4_500,
    active: false,
    nowEpochMs: 9_000,
    nowPerfMs: 2_000,
  });

  assert.equal(clock.runStart, -6000);
  assert.equal(clock.runEnd, -2500);
  assert.equal((clock.runEnd ?? 0) - clock.runStart, 3500);
});
