/**
 * l9 — steer mid-run: interrupt the active run and continue the same
 * Claude session with new instructions.
 *
 * Uses the fake VM driver (no Docker in this VM) plus a gated claude exec so
 * the tests can hold a run mid-flight — the state steering acts on. The
 * session carryover is asserted on the real runner argv (`--resume`), not
 * on a mock of steer() itself.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_steer", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_steer", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

/** Fake driver whose claude invocation blocks until released, like a live run. */
class GatedFakeVm extends FakeVmDriver {
  claudeCalls: Array<{ cmd: string[] }> = [];
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
      this.claudeCalls.push({ cmd: [...cmd] });
      // Interruptible block: a steer (or cancel) aborts the exec instead of
      // waiting out the gate, as the real driver does on controller abort.
      const aborted = new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) return resolve();
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([this.gate, aborted]);
      if (opts?.signal?.aborted) return { exitCode: 130 };
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
  bus.subscribe(runId, 0, (event) => {
    events.push(event);
  });
  return events;
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

test("steer supersedes the active run and resumes its session in a new run", async () => {
  const driver = new GatedFakeVm();
  driver.blockClaude();
  const { bus, manager } = setup(driver);
  const user = "alice";

  const started = manager.start(user, { prompt: "build the thing", sessionId: "sess_steer" });
  assert.equal(started.accepted, true);
  assert.equal(started.queued, false);
  await waitFor(() => driver.claudeCalls.length >= 1, "first claude call");

  const steered = manager.steer(user, "stop, use python instead");
  assert.equal(steered.ok, true);
  assert.equal(steered.steeredFrom, started.runId);
  assert.notEqual(steered.runId, started.runId);
  assert.equal(steered.queued, false);

  // The old run ends as superseded at once, in history; the new run is
  // active immediately with the prefixed prompt and the same session.
  const runs = manager.list(user);
  const oldRun = runs.find((run) => run.runId === started.runId);
  assert.equal(oldRun?.status, "cancelled");
  assert.equal(oldRun?.cancelledReason, "superseded");
  const newRun = runs.find((run) => run.runId === steered.runId);
  assert.equal(newRun?.status, "running");
  assert.equal(newRun?.prompt, "User interrupted: stop, use python instead");
  assert.equal(newRun?.sessionId, "sess_steer");
  assert.equal(newRun?.steeredFrom, started.runId);

  // The new run's stream carries a run.steered event linking both runIds.
  await waitFor(() => driver.claudeCalls.length >= 2, "steered claude call");
  const events = subscribe(bus, steered.runId);
  const steeredEvent = events.find((event) => event.type === "run.steered");
  assert.ok(steeredEvent, "run.steered event published on the new run");
  assert.equal((steeredEvent as unknown as { fromRunId: string }).fromRunId, started.runId);
  assert.equal((steeredEvent as unknown as { toRunId: string }).toRunId, steered.runId);

  // The steered run resumes the superseded run's session on the wire.
  const argv = driver.claudeCalls[1].cmd;
  const resumeIdx = argv.indexOf("--resume");
  assert.ok(resumeIdx !== -1, "steered run should include --resume");
  assert.equal(argv[resumeIdx + 1], "sess_steer");
  assert.equal(argv[argv.indexOf("--") + 1], "User interrupted: stop, use python instead");

  driver.releaseClaude();
  await waitFor(
    () => manager.list(user).find((run) => run.runId === steered.runId)?.status === "finished",
    "steered run to finish",
  );
});

test("steer starts the new run immediately and queued prompts stay queued", async () => {
  const driver = new GatedFakeVm();
  driver.blockClaude();
  const { manager } = setup(driver);
  const user = "alice";

  const first = manager.start(user, { prompt: "first work", sessionId: "sess_steer" });
  assert.equal(first.queued, false);
  await waitFor(() => driver.claudeCalls.length >= 1, "first claude call");

  const queued = manager.start(user, { prompt: "queued follow-up" });
  assert.equal(queued.accepted, true);
  assert.equal(queued.queued, true);

  const steered = manager.steer(user, "change of plan");
  assert.equal(steered.ok, true);
  assert.equal(steered.queued, false);

  // The steered run is active now; the queued prompt is still queued behind
  // it (it did not jump ahead when the slot freed).
  const runs = manager.list(user);
  assert.equal(runs.find((run) => run.runId === steered.runId)?.status, "running");
  const stillQueued = runs.find((run) => run.runId === queued.runId);
  assert.equal(stillQueued?.status, "queued");
  assert.equal(stillQueued?.position, 1);

  // Once the steered run finishes, the queued prompt starts. (The queued
  // run is fast on the fake driver, so assert on its finish rather than
  // catching the few-ms window where it shows as running.)
  driver.releaseClaude();
  await waitFor(
    () => manager.list(user).find((run) => run.runId === queued.runId)?.status === "finished",
    "queued run to run after the steered run",
  );
  assert.ok(driver.claudeCalls.length >= 3, "queued run invoked claude");
  // The queued run's claude call is the third one: it started only after
  // the steered run finished, with its own prompt.
  const queuedArgv = driver.claudeCalls[2].cmd;
  assert.equal(queuedArgv[queuedArgv.indexOf("--") + 1], "queued follow-up");
});

test("steer with no active run is refused", () => {
  const driver = new GatedFakeVm();
  const { manager } = setup(driver);
  const result = manager.steer("alice", "do something else");
  assert.equal(result.ok, false);
  assert.match(result.error, /No active run/);
});

test("steer with an empty prompt is refused and the run keeps going", async () => {
  const driver = new GatedFakeVm();
  driver.blockClaude();
  const { manager } = setup(driver);
  const user = "alice";
  const started = manager.start(user, { prompt: "work", sessionId: "sess_steer" });
  await waitFor(() => driver.claudeCalls.length >= 1, "first claude call");

  const result = manager.steer(user, "   ");
  assert.equal(result.ok, false);
  assert.match(result.error, /prompt is required/);
  assert.equal(manager.list(user).find((run) => run.runId === started.runId)?.status, "running");
  assert.equal(driver.claudeCalls.length, 1, "no new run was started");
  driver.releaseClaude();
});
