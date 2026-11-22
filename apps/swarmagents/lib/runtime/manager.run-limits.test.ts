/**
 * Run limits: maxTurns flows dispatch -> runner (--max-turns), and the
 * wall-clock timeout (SWARM_RUN_TIMEOUT_SEC) aborts a stuck run with
 * run.error 'timeout'. Uses a fake runner and node:test fake timers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager, type RunnerLike, type RunSummary } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { RunOutcome, RunRequest, TelemetryEvent as HarnessEvent } from "../harness/types";

/**
 * Drain microtasks + setImmediate callbacks. setTimeout is mocked in the
 * timeout test, so sleep() cannot be used to wait.
 */
const drain = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Poll until pred holds, draining between checks. */
async function waitForDrain(pred: () => boolean, rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (pred()) return;
    await drain(2);
  }
  throw new Error("timed out waiting for condition");
}

function managerWithRunner(runner: RunnerLike): RuntimeManager {
  return new RuntimeManager({
    vm: new VmManager({ customDriver: new FakeVmDriver() }),
    router: null,
    runner,
  });
}

/** Runner that never resolves until its signal aborts (mimics the real runner's abort path). */
class StuckRunner implements RunnerLike {
  requests: RunRequest[] = [];
  run(request: RunRequest, onEvent: (event: HarnessEvent) => void): Promise<RunOutcome> {
    this.requests.push(request);
    return new Promise<RunOutcome>((resolve) => {
      const settle = (): void => {
        onEvent({ type: "run.error", message: "Run aborted by caller." });
        resolve({ exitCode: 0, aborted: true, malformedLines: 0 });
      };
      if (request.signal?.aborted) settle();
      else request.signal?.addEventListener("abort", settle, { once: true });
    });
  }
}

/** Runner that finishes immediately, recording the request it received. */
class FinishingRunner implements RunnerLike {
  requests: RunRequest[] = [];
  async run(request: RunRequest, onEvent: (event: HarnessEvent) => void): Promise<RunOutcome> {
    this.requests.push(request);
    onEvent({
      type: "run.finished",
      exitCode: 0,
      sessionId: "sess_limits",
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
    });
    return { exitCode: 0, aborted: false, malformedLines: 0 };
  }
}

function summaries(manager: RuntimeManager, userId: string): RunSummary[] {
  return manager.list(userId);
}

test("wall-clock timeout aborts a stuck run with run.error timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const prevTimeout = process.env.SWARM_RUN_TIMEOUT_SEC;
  const prevShadow = process.env.SWARM_SHADOW_VERIFIER;
  process.env.SWARM_RUN_TIMEOUT_SEC = "0.05";
  process.env.SWARM_SHADOW_VERIFIER = "0";
  try {
    const runner = new StuckRunner();
    const manager = managerWithRunner(runner);
    const started = manager.start("user-limits", { prompt: "do something slow" });
    assert.equal(started.accepted, true);
    // Let execute() reach runOnce and arm the timer.
    await waitForDrain(() => runner.requests.length === 1);
    // Advance past the 50ms timeout; the manager aborts the run.
    t.mock.timers.tick(50);
    await waitForDrain(() => {
      const run = summaries(manager, "user-limits")[0];
      return run !== undefined && run.status !== "running";
    });
    const [run] = summaries(manager, "user-limits");
    assert.equal(run.status, "error");
    assert.match(run.error ?? "", /timeout/i);
    assert.match(run.error ?? "", /SWARM_RUN_TIMEOUT_SEC/);
    assert.equal(runner.requests[0].signal?.aborted, true);
  } finally {
    if (prevTimeout === undefined) delete process.env.SWARM_RUN_TIMEOUT_SEC;
    else process.env.SWARM_RUN_TIMEOUT_SEC = prevTimeout;
    if (prevShadow === undefined) delete process.env.SWARM_SHADOW_VERIFIER;
    else process.env.SWARM_SHADOW_VERIFIER = prevShadow;
  }
});

test("no timeout env means a stuck run keeps running (cancel ends it)", async () => {
  const prevShadow = process.env.SWARM_SHADOW_VERIFIER;
  process.env.SWARM_SHADOW_VERIFIER = "0";
  try {
    delete process.env.SWARM_RUN_TIMEOUT_SEC;
    const runner = new StuckRunner();
    const manager = managerWithRunner(runner);
    const started = manager.start("user-limits", { prompt: "do something slow" });
    assert.equal(started.accepted, true);
    await waitForDrain(() => runner.requests.length === 1);
    await drain(10);
    const [run] = summaries(manager, "user-limits");
    assert.equal(run.status, "running");
    assert.equal(runner.requests[0].signal?.aborted, false);
    assert.equal(manager.cancel("user-limits").ok, true);
  } finally {
    if (prevShadow === undefined) delete process.env.SWARM_SHADOW_VERIFIER;
    else process.env.SWARM_SHADOW_VERIFIER = prevShadow;
  }
});

test("maxTurns flows from dispatch to the runner request", async () => {
  const prevShadow = process.env.SWARM_SHADOW_VERIFIER;
  process.env.SWARM_SHADOW_VERIFIER = "0";
  try {
    const runner = new FinishingRunner();
    const manager = managerWithRunner(runner);
    const started = manager.start("user-limits", { prompt: "hi", maxTurns: 25 });
    assert.equal(started.accepted, true);
    await waitForDrain(() => {
      const run = summaries(manager, "user-limits")[0];
      return run !== undefined && run.status !== "running";
    });
    assert.equal(runner.requests.length, 1);
    assert.equal(runner.requests[0].maxTurns, 25);
    const [run] = summaries(manager, "user-limits");
    assert.equal(run.status, "finished");
  } finally {
    if (prevShadow === undefined) delete process.env.SWARM_SHADOW_VERIFIER;
    else process.env.SWARM_SHADOW_VERIFIER = prevShadow;
  }
});

test("no maxTurns means no ceiling on the runner request", async () => {
  const prevShadow = process.env.SWARM_SHADOW_VERIFIER;
  process.env.SWARM_SHADOW_VERIFIER = "0";
  try {
    const runner = new FinishingRunner();
    const manager = managerWithRunner(runner);
    const started = manager.start("user-limits", { prompt: "hi" });
    assert.equal(started.accepted, true);
    await waitForDrain(() => {
      const run = summaries(manager, "user-limits")[0];
      return run !== undefined && run.status !== "running";
    });
    assert.equal(runner.requests.length, 1);
    assert.equal(runner.requests[0].maxTurns, undefined);
  } finally {
    if (prevShadow === undefined) delete process.env.SWARM_SHADOW_VERIFIER;
    else process.env.SWARM_SHADOW_VERIFIER = prevShadow;
  }
});
