/**
 * Restart durability: the active run is aborted cleanly, queued prompts and
 * approvals survive, and a graceful shutdown no longer discards the queue.
 *
 * The "restart" is simulated by copying the durable snapshot mid-run and
 * building a fresh RuntimeManager over the copy, which is exactly what a new
 * process does at startup (the first manager stays blocked in its VM exec).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RuntimeManager,
  getRuntimeManager,
  setRuntimeManagerForTesting,
  type RunSummary,
} from "./manager";
import { RunStateStore } from "./durable-queue";
import { VmManager, vmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus } from "../telemetry/bus";
import { telemetryBus } from "../telemetry/index";
import { configureRunsDir } from "../telemetry/paths";
import { ORPHANED_RUN_REASON, getRun } from "./run-store";
import { checkpointVmLabel } from "./checkpoints";
import { ApprovalStore, setApprovalStoreForTesting } from "../harness/approvals";
import type { ExecOptions, ExecResult, VmDriver, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Claude blocks until aborted: the simulated process never finishes on its own. */
class BlockingVmDriver extends FakeVmDriver {
  calls: string[][] = [];

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
}

/** Claude finishes immediately from the benign recorded transcript. */
class FastVmDriver extends FakeVmDriver {
  calls: string[][] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") this.calls.push(cmd);
    return super.exec(handle, cmd, opts);
  }
}

/** Fast driver that records every VM snapshot restore label. */
class RecordingFastVmDriver extends FastVmDriver {
  restores: string[] = [];

  override async restore(handle: VmHandle, label: string): Promise<void> {
    this.restores.push(label);
    return super.restore(handle, label);
  }
}

async function waitFor(
  manager: RuntimeManager,
  userId: string,
  pred: (runs: RunSummary[]) => boolean,
  steps = 400,
): Promise<RunSummary[]> {
  for (let i = 0; i < steps; i++) {
    const runs = manager.list(userId);
    if (pred(runs)) return runs;
    await sleep(10);
  }
  throw new Error("timed out waiting for run state");
}

async function waitForCalls(driver: { calls: string[][] }, count: number, steps = 200): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (driver.calls.length >= count) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${count} claude calls`);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-restart-"));
}

/**
 * Shared scaffolding for the restart tests: one manager over durable
 * state (the "first process"), plus the copy-and-rebuild step that
 * simulates the next process. Six tests repeat this setup; the helper
 * keeps the per-test bodies to what each test actually asserts.
 */
interface RestartPair {
  dir: string;
  runsDir: string;
  stateA: string;
  stateB: string;
  approvalsA: string;
  approvalsB: string;
  bus: TelemetryBus;
  driverA: BlockingVmDriver;
  storeA: RunStateStore;
  approvalStoreA: ApprovalStore | undefined;
  managerA: RuntimeManager;
  cleanup(managerB?: RuntimeManager): void;
}

function beginRestartPair(withApprovals: boolean): RestartPair {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateA = path.join(dir, "state-a.json");
  const stateB = path.join(dir, "state-b.json");
  const approvalsA = path.join(dir, "approvals-a.json");
  const approvalsB = path.join(dir, "approvals-b.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  const driverA = new BlockingVmDriver();
  const storeA = new RunStateStore({ filePath: stateA });
  const approvalStoreA = withApprovals
    ? new ApprovalStore({ persistPath: approvalsA, ttlMs: 60_000 })
    : undefined;
  if (approvalStoreA) setApprovalStoreForTesting(approvalStoreA);
  const managerA = new RuntimeManager({
    vm: new VmManager({ customDriver: driverA }),
    bus,
    router: null,
    stateStore: storeA,
  });
  return {
    dir,
    runsDir,
    stateA,
    stateB,
    approvalsA,
    approvalsB,
    bus,
    driverA,
    storeA,
    approvalStoreA,
    managerA,
    cleanup(managerB?: RuntimeManager): void {
      managerA.cancel("alice");
      managerB?.cancel("alice");
      configureRunsDir(null);
      setApprovalStoreForTesting(null);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * "Restart": copy the durable snapshot to the B side and build a fresh
 * manager over it. Synchronous on purpose: the restored run starts on a
 * deferred microtask after construction, so an await here would let that
 * tick fire before the test's synchronous assertions (FIX-35). Tests that
 * need the new VM snapshotted first (the resume-point tests) create vmB,
 * await its snapshot, and pass it in.
 */
function restartPair(
  pair: RestartPair,
  driverB: FakeVmDriver,
  vmB?: VmManager,
): { driverB: FakeVmDriver; managerB: RuntimeManager; approvalStoreB: ApprovalStore | undefined } {
  fs.copyFileSync(pair.stateA, pair.stateB);
  if (pair.approvalStoreA) fs.copyFileSync(pair.approvalsA, pair.approvalsB);
  const managerVm = vmB ?? new VmManager({ customDriver: driverB });
  const approvalStoreB = pair.approvalStoreA
    ? new ApprovalStore({ persistPath: pair.approvalsB, ttlMs: 60_000 })
    : undefined;
  if (approvalStoreB) setApprovalStoreForTesting(approvalStoreB);
  const managerB = new RuntimeManager({
    vm: managerVm,
    bus: pair.bus,
    router: null,
    stateStore: new RunStateStore({ filePath: pair.stateB }),
  });
  return { driverB, managerB, approvalStoreB };
}

test("restart: queued prompt survives, active run aborts cleanly, pending approval expires explicitly", async () => {
  const pair = beginRestartPair(true);
  const approvalStoreA = pair.approvalStoreA;
  assert.ok(approvalStoreA);
  const { bus, driverA, storeA, managerA } = pair;
  const runsDir = pair.runsDir;
  let managerB: RuntimeManager | undefined;

  try {
    const active = managerA.start("alice", { prompt: "long active prompt" });
    assert.equal(active.accepted, true);
    assert.equal(active.queued, false);

    const queued = managerA.start("alice", { prompt: "queued follow-up prompt" });
    assert.equal(queued.accepted, true);
    assert.equal(queued.queued, true);
    assert.equal(queued.position, 1);

    await waitForCalls(driverA, 1);
    const approval = approvalStoreA.create({
      runId: active.runId,
      userId: "alice",
      toolName: "Bash",
      action: "rm -rf build",
      reason: "destructive command",
    });
    assert.equal(approvalStoreA.get(approval.id)?.status, "pending");

    // The persisted snapshot is what the next process sees. Copy it while it
    // still names the active run and the queued prompt.
    const snapshot = storeA.load();
    assert.equal(snapshot.users.alice.active?.runId, active.runId);
    assert.deepEqual(snapshot.users.alice.queue.map((run) => run.prompt), [
      "queued follow-up prompt",
    ]);
    // "Restart": a fresh manager over the copied durable state.
    const driverB = new FastVmDriver();
    const { managerB: restarted, approvalStoreB } = restartPair(pair, driverB);
    managerB = restarted;

    // The interrupted run is visibly failed, not silently vanished.
    const interrupted = getRun(active.runId, runsDir);
    assert.ok(interrupted);
    assert.equal(interrupted.summary.status, "error");
    assert.equal(interrupted.summary.error, ORPHANED_RUN_REASON);

    // The approval record survived, and its outcome is an explicit restart
    // expiry — never a user denial and never a TTL surprise.
    assert.ok(approvalStoreB, "restart preserves the approval store");
    const recovered = approvalStoreB.get(approval.id);
    assert.ok(recovered, "approval record should survive the restart");
    assert.equal(recovered.status, "expired");
    assert.equal(recovered.expiredReason, "server_restart");
    assert.notEqual(recovered.status, "denied");

    // The queued prompt runs to completion on the new process.
    const runs = await waitFor(
      managerB,
      "alice",
      (all) => all.length > 0 && all.every((run) => run.status !== "running" && run.status !== "queued"),
    );
    const followUp = runs.find((run) => run.runId === queued.runId);
    assert.ok(followUp, "queued run should be restored and started");
    assert.equal(followUp.status, "finished");

    // The snapshot was normalized: no stale active run, no stale queue.
    const after = new RunStateStore({ filePath: pair.stateB }).load();
    assert.equal(after.users.alice, undefined);
  } finally {
    pair.cleanup(managerB);
  }
});

test("graceful shutdown preserves the queue instead of cancelling it", async () => {
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
    });

    const active = manager.start("alice", { prompt: "active" });
    const queued = manager.start("alice", { prompt: "still queued after deploy" });
    assert.equal(active.queued, false);
    assert.equal(queued.queued, true);

    const cancelled = manager.cancelAll("shutdown");
    assert.deepEqual(cancelled, [active.runId]);

    const snapshot = store.load();
    assert.equal(snapshot.users.alice.active, null);
    assert.equal(snapshot.users.alice.queue.length, 1);
    assert.equal(snapshot.users.alice.queue[0].runId, queued.runId);
    assert.equal(snapshot.users.alice.queue[0].prompt, "still queued after deploy");

    // The active run was still cancelled with the shutdown reason.
    const summary = manager.list("alice").find((run) => run.runId === active.runId);
    assert.equal(summary?.status, "cancelled");
    assert.equal(summary?.cancelledReason, "shutdown");
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-checkpoint records and persists the resume point in runtime state", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state-checkpoint.json");
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
    });

    const active = manager.start("alice", {
      prompt: "do risky work with checkpoints",
      sessionId: "sess_resume_test",
      fullAuto: true,
    });
    assert.equal(active.accepted, true);

    await waitForCalls(driver, 1);

    // Initial persisted state has no resumePoint yet
    const snapshotBefore = store.load();
    assert.equal(snapshotBefore.users.alice?.active?.runId, active.runId);
    assert.equal(snapshotBefore.users.alice?.active?.resumePoint, undefined);

    // Trigger an ask-level approval in full-auto mode -> takeAutoCheckpoint fires
    const verdict = await manager.requestToolApproval(
      "alice",
      active.runId,
      "Bash",
      { command: "sudo apt-get install -y jq" },
    );
    assert.equal(verdict.decision, "allow");

    // The persisted state must now carry the resume point
    const snapshotAfter = store.load();
    assert.equal(snapshotAfter.users.alice?.active?.runId, active.runId);
    assert.ok(snapshotAfter.users.alice?.active?.resumePoint);
    assert.equal(snapshotAfter.users.alice.active.resumePoint.runId, active.runId);
    assert.match(snapshotAfter.users.alice.active.resumePoint.checkpointLabel, /^auto-pre-step-\d+$/);
    assert.ok(snapshotAfter.users.alice.active.resumePoint.stepSeq > 0);
    assert.equal(snapshotAfter.users.alice.active.resumePoint.sessionId, "sess_resume_test");
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restart: run with a recorded resume point resumes from its checkpoint", async () => {
  const pair = beginRestartPair(true);
  const approvalStoreA = pair.approvalStoreA;
  assert.ok(approvalStoreA);
  const { bus, driverA, storeA, managerA } = pair;
  const runsDir = pair.runsDir;
  let managerB: RuntimeManager | undefined;

  try {
    const active = managerA.start("alice", {
      prompt: "do risky work with checkpoints",
      sessionId: "sess_resume_test",
      fullAuto: true,
    });
    assert.equal(active.accepted, true);
    await waitForCalls(driverA, 1);

    // Ask-level approval in full-auto mode -> takeAutoCheckpoint records
    // the resume point in the persisted snapshot.
    const verdict = await managerA.requestToolApproval(
      "alice",
      active.runId,
      "Bash",
      { command: "sudo apt-get install -y jq" },
    );
    assert.equal(verdict.decision, "allow");

    const snapshot = storeA.load();
    const resumePoint = snapshot.users.alice?.active?.resumePoint;
    assert.ok(resumePoint);
    assert.equal(resumePoint.sessionId, "sess_resume_test");
    const vmLabel = checkpointVmLabel(active.runId, resumePoint.stepSeq);

    // A second approval, still pending when the process dies: it must
    // re-surface after the resume instead of expiring.
    const pending = approvalStoreA.create({
      runId: active.runId,
      userId: "alice",
      toolName: "Bash",
      action: "rm -rf build",
      reason: "destructive command",
    });
    assert.equal(approvalStoreA.get(pending.id)?.status, "pending");

    const queued = managerA.start("alice", { prompt: "queued follow-up prompt" });
    assert.equal(queued.accepted, true);
    assert.equal(queued.queued, true);

    // "Restart": a fresh manager over the copied durable state. The VM
    // snapshot survives in the (persistent) driver, like production.
    const driverB = new RecordingFastVmDriver();
    const vmB = new VmManager({ customDriver: driverB });
    await vmB.snapshot("alice", vmLabel);
    const { managerB: restarted, approvalStoreB } = restartPair(pair, driverB, vmB);
    managerB = restarted;

    // The restart itself must leave the pending approval pending: check
    // synchronously, before any await lets the fast resumed run finish
    // (finalize() legitimately expires leftover approvals at run end, so
    // a later read would see "expired" even though the restart preserved
    // it — that is the run-end cleanup, not a restart expiry).
    assert.ok(approvalStoreB, "restart preserves the approval store");
    const recovered = approvalStoreB.get(pending.id);
    assert.ok(recovered, "approval record should survive the restart");
    assert.equal(recovered.status, "pending");

    // The resumed run continued its recorded session instead of re-running
    // the prompt: the claude argv carries --resume + the session id. The
    // restore runs before the spawn, so by the first call it has happened.
    await waitForCalls(driverB, 1);
    assert.deepEqual(driverB.restores, [vmLabel]);
    const resumedCall = driverB.calls.find((cmd) => cmd.includes("--resume"));
    assert.ok(resumedCall, "resumed run should pass --resume to claude");
    assert.ok(resumedCall.includes("sess_resume_test"));

    // The interrupted run was NOT finalized as an error.
    const resumed = getRun(active.runId, runsDir);
    assert.ok(resumed);
    assert.notEqual(resumed.summary.status, "error");

    // Both the resumed run and the queued follow-up finish.
    const runs = await waitFor(
      managerB,
      "alice",
      (all) => all.length > 0 && all.every((run) => run.status !== "running" && run.status !== "queued"),
    );
    const resumedSummary = runs.find((run) => run.runId === active.runId);
    assert.ok(resumedSummary, "resumed run should be listed");
    assert.equal(resumedSummary.status, "finished");
    const followUp = runs.find((run) => run.runId === queued.runId);
    assert.ok(followUp, "queued run should be restored and started");
    assert.equal(followUp.status, "finished");
  } finally {
    pair.cleanup(managerB);
  }
});

test("graceful shutdown suspends a checkpointed run instead of cancelling it", async () => {
  const pair = beginRestartPair(true);
  const approvalStoreA = pair.approvalStoreA;
  assert.ok(approvalStoreA);
  const { bus, driverA, storeA, managerA } = pair;
  const runsDir = pair.runsDir;
  let managerB: RuntimeManager | undefined;

  try {
    const active = managerA.start("alice", {
      prompt: "do risky work with checkpoints",
      sessionId: "sess_shutdown_test",
      fullAuto: true,
    });
    assert.equal(active.accepted, true);
    await waitForCalls(driverA, 1);
    const verdict = await managerA.requestToolApproval(
      "alice",
      active.runId,
      "Bash",
      { command: "sudo apt-get install -y jq" },
    );
    assert.equal(verdict.decision, "allow");
    const pending = approvalStoreA.create({
      runId: active.runId,
      userId: "alice",
      toolName: "Bash",
      action: "rm -rf build",
      reason: "destructive command",
    });
    assert.equal(approvalStoreA.get(pending.id)?.status, "pending");

    const snapshot = storeA.load();
    const resumePoint = snapshot.users.alice?.active?.resumePoint;
    assert.ok(resumePoint);
    const vmLabel = checkpointVmLabel(active.runId, resumePoint.stepSeq);

    // Graceful shutdown: the run is suspended, not cancelled. It stays in
    // the durable snapshot with its resume point, still lists as running,
    // and its approval stays pending.
    const cancelled = managerA.cancelAll("shutdown");
    assert.deepEqual(cancelled, [active.runId]);

    const afterShutdown = storeA.load();
    assert.ok(afterShutdown.users.alice?.active);
    assert.equal(afterShutdown.users.alice.active.runId, active.runId);
    assert.ok(afterShutdown.users.alice.active.resumePoint);
    const listed = managerA.list("alice").find((run) => run.runId === active.runId);
    assert.equal(listed?.status, "running");
    assert.equal(approvalStoreA.get(pending.id)?.status, "pending");
    const log = getRun(active.runId, runsDir);
    assert.ok(log);
    assert.equal(log.summary.status, "running");

    // The next process resumes it from the checkpoint.
    const driverB = new RecordingFastVmDriver();
    const vmB = new VmManager({ customDriver: driverB });
    await vmB.snapshot("alice", vmLabel);
    const { managerB: restarted, approvalStoreB } = restartPair(pair, driverB, vmB);
    managerB = restarted;

    // Same synchronous check as the restart test: the shutdown + restart
    // preserved the approval pending; the run finishing later expires it
    // via finalize(), which is the run-end cleanup, not a restart expiry.
    assert.ok(approvalStoreB, "restart preserves the approval store");
    assert.equal(approvalStoreB.get(pending.id)?.status, "pending");

    await waitForCalls(driverB, 1);
    assert.deepEqual(driverB.restores, [vmLabel]);
    const resumedCall = driverB.calls.find((cmd) => cmd.includes("--resume"));
    assert.ok(resumedCall, "resumed run should pass --resume to claude");
    assert.ok(resumedCall.includes("sess_shutdown_test"));
    const runs = await waitFor(
      managerB,
      "alice",
      (all) => all.length > 0 && all.every((run) => run.status !== "running" && run.status !== "queued"),
    );
    assert.equal(runs.find((run) => run.runId === active.runId)?.status, "finished");
  } finally {
    pair.cleanup(managerB);
  }
});

test("restart: restored runs do not start during construction, then start after (FIX-35)", async () => {
  const pair = beginRestartPair(false);
  const { bus, driverA, storeA, managerA } = pair;
  const runsDir = pair.runsDir;
  let managerB: RuntimeManager | undefined;

  try {
    const active = managerA.start("alice", { prompt: "long active prompt" });
    const queued = managerA.start("alice", { prompt: "queued follow-up prompt" });
    assert.equal(active.accepted, true);
    assert.equal(queued.queued, true);
    await waitForCalls(driverA, 1);

    // vm.starting is published from executeInner's synchronous prefix, so
    // whether it fires before or after `new RuntimeManager` returns proves
    // whether the restored run started inside the constructor.
    let constructionDone = false;
    let vmStartingAfterConstruction: boolean | undefined;
    const unsubscribe = bus.subscribe(queued.runId, 0, (event) => {
      if (event.type === "vm.starting") vmStartingAfterConstruction = constructionDone;
    });

    const driverB = new FastVmDriver();
    managerB = restartPair(pair, driverB).managerB;
    constructionDone = true;

    // Synchronously after construction the restored run is still queued —
    // not started, no vm.starting, no exec.
    const immediate = managerB.list("alice").find((run) => run.runId === queued.runId);
    assert.equal(immediate?.status, "queued");
    assert.equal(vmStartingAfterConstruction, undefined);
    assert.equal(driverB.calls.length, 0);

    // On the next tick it starts (vm.starting after construction) and
    // runs to completion.
    const runs = await waitFor(
      managerB,
      "alice",
      (all) => all.length > 0 && all.every((run) => run.status !== "running" && run.status !== "queued"),
    );
    assert.equal(vmStartingAfterConstruction, true);
    assert.equal(runs.find((run) => run.runId === queued.runId)?.status, "finished");
    unsubscribe();
  } finally {
    pair.cleanup(managerB);
  }
});

test("restart: fresh prompt before the deferred drain queues behind restored work (FIX-35)", async () => {
  const pair = beginRestartPair(false);
  const { bus, driverA, storeA, managerA } = pair;
  const runsDir = pair.runsDir;
  let managerB: RuntimeManager | undefined;

  try {
    managerA.start("alice", { prompt: "long active prompt" });
    const queued = managerA.start("alice", { prompt: "queued follow-up prompt" });
    assert.equal(queued.queued, true);
    await waitForCalls(driverA, 1);

    const driverB = new FastVmDriver();
    managerB = restartPair(pair, driverB).managerB;

    // No await yet: the deferred restored-start has not fired. A fresh
    // prompt submitted in this window must not jump the restored queue —
    // the restored head starts first and the fresh prompt queues behind
    // it, exactly as with the old synchronous restore.
    const fresh = managerB.start("alice", { prompt: "fresh prompt after restart" });
    assert.equal(fresh.accepted, true);
    assert.equal(fresh.queued, true);
    assert.equal(fresh.position, 1);
    const listed = managerB.list("alice");
    assert.equal(listed.find((run) => run.runId === queued.runId)?.status, "running");
    assert.equal(listed.find((run) => run.runId === fresh.runId)?.status, "queued");

    const runs = await waitFor(
      managerB,
      "alice",
      (all) => all.length > 0 && all.every((run) => run.status !== "running" && run.status !== "queued"),
    );
    assert.equal(runs.find((run) => run.runId === queued.runId)?.status, "finished");
    assert.equal(runs.find((run) => run.runId === fresh.runId)?.status, "finished");
  } finally {
    pair.cleanup(managerB);
  }
});

test("restart: shutdown before the deferred drain leaves restored runs queued and durable (FIX-35)", async () => {
  const pair = beginRestartPair(false);
  const { bus, driverA, storeA, managerA } = pair;
  const runsDir = pair.runsDir;
  let managerB: RuntimeManager | undefined;

  try {
    managerA.start("alice", { prompt: "long active prompt" });
    const queued = managerA.start("alice", { prompt: "queued follow-up prompt" });
    assert.equal(queued.queued, true);
    await waitForCalls(driverA, 1);

    const driverB = new FastVmDriver();
    managerB = restartPair(pair, driverB).managerB;

    // SIGTERM lands before the deferred tick: the shutdown must not start
    // restored work during the flush (same contract as finalize with
    // drainQueue off). Nothing was active, so nothing is cancelled.
    assert.deepEqual(managerB.cancelAll("shutdown"), []);
    await sleep(50); // let the deferred tick fire

    const listed = managerB.list("alice").find((run) => run.runId === queued.runId);
    assert.equal(listed?.status, "queued");
    assert.equal(driverB.calls.length, 0);

    // Still durable: the next process restores it as usual.
    const snapshot = new RunStateStore({ filePath: pair.stateB }).load();
    assert.equal(snapshot.users.alice?.active, null);
    assert.equal(snapshot.users.alice?.queue[0]?.runId, queued.runId);
  } finally {
    pair.cleanup(managerB);
  }
});

test("singleton: restored start after registration returns the same instance (FIX-35)", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateA = path.join(dir, "state-a.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  const defaultStore = new RunStateStore();
  // The singleton's VmManager is the process-wide one; swap its driver for
  // a fake so the restored run never touches docker, and restore it after.
  const vmSingleton = vmManager as unknown as { driver: VmDriver };
  const originalDriver = vmSingleton.driver;
  let managerA: RuntimeManager | undefined;
  let singleton: RuntimeManager | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    // A previous process left an active + queued run in the default store.
    const driverA = new BlockingVmDriver();
    managerA = new RuntimeManager({
      vm: new VmManager({ customDriver: driverA }),
      bus,
      router: null,
      stateStore: new RunStateStore({ filePath: stateA }),
    });
    managerA.start("alice", { prompt: "long active prompt" });
    const queued = managerA.start("alice", { prompt: "queued follow-up prompt" });
    assert.equal(queued.queued, true);
    await waitForCalls(driverA, 1);
    fs.copyFileSync(stateA, defaultStore.filePath);

    vmSingleton.driver = new FastVmDriver();
    setRuntimeManagerForTesting(null);

    // A telemetry subscriber that calls back into the singleton while a
    // restored run starts: it must get the registered instance, never
    // construct a second manager.
    let reentrant: RuntimeManager | undefined;
    let reentered = false;
    unsubscribe = telemetryBus.subscribe(queued.runId, 0, (event) => {
      if (event.type !== "vm.starting" || reentered) return;
      reentered = true;
      reentrant = getRuntimeManager();
    });

    singleton = getRuntimeManager();

    // Construction did not start the restored run: still queued, the
    // subscriber has not fired, and the singleton is registered.
    assert.equal(
      singleton.list("alice").find((run) => run.runId === queued.runId)?.status,
      "queued",
    );
    assert.equal(reentrant, undefined);
    assert.equal(getRuntimeManager(), singleton);

    // After the deferred tick the run starts; the reentrant lookup inside
    // its vm.starting publish returns the very same instance.
    for (let i = 0; i < 200 && !reentered; i++) await sleep(10);
    assert.equal(reentered, true);
    assert.equal(reentrant, singleton);
  } finally {
    unsubscribe?.();
    singleton?.cancel("alice");
    setRuntimeManagerForTesting(null);
    vmSingleton.driver = originalDriver;
    defaultStore.clear();
    managerA?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
