/**
 * Prompt queuing: a second prompt while a run is active is queued (not
 * superseded), the next queued prompt starts when the active one finishes,
 * the queue is bounded by SWARM_MAX_QUEUED, and cancel removes queued items.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { telemetryBus } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../vm/types";
import type { RunSummary } from "./manager";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_queue", model: "claude-test" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_queue", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

class DelayedFakeVm extends FakeVmDriver {
  calls: string[][] = [];

  constructor(private readonly delays: number[] = []) {
    super();
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    const index = this.calls.length;
    this.calls.push(cmd);
    const delay = this.delays[index] ?? 0;
    if (delay > 0) await sleep(delay);
    if (opts?.signal?.aborted) return { exitCode: 130 };
    for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
    return { exitCode: 0 };
  }
}

function managerWith(driver: VmDriver, maxQueued?: number): RuntimeManager {
  return new RuntimeManager({
    vm: new VmManager({ customDriver: driver }),
    router: null,
    maxQueued,
  });
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

async function waitForCalls(driver: DelayedFakeVm, count: number, steps = 100): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (driver.calls.length >= count) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${count} claude calls`);
}

test.afterEach(() => {
  delete process.env.SWARM_MAX_QUEUED;
});

test("queues a second prompt, emits run.queued with position, and starts it on finish", async () => {
  const driver = new DelayedFakeVm([150]);
  const manager = managerWith(driver);

  const first = manager.start("alice", { prompt: "first" });
  assert.equal(first.accepted, true);
  assert.equal(first.queued, false);

  const second = manager.start("alice", { prompt: "second" });
  assert.equal(second.accepted, true);
  assert.equal(second.queued, true);
  assert.equal(second.position, 1);

  const events: Array<{ type: string; data?: unknown }> = [];
  telemetryBus.subscribe(second.runId, 0, (event) => events.push(event));
  const queuedEvent = events.find((event) => event.type === "run.queued");
  assert.ok(queuedEvent, "run.queued should be emitted for a queued prompt");
  assert.deepEqual(queuedEvent.data, {
    position: 1,
    prompt: "second",
    userId: "alice",
  });

  const during = manager.list("alice");
  const queuedSummary = during.find((run) => run.runId === second.runId);
  assert.equal(queuedSummary?.status, "queued");
  assert.equal(queuedSummary?.position, 1);
  assert.equal(during.find((run) => run.runId === first.runId)?.status, "running");

  const runs = await waitFor(manager, "alice", (all) => all.every((run) => run.status !== "running" && run.status !== "queued"));
  assert.equal(runs.find((run) => run.runId === first.runId)?.status, "finished");
  assert.equal(runs.find((run) => run.runId === second.runId)?.status, "finished");
  assert.equal(driver.calls.length, 2);
  assert.equal(driver.calls[0].at(-1), "first");
  assert.equal(driver.calls[1].at(-1), "second");
});

test("queues up to SWARM_MAX_QUEUED (default 3) and rejects further prompts", async () => {
  const driver = new DelayedFakeVm([5000, 5000, 5000, 5000]);
  const manager = managerWith(driver);

  const active = manager.start("alice", { prompt: "active" });
  assert.equal(active.accepted, true);

  for (let i = 1; i <= 3; i++) {
    const queued = manager.start("alice", { prompt: `queued-${i}` });
    assert.equal(queued.accepted, true);
    assert.equal(queued.position, i);
  }

  const rejected = manager.start("alice", { prompt: "overflow" });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.limit, 3);

  const runs = manager.list("alice");
  assert.equal(runs.filter((run) => run.status === "queued").length, 3);
  assert.equal(runs.find((run) => run.runId === active.runId)?.status, "running");

  await waitForCalls(driver, 1);
  manager.cancel("alice");
  assert.equal(driver.calls.length, 1); // nothing from the queue was started
});

test("SWARM_MAX_QUEUED overrides the default queue depth", async () => {
  process.env.SWARM_MAX_QUEUED = "1";
  const driver = new DelayedFakeVm([5000, 5000]);
  const manager = managerWith(driver);

  manager.start("alice", { prompt: "active" });
  const queued = manager.start("alice", { prompt: "queued" });
  assert.equal(queued.accepted, true);
  const rejected = manager.start("alice", { prompt: "overflow" });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.limit, 1);

  manager.cancel("alice");
});

test("cancel removes a queued item; cancelling the active run keeps the queue and starts the next prompt", async () => {
  const driver = new DelayedFakeVm([5000, 5000, 5000]);
  const manager = managerWith(driver);

  const active = manager.start("alice", { prompt: "active" });
  const second = manager.start("alice", { prompt: "second" });
  const third = manager.start("alice", { prompt: "third" });
  assert.equal(second.position, 1);
  assert.equal(third.position, 2);
  await waitForCalls(driver, 1);

  const events: string[] = [];
  telemetryBus.subscribe(second.runId, 0, (event) => events.push(event.type));

  assert.deepEqual(manager.cancel("alice", second.runId), { ok: true, runId: second.runId });
  assert.ok(events.includes("run.cancelled"));

  const remaining = manager.list("alice");
  assert.equal(remaining.find((run) => run.runId === second.runId)?.status, "cancelled");
  assert.equal(remaining.find((run) => run.runId === third.runId)?.status, "queued");
  assert.equal(remaining.find((run) => run.runId === third.runId)?.position, 1);

  assert.equal(manager.cancel("alice", second.runId).ok, false);
  assert.deepEqual(manager.cancel("alice", active.runId), { ok: true, runId: active.runId });

  // Cancelling the active run frees the slot; the remaining queued prompt
  // starts immediately instead of being cleared along with it.
  await waitForCalls(driver, 2);
  const runs = manager.list("alice");
  assert.equal(runs.find((run) => run.runId === active.runId)?.status, "cancelled");
  assert.equal(runs.find((run) => run.runId === second.runId)?.status, "cancelled");
  assert.equal(runs.find((run) => run.runId === third.runId)?.status, "running");
});

test("queue releases after a failed run: the next queued prompt starts", async () => {
  class FailFirstThenSucceed extends FakeVmDriver {
    calls = 0;

    override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
      this.calls += 1;
      if (this.calls === 1) return { exitCode: 1 }; // claude fails without a result
      for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
      return { exitCode: 0 };
    }
  }

  const driver = new FailFirstThenSucceed();
  const manager = managerWith(driver as unknown as DelayedFakeVm);

  const first = manager.start("alice", { prompt: "first" });
  const second = manager.start("alice", { prompt: "second" });
  assert.equal(second.queued, true);
  assert.equal(second.position, 1);

  const runs = await waitFor(manager, "alice", (all) => all.every((run) => run.status !== "running" && run.status !== "queued"));
  assert.equal(runs.find((run) => run.runId === first.runId)?.status, "error");
  assert.equal(runs.find((run) => run.runId === second.runId)?.status, "finished");
  assert.equal(driver.calls, 2);
});

test("watchdog finalizes a run that never starts and releases the slot", async () => {
  class HangFirstOnly extends FakeVmDriver {
    calls = 0;

    override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
      this.calls += 1;
      if (this.calls === 1) {
        // Never emit a single event: the exec stream is wedged.
        await new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (opts?.signal?.aborted) {
              clearInterval(poll);
              resolve();
            }
          }, 5);
        });
        return { exitCode: 130 };
      }
      for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
      return { exitCode: 0 };
    }
  }

  const driver = new HangFirstOnly();
  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: driver }),
    router: null,
    startGraceMs: 50,
    silenceMs: 2000,
    watchdogSweepMs: 20,
  });

  const first = manager.start("alice", { prompt: "first" });
  const second = manager.start("alice", { prompt: "second" });
  assert.equal(second.queued, true);

  // The first run never starts; the watchdog finalizes it as an error and
  // the queued second prompt takes the slot and finishes normally.
  await waitFor(manager, "alice", (all) =>
    all.find((run) => run.runId === first.runId)?.status === "error" &&
    all.find((run) => run.runId === second.runId)?.status === "finished",
  );
  assert.equal(driver.calls, 2);
});

test("watchdog finalizes a run that went silent after starting", async () => {
  class SilentAfterStart extends FakeVmDriver {
    calls = 0;

    override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
      this.calls += 1;
      // Emit only the init line (run.started), then go silent forever.
      opts?.onStdout?.(`${JSON.stringify({ type: "system", subtype: "init", session_id: "sess_silent", model: "claude-test" })}\n`);
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (opts?.signal?.aborted) {
            clearInterval(poll);
            resolve();
          }
        }, 5);
      });
      return { exitCode: 130 };
    }
  }

  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: new SilentAfterStart() }),
    router: null,
    startGraceMs: 5000,
    silenceMs: 50,
    watchdogSweepMs: 20,
  });

  const first = manager.start("alice", { prompt: "first" });
  await waitFor(manager, "alice", (all) =>
    all.find((run) => run.runId === first.runId)?.status === "error",
  );
  const runs = manager.list("alice");
  assert.ok((runs[0].error ?? "").includes("silent"));
});

test("list attaches the report card meta once a run's report exists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-mgr-report-"));
  configureRunsDir(dir);
  try {
    const manager = managerWith(new DelayedFakeVm());
    manager.start("alice", { prompt: "build it" });
    await waitFor(manager, "alice", (runs) => runs.length === 1 && runs[0].status !== "running");

    // The report is written asynchronously by the reporter after the terminal
    // event; poll until the meta shows up on the list entry.
    await waitFor(manager, "alice", (runs) => runs[0]?.report !== undefined);
    const meta = manager.list("alice")[0].report;
    assert.ok(meta);
    assert.equal(meta?.status, "finished");
    assert.equal(meta?.steps, 2);
    assert.equal(meta?.artifacts, 0);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
