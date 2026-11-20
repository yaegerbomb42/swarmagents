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
import { RuntimeManager, type RunSummary } from "./manager";
import { RunStateStore } from "./durable-queue";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import { ORPHANED_RUN_REASON, getRun } from "./run-store";
import { ApprovalStore, setApprovalStoreForTesting } from "../harness/approvals";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

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

test("restart: queued prompt survives, active run aborts cleanly, pending approval expires explicitly", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateA = path.join(dir, "state-a.json");
  const stateB = path.join(dir, "state-b.json");
  const approvalsA = path.join(dir, "approvals-a.json");
  const approvalsB = path.join(dir, "approvals-b.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let managerA: RuntimeManager | undefined;

  try {
    const driverA = new BlockingVmDriver();
    const storeA = new RunStateStore({ filePath: stateA });
    const approvalStoreA = new ApprovalStore({ persistPath: approvalsA, ttlMs: 60_000 });
    setApprovalStoreForTesting(approvalStoreA);
    managerA = new RuntimeManager({
      vm: new VmManager({ customDriver: driverA }),
      bus,
      router: null,
      stateStore: storeA,
    });

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
    fs.copyFileSync(stateA, stateB);
    fs.copyFileSync(approvalsA, approvalsB);

    // "Restart": a fresh manager over the copied durable state.
    const driverB = new FastVmDriver();
    const approvalStoreB = new ApprovalStore({ persistPath: approvalsB, ttlMs: 60_000 });
    setApprovalStoreForTesting(approvalStoreB);
    const managerB = new RuntimeManager({
      vm: new VmManager({ customDriver: driverB }),
      bus,
      router: null,
      stateStore: new RunStateStore({ filePath: stateB }),
    });

    // The interrupted run is visibly failed, not silently vanished.
    const interrupted = getRun(active.runId, runsDir);
    assert.ok(interrupted);
    assert.equal(interrupted.summary.status, "error");
    assert.equal(interrupted.summary.error, ORPHANED_RUN_REASON);

    // The approval record survived, and its outcome is an explicit restart
    // expiry — never a user denial and never a TTL surprise.
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
    const after = new RunStateStore({ filePath: stateB }).load();
    assert.equal(after.users.alice, undefined);
  } finally {
    managerA?.cancel("alice");
    configureRunsDir(null);
    setApprovalStoreForTesting(null);
    fs.rmSync(dir, { recursive: true, force: true });
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
