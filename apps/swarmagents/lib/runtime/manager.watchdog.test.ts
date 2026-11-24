/**
 * Watchdog recovery (Daemon Piece 4): a stuck run with a recorded resume
 * point is restored from its checkpoint and resumed instead of erroring, up
 * to a bounded number of attempts; everything else keeps today's
 * finalize-as-error behavior.
 *
 * The wedge is simulated with a VM driver whose claude exec blocks until
 * aborted and produces no telemetry — exactly the silent-exec failure the
 * watchdog exists to break. Thresholds are shrunk via the manager's existing
 * watchdog options so a "stuck" run is declared in milliseconds.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager, type RunSummary } from "./manager";
import { RunStateStore } from "./durable-queue";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus, type TelemetryEvent } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import { getRun } from "./run-store";
import { checkpointVmLabel } from "./checkpoints";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Claude blocks until aborted on every call: the run wedges, then wedges again. */
class BlockingVmDriver extends FakeVmDriver {
  calls: string[][] = [];
  restores: string[] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.calls.push(cmd);
    return new Promise<ExecResult>((resolve) => {
      if (opts?.signal?.aborted) {
        resolve({ exitCode: 130 });
        return;
      }
      opts?.signal?.addEventListener("abort", () => resolve({ exitCode: 130 }), { once: true });
    });
  }

  override async restore(handle: VmHandle, label: string): Promise<void> {
    this.restores.push(label);
    return super.restore(handle, label);
  }
}

/** First claude call blocks until aborted (the wedge); later calls finish fast. */
class WedgeOnceVmDriver extends BlockingVmDriver {
  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude" && this.calls.length >= 1) {
      this.calls.push(cmd);
      return FakeVmDriver.prototype.exec.call(this, handle, cmd, opts);
    }
    return super.exec(handle, cmd, opts);
  }
}

/** Bus that explodes on run.recovering: recovery must fall back, not crash the sweep. */
class RecoveringThrowBus extends TelemetryBus {
  override publish(runId: string, event: TelemetryEvent) {
    if (event.type === "run.recovering") throw new Error("bus exploded");
    return super.publish(runId, event);
  }
}

async function waitFor(
  manager: RuntimeManager,
  userId: string,
  pred: (runs: RunSummary[]) => boolean,
  steps = 600,
): Promise<RunSummary[]> {
  for (let i = 0; i < steps; i++) {
    const runs = manager.list(userId);
    if (pred(runs)) return runs;
    await sleep(10);
  }
  throw new Error("timed out waiting for run state");
}

async function waitForCalls(driver: { calls: string[][] }, count: number, steps = 400): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (driver.calls.length >= count) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${count} claude calls`);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-watchdog-"));
}

/** run.recovering events recorded for a run, in log order. */
function recoveringEvents(runId: string, runsDir: string): Array<{ attempt?: number; reason?: string }> {
  const run = getRun(runId, runsDir);
  return (run?.events ?? [])
    .filter((event) => event.type === "run.recovering")
    .map((event) => event as unknown as { attempt?: number; reason?: string });
}

/** Watchdog thresholds shrunk so a silent run is declared stuck in ~300ms. */
const FAST_WATCHDOG = { startGraceMs: 300, silenceMs: 300, watchdogSweepMs: 25 } as const;

/**
 * Start a run and record a resume point on it (ask-level approval in
 * full-auto mode fires the auto-checkpoint, exactly as in the restart
 * tests). Returns the checkpoint's VM snapshot label.
 */
async function startCheckpointedRun(
  manager: RuntimeManager,
  store: RunStateStore,
  driver: BlockingVmDriver,
  userId: string,
  sessionId: string,
): Promise<{ runId: string; vmLabel: string }> {
  const active = manager.start(userId, {
    prompt: "do risky work with checkpoints",
    sessionId,
    fullAuto: true,
  });
  assert.equal(active.accepted, true);
  await waitForCalls(driver, 1);
  const verdict = await manager.requestToolApproval(userId, active.runId, "Bash", {
    command: "sudo apt-get install -y jq",
  });
  assert.equal(verdict.decision, "allow");
  const resumePoint = store.load().users[userId]?.active?.resumePoint;
  assert.ok(resumePoint, "auto-checkpoint should record a resume point");
  assert.equal(resumePoint.sessionId, sessionId);
  return { runId: active.runId, vmLabel: checkpointVmLabel(active.runId, resumePoint.stepSeq) };
}

test("watchdog: silent run with a resume point is recovered from its checkpoint and finishes", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new WedgeOnceVmDriver();
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
      ...FAST_WATCHDOG,
    });

    const { runId, vmLabel } = await startCheckpointedRun(
      manager,
      store,
      driver,
      "alice",
      "sess_watchdog_test",
    );

    // The run wedges (blocked exec, no telemetry). The watchdog must recover
    // it: restore the checkpoint, resume the recorded session, and let the
    // second attempt finish — not finalize the run as an error.
    const runs = await waitFor(
      manager,
      "alice",
      (all) => all.find((run) => run.runId === runId)?.status === "finished",
    );
    assert.equal(runs.find((run) => run.runId === runId)?.status, "finished");

    // Exactly one recovery, attempt 1, carrying the watchdog reason.
    const recovering = recoveringEvents(runId, runsDir);
    assert.equal(recovering.length, 1);
    assert.equal(recovering[0].attempt, 1);
    assert.match(recovering[0].reason ?? "", /stopped by the watchdog$/);

    // The checkpoint was restored and the recorded session resumed.
    assert.deepEqual(driver.restores, [vmLabel]);
    assert.equal(driver.calls.length, 2);
    const resumedCall = driver.calls[1];
    assert.ok(resumedCall.includes("--resume"), "recovered run should pass --resume to claude");
    assert.ok(resumedCall.includes("sess_watchdog_test"));

    // The durable summary never flipped to error.
    const log = getRun(runId, runsDir);
    assert.ok(log);
    assert.equal(log.summary.status, "finished");
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog: attempts exhausted finalizes as error with today's reason", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new BlockingVmDriver();
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
      ...FAST_WATCHDOG,
      maxRecoveryAttempts: 2,
    });

    const { runId } = await startCheckpointedRun(manager, store, driver, "alice", "sess_exhaust_test");

    // Wedge -> recover 1 -> wedge -> recover 2 -> wedge -> error. No fourth
    // resurrection: the bound is hard.
    const runs = await waitFor(
      manager,
      "alice",
      (all) => all.find((run) => run.runId === runId)?.status === "error",
    );
    const summary = runs.find((run) => run.runId === runId);
    assert.equal(summary?.status, "error");
    assert.match(summary?.error ?? "", /stopped by the watchdog$/);

    const recovering = recoveringEvents(runId, runsDir);
    assert.deepEqual(
      recovering.map((event) => event.attempt),
      [1, 2],
    );
    assert.equal(driver.calls.length, 3, "initial attempt plus two recoveries, then no more");

    const log = getRun(runId, runsDir);
    assert.ok(log);
    assert.equal(log.summary.status, "error");
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog: stuck run without a resume point keeps today's error path", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new BlockingVmDriver();
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
      ...FAST_WATCHDOG,
    });

    // No checkpoint is ever recorded: nothing safe to resume.
    const active = manager.start("alice", { prompt: "wedge with no checkpoint" });
    assert.equal(active.accepted, true);
    await waitForCalls(driver, 1);

    const runs = await waitFor(
      manager,
      "alice",
      (all) => all.find((run) => run.runId === active.runId)?.status === "error",
    );
    assert.match(runs.find((run) => run.runId === active.runId)?.error ?? "", /stopped by the watchdog$/);
    assert.equal(recoveringEvents(active.runId, runsDir).length, 0);
    assert.equal(driver.calls.length, 1, "no recovery attempt without a resume point");
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog: maxRecoveryAttempts 0 disables recovery entirely", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new WedgeOnceVmDriver();
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
      ...FAST_WATCHDOG,
      maxRecoveryAttempts: 0,
    });

    const { runId } = await startCheckpointedRun(manager, store, driver, "alice", "sess_disabled_test");

    const runs = await waitFor(
      manager,
      "alice",
      (all) => all.find((run) => run.runId === runId)?.status === "error",
    );
    assert.match(runs.find((run) => run.runId === runId)?.error ?? "", /stopped by the watchdog$/);
    assert.equal(recoveringEvents(runId, runsDir).length, 0);
    assert.equal(driver.calls.length, 1);
    assert.deepEqual(driver.restores, []);
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog: a user-cancelled run is never resurrected", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new WedgeOnceVmDriver();
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
      ...FAST_WATCHDOG,
    });

    const { runId } = await startCheckpointedRun(manager, store, driver, "alice", "sess_cancel_test");

    // Cancel before the watchdog fires; several sweep windows pass with the
    // run already terminal.
    const cancelled = manager.cancel("alice", runId);
    assert.equal(cancelled.ok, true);
    await sleep(900);

    const summary = manager.list("alice").find((run) => run.runId === runId);
    assert.equal(summary?.status, "cancelled");
    assert.equal(recoveringEvents(runId, runsDir).length, 0);
    assert.equal(driver.calls.length, 1, "cancelled run must not be restarted");
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog: a recovery error falls back to error finalization and the sweep survives", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  const bus = new RecoveringThrowBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new BlockingVmDriver();
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
      ...FAST_WATCHDOG,
    });

    // Alice is recoverable (checkpointed) but her recovery throws on the
    // run.recovering publish; bob has no resume point. Alice is started
    // first so her failed recovery is processed first: bob must still be
    // finalized by the sweep, and alice must fall back to today's error.
    const { runId: aliceRunId } = await startCheckpointedRun(
      manager,
      store,
      driver,
      "alice",
      "sess_throw_test",
    );
    const bob = manager.start("bob", { prompt: "wedge with no checkpoint" });
    assert.equal(bob.accepted, true);
    await waitForCalls(driver, 2);

    const aliceRuns = await waitFor(
      manager,
      "alice",
      (all) => all.find((run) => run.runId === aliceRunId)?.status === "error",
    );
    assert.match(aliceRuns.find((run) => run.runId === aliceRunId)?.error ?? "", /stopped by the watchdog$/);

    const bobRuns = await waitFor(
      manager,
      "bob",
      (all) => all.find((run) => run.runId === bob.runId)?.status === "error",
    );
    assert.match(bobRuns.find((run) => run.runId === bob.runId)?.error ?? "", /stopped by the watchdog$/);

    assert.equal(recoveringEvents(aliceRunId, runsDir).length, 0, "the throwing publish recorded nothing");
    assert.equal(driver.calls.length, 2, "neither run was restarted");
  } finally {
    manager?.cancel("alice");
    manager?.cancel("bob");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog: recovery attempts persist across a server restart", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateA = path.join(dir, "state-a.json");
  const stateB = path.join(dir, "state-b.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let managerA: RuntimeManager | undefined;
  let managerB: RuntimeManager | undefined;

  try {
    const driverA = new BlockingVmDriver();
    const storeA = new RunStateStore({ filePath: stateA });
    managerA = new RuntimeManager({
      vm: new VmManager({ customDriver: driverA }),
      bus,
      router: null,
      stateStore: storeA,
      ...FAST_WATCHDOG,
      maxRecoveryAttempts: 2,
    });

    const { runId, vmLabel } = await startCheckpointedRun(
      managerA,
      storeA,
      driverA,
      "alice",
      "sess_restart_attempts",
    );

    // First wedge -> recovery #1 on process A. The durable snapshot must
    // carry the spent attempt.
    await waitForCalls(driverA, 2);
    const snapshotA = storeA.load();
    assert.equal(snapshotA.users.alice?.active?.runId, runId);
    assert.equal(snapshotA.users.alice?.active?.recoveryAttempts, 1);

    // "Restart": a fresh manager over a copy of the durable state. The VM
    // snapshot survives in the (persistent) driver, like production.
    fs.copyFileSync(stateA, stateB);
    const driverB = new BlockingVmDriver();
    const vmB = new VmManager({ customDriver: driverB });
    await vmB.snapshot("alice", vmLabel);
    managerB = new RuntimeManager({
      vm: vmB,
      bus,
      router: null,
      stateStore: new RunStateStore({ filePath: stateB }),
      ...FAST_WATCHDOG,
      maxRecoveryAttempts: 2,
    });
    // Stop process A's copy of the run so only B drives it from here.
    managerA.cancel("alice", runId);

    // B resumes the run (restart-resume), it wedges again, B spends the one
    // remaining recovery (attempt 2), it wedges a final time, and the bound
    // — carried across the restart — finalizes it as an error.
    const runs = await waitFor(
      managerB,
      "alice",
      (all) => all.find((run) => run.runId === runId)?.status === "error",
    );
    assert.match(runs.find((run) => run.runId === runId)?.error ?? "", /stopped by the watchdog$/);
    assert.deepEqual(
      recoveringEvents(runId, runsDir).map((event) => event.attempt),
      [1, 2],
      "attempts continue across the restart instead of resetting",
    );
  } finally {
    managerA?.cancel("alice");
    managerB?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
