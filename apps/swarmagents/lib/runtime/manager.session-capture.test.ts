/**
 * FIX-07: a fresh run captures the harness session id from its `run.started`
 * event (normalized from the claude stream-json `system/init` line), so
 * auto-checkpoints record it in the ResumePoint and a server restart can
 * resume the run instead of safe-aborting it.
 *
 * Before the fix, `active.sessionId` was only set at acceptance and at role
 * switches, so a fresh run's ResumePoint never carried a sessionId and
 * restart-resume only worked for continuation runs.
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
import { configureSessionPaths } from "./session-store";
import { getRun } from "./run-store";
import { checkpointVmLabel } from "./checkpoints";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Claude that reports a session id in its stream-json init line, then blocks
 * until aborted. The init line can be held back (so a checkpoint is recorded
 * before the session event arrives) and released later (to simulate a late
 * event for a run that no longer occupies the slot).
 */
class SessionInitDriver extends FakeVmDriver {
  calls: string[][] = [];
  /** Session id reported in the init line; null omits `session_id` entirely. */
  sessionId: string | null = "sess_fresh";
  /** Hold the init line until releaseInit() is called. */
  holdInit = false;
  private heldEmit: (() => void) | null = null;

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.calls.push(cmd);
    const sessionId = this.sessionId;
    const emitInit = () => {
      opts?.onStdout?.(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          cwd: "/workspace",
          ...(sessionId ? { session_id: sessionId } : {}),
          model: "claude-sonnet-5-5",
        })}\n`,
      );
    };
    if (this.holdInit) this.heldEmit = emitInit;
    else emitInit();
    return new Promise<ExecResult>((resolve) => {
      if (opts?.signal?.aborted) {
        resolve({ exitCode: 130 });
        return;
      }
      opts?.signal?.addEventListener("abort", () => resolve({ exitCode: 130 }), { once: true });
    });
  }

  releaseInit(): void {
    this.heldEmit?.();
    this.heldEmit = null;
  }
}

/** Fast driver that records every VM snapshot restore label. */
class RecordingFastVmDriver extends FakeVmDriver {
  calls: string[][] = [];
  restores: string[] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") this.calls.push(cmd);
    return super.exec(handle, cmd, opts);
  }

  override async restore(handle: VmHandle, label: string): Promise<void> {
    this.restores.push(label);
    return super.restore(handle, label);
  }
}

async function waitForCalls(driver: { calls: string[][] }, count: number, steps = 200): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (driver.calls.length >= count) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${count} claude calls`);
}

async function waitForSnapshot(
  store: RunStateStore,
  pred: (state: ReturnType<RunStateStore["load"]>) => boolean,
  steps = 400,
): Promise<ReturnType<RunStateStore["load"]>> {
  for (let i = 0; i < steps; i++) {
    const state = store.load();
    if (pred(state)) return state;
    await sleep(10);
  }
  throw new Error("timed out waiting for persisted state");
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

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-session-capture-"));
}

test("fresh run captures the harness session id so its checkpoint can resume", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  configureSessionPaths(path.join(dir, "sessions.json"));
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new SessionInitDriver();
    driver.sessionId = "sess_fresh_capture";
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
    });

    // No sessionId at acceptance: a fresh run — the case FIX-07 fixes.
    const active = manager.start("alice", { prompt: "fresh work", fullAuto: true });
    assert.equal(active.accepted, true);
    await waitForCalls(driver, 1);

    // The init event's session id is captured onto the active run and
    // persisted immediately, not only at the next queue transition.
    const captured = await waitForSnapshot(
      store,
      (state) => state.users.alice?.active?.sessionId === "sess_fresh_capture",
    );
    assert.equal(captured.users.alice?.active?.runId, active.runId);
    assert.equal(
      manager.list("alice").find((run) => run.runId === active.runId)?.sessionId,
      "sess_fresh_capture",
    );

    // An ask-level approval in full-auto mode checkpoints first; the
    // ResumePoint must carry the captured session id.
    const verdict = await manager.requestToolApproval("alice", active.runId, "Bash", {
      command: "sudo apt-get install -y jq",
    });
    assert.equal(verdict.decision, "allow");
    const after = store.load();
    assert.ok(after.users.alice?.active?.resumePoint);
    assert.equal(after.users.alice.active.resumePoint.sessionId, "sess_fresh_capture");
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    configureSessionPaths("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a checkpoint recorded before the session event is backfilled", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  configureSessionPaths(path.join(dir, "sessions.json"));
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new SessionInitDriver();
    driver.sessionId = "sess_backfill";
    driver.holdInit = true;
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
    });

    const active = manager.start("alice", { prompt: "fresh work", fullAuto: true });
    assert.equal(active.accepted, true);
    await waitForCalls(driver, 1);

    // Checkpoint first: no session id is known yet, so the ResumePoint
    // records none (the pre-FIX-07 state for every fresh run).
    const verdict = await manager.requestToolApproval("alice", active.runId, "Bash", {
      command: "sudo apt-get install -y jq",
    });
    assert.equal(verdict.decision, "allow");
    const before = store.load();
    assert.ok(before.users.alice?.active?.resumePoint);
    assert.equal(before.users.alice.active.resumePoint.sessionId, undefined);
    assert.equal(before.users.alice.active.sessionId, undefined);

    // The init line arrives late; the existing resume point is backfilled
    // with the live session id and the backfill is persisted.
    driver.releaseInit();
    const after = await waitForSnapshot(
      store,
      (state) => state.users.alice?.active?.resumePoint?.sessionId === "sess_backfill",
    );
    assert.equal(after.users.alice?.active?.sessionId, "sess_backfill");
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    configureSessionPaths("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restart: a fresh run with a recorded resume point resumes from its checkpoint", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateA = path.join(dir, "state-a.json");
  const stateB = path.join(dir, "state-b.json");
  configureRunsDir(runsDir);
  configureSessionPaths(path.join(dir, "sessions.json"));
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let managerA: RuntimeManager | undefined;
  let managerB: RuntimeManager | undefined;

  try {
    const driverA = new SessionInitDriver();
    driverA.sessionId = "sess_fresh_resume";
    const storeA = new RunStateStore({ filePath: stateA });
    managerA = new RuntimeManager({
      vm: new VmManager({ customDriver: driverA }),
      bus,
      router: null,
      stateStore: storeA,
    });

    // Fresh run: no sessionId at acceptance.
    const active = managerA.start("alice", { prompt: "fresh risky work", fullAuto: true });
    assert.equal(active.accepted, true);
    await waitForCalls(driverA, 1);
    await waitForSnapshot(
      storeA,
      (state) => state.users.alice?.active?.sessionId === "sess_fresh_resume",
    );

    const verdict = await managerA.requestToolApproval("alice", active.runId, "Bash", {
      command: "sudo apt-get install -y jq",
    });
    assert.equal(verdict.decision, "allow");

    const snapshot = storeA.load();
    const resumePoint = snapshot.users.alice?.active?.resumePoint;
    assert.ok(resumePoint);
    assert.equal(resumePoint.sessionId, "sess_fresh_resume");
    const vmLabel = checkpointVmLabel(active.runId, resumePoint.stepSeq);

    fs.copyFileSync(stateA, stateB);

    // "Restart": a fresh manager over the copied durable state. The VM
    // snapshot survives in the (persistent) driver, like production.
    const driverB = new RecordingFastVmDriver();
    const vmB = new VmManager({ customDriver: driverB });
    await vmB.snapshot("alice", vmLabel);
    managerB = new RuntimeManager({
      vm: vmB,
      bus,
      router: null,
      stateStore: new RunStateStore({ filePath: stateB }),
    });

    // The resumed run continued the captured session instead of re-running
    // the prompt: the claude argv carries --resume + the session id.
    await waitForCalls(driverB, 1);
    assert.deepEqual(driverB.restores, [vmLabel]);
    const resumedCall = driverB.calls.find((cmd) => cmd.includes("--resume"));
    assert.ok(resumedCall, "resumed run should pass --resume to claude");
    assert.ok(resumedCall.includes("sess_fresh_resume"));

    // The interrupted run was NOT finalized as an error, and it finishes.
    const resumed = getRun(active.runId, runsDir);
    assert.ok(resumed);
    assert.notEqual(resumed.summary.status, "error");
    const runs = await waitFor(
      managerB,
      "alice",
      (all) => all.length > 0 && all.every((run) => run.status !== "running" && run.status !== "queued"),
    );
    assert.equal(runs.find((run) => run.runId === active.runId)?.status, "finished");
  } finally {
    managerA?.cancel("alice");
    managerB?.cancel("alice");
    configureRunsDir(null);
    configureSessionPaths("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a late session event for a finalized run does not pollute the next run", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  configureSessionPaths(path.join(dir, "sessions.json"));
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new SessionInitDriver();
    driver.sessionId = "sess_late";
    driver.holdInit = true;
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
    });

    // Run A never reports its session while it is alive.
    const a = manager.start("alice", { prompt: "run a", fullAuto: true });
    assert.equal(a.accepted, true);
    await waitForCalls(driver, 1);
    manager.cancel("alice", a.runId);

    // Run B takes the slot and reports its own session id.
    driver.holdInit = false;
    driver.sessionId = "sess_b";
    const b = manager.start("alice", { prompt: "run b", fullAuto: true });
    assert.equal(b.accepted, true);
    await waitForCalls(driver, 2);
    await waitForSnapshot(
      store,
      (state) =>
        state.users.alice?.active?.runId === b.runId &&
        state.users.alice?.active?.sessionId === "sess_b",
    );

    // A's init line arrives only now, after A finalized and B owns the
    // slot. Whether the runner forwards it or swallows it, B must keep
    // its own session id — the still-active guard in forwardEvent is what
    // makes the forwarded case safe.
    driver.releaseInit();
    await sleep(50);

    const verdict = await manager.requestToolApproval("alice", b.runId, "Bash", {
      command: "sudo apt-get install -y jq",
    });
    assert.equal(verdict.decision, "allow");
    assert.equal(store.load().users.alice?.active?.resumePoint?.sessionId, "sess_b");
    assert.equal(
      manager.list("alice").find((run) => run.runId === b.runId)?.sessionId,
      "sess_b",
    );

    // A's history summary never picked up the late session id.
    const aSummary = manager.list("alice").find((run) => run.runId === a.runId);
    assert.equal(aSummary?.status, "cancelled");
    assert.notEqual(aSummary?.sessionId, "sess_late");
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    configureSessionPaths("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an init event without a session id does not invent one", async () => {
  const dir = tmpDir();
  const runsDir = path.join(dir, "runs");
  const stateFile = path.join(dir, "state.json");
  configureRunsDir(runsDir);
  configureSessionPaths(path.join(dir, "sessions.json"));
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let manager: RuntimeManager | undefined;

  try {
    const driver = new SessionInitDriver();
    driver.sessionId = null; // init line carries no session_id
    const store = new RunStateStore({ filePath: stateFile });
    manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      stateStore: store,
    });

    const active = manager.start("alice", { prompt: "fresh work", fullAuto: true });
    assert.equal(active.accepted, true);
    await waitForCalls(driver, 1);
    // The init line is emitted synchronously at exec start; give the
    // runner a tick to process it before checkpointing.
    await sleep(50);

    const verdict = await manager.requestToolApproval("alice", active.runId, "Bash", {
      command: "sudo apt-get install -y jq",
    });
    assert.equal(verdict.decision, "allow");
    const after = store.load();
    assert.ok(after.users.alice?.active?.resumePoint);
    assert.equal(after.users.alice.active.resumePoint.sessionId, undefined);
    assert.equal(after.users.alice.active.sessionId, undefined);
  } finally {
    manager?.cancel("alice");
    configureRunsDir(null);
    configureSessionPaths("");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
