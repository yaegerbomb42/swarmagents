/**
 * F1 time-travel: auto-checkpoints at the approval gate + fork-from-here.
 *
 * Uses the fake VM driver (no Docker in this VM) plus a gated claude exec so
 * the tests can hold a run mid-flight — the state the approval gate fires
 * in. The deadlock regression is the point of the first test: the gate runs
 * inside the agent's long-lived claude exec, which holds the VM read lock,
 * so a write-lock snapshot from the gate would hang the run forever.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { checkpointVmLabel } from "./checkpoints";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_fork", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_fork", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

/** Fake driver whose claude invocation blocks until released, like a live run. */
class GatedFakeVm extends FakeVmDriver {
  claudeCalls = 0;
  private gateResolve: () => void = () => {};
  private gate: Promise<void> = Promise.resolve();

  blockClaude(): void {
    this.gate = new Promise<void>((resolve) => {
      this.gateResolve = resolve;
    });
  }

  releaseClaude(): void {
    this.gateResolve();
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") {
      this.claudeCalls += 1;
      await this.gate;
      for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
      return { exitCode: 0 };
    }
    return super.exec(handle, cmd, opts);
  }
}

function setup(driver: GatedFakeVm) {
  const bus = new TelemetryBus();
  const vm = new VmManager({ customDriver: driver });
  const manager = new RuntimeManager({ vm, bus });
  return { bus, vm, manager };
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

test("auto-checkpoint at the gate does not deadlock while the agent exec is in flight", async () => {
  const user = "u-fork-gate";
  const driver = new GatedFakeVm();
  driver.blockClaude();
  const { bus, vm, manager } = setup(driver);
  const { runId } = manager.start(user, {
    prompt: "do risky work",
    sessionId: "sess_fork",
    fullAuto: true,
  });
  const runEvents = subscribe(bus, runId);
  // The run is now inside its long-lived claude exec, holding the VM read lock.
  await waitFor(() => driver.claudeCalls > 0, "claude exec to start");

  // An ask-classified call, auto-approved in full-auto. If the checkpoint
  // took the VM write lock here, this would hang until the exec drained —
  // and the exec cannot drain until the gate answers. Race it so a hang
  // fails fast instead of hanging the suite.
  const decision = await Promise.race([
    manager.requestToolApproval(user, runId, "Bash", { command: "sudo apt-get install -y jq" }),
    sleep(5000).then(() => {
      throw new Error("requestToolApproval hung: checkpoint deadlocked on the VM lock");
    }),
  ]);
  assert.equal(decision.decision, "allow");
  assert.equal(runEvents.events.filter((e) => e.type === "checkpoint.created").length, 1);
  const created = runEvents.events.find((e) => e.type === "checkpoint.created")!;
  const label = field(created, "label") as string;
  assert.match(label, /^auto-pre-step-\d+$/);
  assert.equal(field(created, "vmLabel"), `${runId}-${label}`);
  assert.equal(field(created, "tool"), "Bash");
  // The snapshot really landed under the run-namespaced label.
  const labels = (await vm.listSnapshots(user)).map((s) => s.label);
  assert.ok(labels.includes(`${runId}-${label}`), `snapshots: ${labels.join(", ")}`);

  driver.releaseClaude();
  await runEvents.done;
});

test("fork restores the checkpoint workspace and records provenance; original untouched", async () => {
  const user = "u-fork-restore";
  const driver = new GatedFakeVm();
  const { bus, vm, manager } = setup(driver);
  const { runId: runA } = manager.start(user, { prompt: "original work", sessionId: "sess_fork" });
  const eventsA = subscribe(bus, runA);
  await eventsA.done;

  await vm.writeFile(user, "/workspace/proof.txt", "checkpoint-state");
  const vmLabel = checkpointVmLabel(runA, 3);
  await vm.snapshot(user, vmLabel);
  await vm.writeFile(user, "/workspace/proof.txt", "later-state");

  const forked = await manager.fork(user, {
    sourceRunId: runA,
    checkpoint: 3,
    prompt: "try another approach",
  });
  assert.equal(forked.accepted, true);
  assert.notEqual(forked.runId, runA);
  assert.equal(forked.queued, false);
  assert.equal(forked.checkpointLabel, "auto-pre-step-3");

  const eventsF = subscribe(bus, forked.runId);
  await eventsF.done;
  const restored = eventsF.events.find((e) => e.type === "checkpoint.restored");
  assert.ok(restored, "fork must emit checkpoint.restored");
  assert.equal(field(restored!, "label"), "auto-pre-step-3");
  assert.equal(field(restored!, "vmLabel"), vmLabel);
  assert.equal(field(restored!, "stepSeq"), 3);
  assert.equal(field(restored!, "sourceRunId"), runA);
  assert.equal(await vm.readFile(user, "/workspace/proof.txt"), "checkpoint-state");

  // The original run's telemetry has no fork/restore events, and its
  // checkpoint was not consumed or overwritten by the fork.
  assert.equal(eventsA.events.some((e) => e.type === "checkpoint.restored"), false);
  assert.equal(eventsA.events.some((e) => e.type === "checkpoint.created"), false);
  const labels = (await vm.listSnapshots(user)).map((s) => s.label);
  assert.ok(labels.includes(vmLabel));
  const forkSummary = manager.list(user).find((s) => s.runId === forked.runId);
  assert.deepEqual(forkSummary?.forkedFrom, {
    runId: runA,
    checkpointLabel: "auto-pre-step-3",
    stepSeq: 3,
  });
});

test("fork refuses a missing checkpoint", async () => {
  const user = "u-fork-missing";
  const driver = new GatedFakeVm();
  const { manager } = setup(driver);
  const { runId: runA } = manager.start(user, { prompt: "original work", sessionId: "sess_fork" });
  const forked = await manager.fork(user, {
    sourceRunId: runA,
    checkpoint: 99,
    prompt: "try another approach",
  });
  assert.equal(forked.accepted, false);
  assert.match(forked.error ?? "", /not found/i);
});

test("fork refuses a run owned by another user", async () => {
  const user = "u-fork-owner";
  const driver = new GatedFakeVm();
  const { bus, manager } = setup(driver);
  const { runId: runA } = manager.start(user, { prompt: "original work", sessionId: "sess_fork" });
  const eventsA = subscribe(bus, runA);
  await eventsA.done;
  const forked = await manager.fork("u-fork-intruder", {
    sourceRunId: runA,
    checkpoint: 1,
    prompt: "try another approach",
  });
  assert.equal(forked.accepted, false);
  assert.match(forked.error ?? "", /not found/i);
});

test("fork of a running run queues; the restore waits until the fork starts", async () => {
  const user = "u-fork-queued";
  const driver = new GatedFakeVm();
  driver.blockClaude();
  const { bus, vm, manager } = setup(driver);
  const { runId: runA } = manager.start(user, { prompt: "original work", sessionId: "sess_fork" });
  await waitFor(() => driver.claudeCalls > 0, "claude exec to start");

  await vm.writeFile(user, "/workspace/proof.txt", "checkpoint-state");
  const vmLabel = checkpointVmLabel(runA, 3);
  await vm.snapshotDuringRun(user, vmLabel);
  await vm.writeFile(user, "/workspace/proof.txt", "later-state");

  const forked = await manager.fork(user, {
    sourceRunId: runA,
    checkpoint: "auto-pre-step-3",
    prompt: "try another approach",
  });
  assert.equal(forked.accepted, true);
  assert.equal(forked.queued, true);
  assert.equal(forked.position, 1);
  // The restore has NOT happened yet: the original still owns the VM.
  assert.equal(await vm.readFile(user, "/workspace/proof.txt"), "later-state");

  const eventsA = subscribe(bus, runA);
  const eventsF = subscribe(bus, forked.runId);
  driver.releaseClaude();
  await eventsA.done;
  await eventsF.done;
  assert.equal(await vm.readFile(user, "/workspace/proof.txt"), "checkpoint-state");
  assert.ok(eventsF.events.some((e) => e.type === "checkpoint.restored"));
});
