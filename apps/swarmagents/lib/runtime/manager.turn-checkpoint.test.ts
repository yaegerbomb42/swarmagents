/**
 * FIX-21: turn-boundary auto-checkpoints.
 *
 * Auto-checkpoints used to fire only at ask-gates, so an allow-only run
 * (every tool classified allow, no approval prompts) never recorded a
 * resume point and could never resume after a restart. The manager now
 * also checkpoints when a turn completes — the last open tool call
 * closing, or a text-only assistant message ending — throttled by
 * turnCheckpointMinIntervalMs and sharing one clock with gate checkpoints.
 *
 * Uses the fake VM driver with a staged claude exec: stream-json lines are
 * released stage by stage so a test can hold the run mid-flight, exactly
 * when a turn boundary fires. `Read` classifies "allow", so the fixtures
 * never trip the approval gate unless a test asks for one explicitly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager } from "./manager";
import { RunStateStore } from "./durable-queue";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { checkpointVmLabel } from "./checkpoints";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess_turn",
  model: "claude-sonnet-5-5",
});

/** One allow-classified tool turn: assistant tool_use + its tool_result. */
function readTurn(id: string, file: string): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      message: {
        id: `m-${id}`,
        content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "file body", is_error: false }],
      },
    }),
  ];
}

/** A text-only assistant turn (usage closes it; no tool pending). */
const TEXT_TURN = JSON.stringify({
  type: "assistant",
  message: {
    id: "m-text",
    content: [{ type: "text", text: "Done inspecting." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});

const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "sess_turn",
  cost_usd: 0,
  duration_ms: 1,
  num_turns: 2,
});

/**
 * Fake driver whose claude invocation emits stream-json in stages, each
 * released explicitly by the test, then blocks until aborted (like a live
 * run) unless a final stage ends it.
 */
class StagedVmDriver extends FakeVmDriver {
  claudeCalls = 0;
  private stages: string[][] = [];
  private resolvers: Array<() => void> = [];
  private released = new Set<number>();

  stage(lines: string[]): void {
    this.stages.push(lines);
  }

  releaseStage(index: number): void {
    // Sticky: a release that lands before the exec loop reaches the stage
    // (microtask ordering) must not be lost.
    this.released.add(index);
    this.resolvers[index]?.();
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.claudeCalls += 1;
    for (let i = 0; i < this.stages.length; i += 1) {
      await new Promise<void>((resolve) => {
        if (this.released.has(i) || opts?.signal?.aborted) {
          resolve();
          return;
        }
        this.resolvers[i] = resolve;
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      if (opts?.signal?.aborted) return { exitCode: 130 };
      for (const line of this.stages[i]) opts?.onStdout?.(`${line}\n`);
    }
    // All stages emitted: stay in flight until the run is aborted, unless
    // the last stage carried the result line and the exec already ended.
    if (this.stages.some((lines) => lines.includes(RESULT))) return { exitCode: 0 };
    await new Promise<void>((resolve) => {
      if (opts?.signal?.aborted) resolve();
      else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { exitCode: 130 };
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

function subscribe(bus: TelemetryBus, runId: string) {
  const events: SequencedEvent[] = [];
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  bus.subscribe(runId, 0, (event) => {
    events.push(event);
    if (event.type === "run.finished" || event.type === "run.error") finish();
  });
  return { events, done };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** Extra top-level fields the bus spreads onto the sequenced event. */
function field(event: SequencedEvent, name: string): unknown {
  return (event as unknown as Record<string, unknown>)[name];
}

function checkpoints(events: SequencedEvent[]): SequencedEvent[] {
  return events.filter((e) => e.type === "checkpoint.created");
}

test("allow-only run crossing a turn boundary records a resume point", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-turn-ckpt-"));
  const user = "u-turn-basic";
  const driver = new StagedVmDriver();
  driver.stage([INIT]);
  driver.stage(readTurn("toolu_1", "package.json"));
  driver.stage([TEXT_TURN, RESULT]);
  const bus = new TelemetryBus();
  const vm = new VmManager({ customDriver: driver });
  const store = new RunStateStore({ filePath: path.join(dir, "state.json") });
  const manager = new RuntimeManager({
    vm,
    bus,
    router: null,
    stateStore: store,
    turnCheckpointMinIntervalMs: 0,
  });
  try {
    const { runId } = manager.start(user, { prompt: "inspect the repo", sessionId: "sess_turn" });
    const runEvents = subscribe(bus, runId);
    await waitFor(() => driver.claudeCalls > 0, "claude exec to start");
    driver.releaseStage(0);
    driver.releaseStage(1);

    // The tool_result closing the turn is the boundary: a checkpoint lands
    // without any approval ever being requested.
    await waitFor(() => checkpoints(runEvents.events).length >= 1, "turn checkpoint");
    const created = checkpoints(runEvents.events)[0];
    const label = field(created, "label") as string;
    assert.match(label, /^auto-pre-step-\d+$/);
    assert.equal(field(created, "vmLabel"), `${runId}-${label}`);
    assert.equal(field(created, "tool"), "");
    assert.equal(field(created, "reason"), "turn boundary");

    // The snapshot really landed, and the persisted state carries the
    // resume point restart-resume consumes.
    const labels = (await vm.listSnapshots(user)).map((s) => s.label);
    assert.ok(labels.includes(`${runId}-${label}`), `snapshots: ${labels.join(", ")}`);
    const persisted = store.load();
    const resumePoint = persisted.users[user]?.active?.resumePoint;
    assert.ok(resumePoint, "turn checkpoint must record a resume point");
    assert.equal(resumePoint.runId, runId);
    assert.equal(resumePoint.checkpointLabel, label);
    assert.equal(resumePoint.sessionId, "sess_turn");

    driver.releaseStage(2);
    await runEvents.done;
  } finally {
    manager.cancel(user);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("turn checkpoints are throttled by the min interval", async () => {
  // Default interval: two back-to-back turns produce one checkpoint.
  {
    const user = "u-turn-throttle";
    const driver = new StagedVmDriver();
    driver.stage([INIT]);
    driver.stage([...readTurn("toolu_1", "a.txt"), ...readTurn("toolu_2", "b.txt")]);
    driver.stage([RESULT]);
    const bus = new TelemetryBus();
    const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), bus, router: null });
    try {
      const { runId } = manager.start(user, { prompt: "two reads", sessionId: "sess_turn" });
      const runEvents = subscribe(bus, runId);
      await waitFor(() => driver.claudeCalls > 0, "claude exec to start");
      driver.releaseStage(0);
      driver.releaseStage(1);
      await waitFor(() => checkpoints(runEvents.events).length >= 1, "first turn checkpoint");
      await sleep(300);
      assert.equal(checkpoints(runEvents.events).length, 1, "second turn inside the interval must not checkpoint");
      driver.releaseStage(2);
      await runEvents.done;
    } finally {
      manager.cancel(user);
    }
  }
  // Interval 0: every turn checkpoints (staged apart so the in-flight
  // guard cannot drop the second boundary).
  {
    const user = "u-turn-unthrottled";
    const driver = new StagedVmDriver();
    driver.stage([INIT]);
    driver.stage(readTurn("toolu_1", "a.txt"));
    driver.stage(readTurn("toolu_2", "b.txt"));
    driver.stage([RESULT]);
    const bus = new TelemetryBus();
    const manager = new RuntimeManager({
      vm: new VmManager({ customDriver: driver }),
      bus,
      router: null,
      turnCheckpointMinIntervalMs: 0,
    });
    try {
      const { runId } = manager.start(user, { prompt: "two reads", sessionId: "sess_turn" });
      const runEvents = subscribe(bus, runId);
      await waitFor(() => driver.claudeCalls > 0, "claude exec to start");
      driver.releaseStage(0);
      driver.releaseStage(1);
      await waitFor(() => checkpoints(runEvents.events).length >= 1, "first turn checkpoint");
      driver.releaseStage(2);
      await waitFor(() => checkpoints(runEvents.events).length >= 2, "second turn checkpoint");
      const labels = checkpoints(runEvents.events).map((e) => field(e, "label"));
      assert.notEqual(labels[0], labels[1], "each turn checkpoint gets its own step label");
      driver.releaseStage(3);
      await runEvents.done;
    } finally {
      manager.cancel(user);
    }
  }
});

test("ask-gate checkpoint still fires and suppresses an immediate turn checkpoint", async () => {
  const user = "u-turn-gate";
  const driver = new StagedVmDriver();
  driver.stage([INIT]);
  driver.stage(readTurn("toolu_1", "package.json"));
  driver.stage([RESULT]);
  const bus = new TelemetryBus();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), bus, router: null });
  try {
    const { runId } = manager.start(user, {
      prompt: "do risky work",
      sessionId: "sess_turn",
      fullAuto: true,
    });
    const runEvents = subscribe(bus, runId);
    await waitFor(() => driver.claudeCalls > 0, "claude exec to start");
    driver.releaseStage(0);

    // The approval gate checkpoints exactly as before (tool + reason set).
    const decision = await manager.requestToolApproval(user, runId, "Bash", {
      command: "sudo apt-get install -y jq",
    });
    assert.equal(decision.decision, "allow");
    await waitFor(() => checkpoints(runEvents.events).length >= 1, "gate checkpoint");
    assert.equal(field(checkpoints(runEvents.events)[0], "tool"), "Bash");

    // A turn boundary right after is inside the shared throttle window:
    // no redundant second snapshot.
    driver.releaseStage(1);
    await sleep(300);
    assert.equal(checkpoints(runEvents.events).length, 1, "gate checkpoint must suppress the turn checkpoint");

    driver.releaseStage(2);
    await runEvents.done;
  } finally {
    manager.cancel(user);
  }
});

test("restart resumes from the turn checkpoint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-turn-resume-"));
  const runsDir = path.join(dir, "runs");
  const stateA = path.join(dir, "state-a.json");
  const stateB = path.join(dir, "state-b.json");
  configureRunsDir(runsDir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  let managerA: RuntimeManager | undefined;
  let managerB: RuntimeManager | undefined;
  try {
    const driverA = new StagedVmDriver();
    driverA.stage([INIT]);
    driverA.stage(readTurn("toolu_1", "package.json"));
    const storeA = new RunStateStore({ filePath: stateA });
    managerA = new RuntimeManager({
      vm: new VmManager({ customDriver: driverA }),
      bus,
      router: null,
      stateStore: storeA,
      turnCheckpointMinIntervalMs: 0,
    });
    const active = managerA.start("alice", { prompt: "inspect then keep going", sessionId: "sess_turn" });
    assert.equal(active.accepted, true);
    await waitFor(() => driverA.claudeCalls > 0, "claude exec to start");
    driverA.releaseStage(0);
    driverA.releaseStage(1);

    // No approval was ever requested; the turn boundary alone must have
    // recorded the resume point in the persisted snapshot.
    await waitFor(
      () => storeA.load().users.alice?.active?.resumePoint !== undefined,
      "turn resume point persisted",
    );
    const resumePoint = storeA.load().users.alice!.active!.resumePoint!;
    assert.equal(resumePoint.sessionId, "sess_turn");
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

    await waitFor(() => driverB.calls.length >= 1, "resumed claude call");
    assert.deepEqual(driverB.restores, [vmLabel], "restart must restore the turn checkpoint");
    const resumedCall = driverB.calls.find((cmd) => cmd.includes("--resume"));
    assert.ok(resumedCall, "resumed run should pass --resume to claude");
    assert.ok(resumedCall.includes("sess_turn"));
  } finally {
    managerA?.cancel("alice");
    managerB?.cancel("alice");
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
