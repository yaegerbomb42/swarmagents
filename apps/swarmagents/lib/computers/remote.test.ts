import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus } from "../telemetry/bus";
import {
  ONLINE_WINDOW_MS,
  configureComputersClock,
  configureComputersStoreDir,
  createPairingCode,
  redeemPairingCode,
  recordHeartbeat,
} from "./store";
import { RemoteRunManager } from "./remote";
import { RemoteRunStateStore } from "./remote-state";

function setup(options: { stateFile?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-remote-"));
  configureComputersStoreDir(dir);
  let now = 1_000_000;
  configureComputersClock(() => now);
  const bus = new TelemetryBus({ persist: false });
  const manager = new RemoteRunManager({
    bus,
    autoSweep: false,
    ...(options.stateFile ? { stateStore: new RemoteRunStateStore({ filePath: options.stateFile }) } : {}),
  });
  const pairing = createPairingCode("alice");
  const redeemed = redeemPairingCode(pairing.code, { name: "Build box", os: "linux", mode: "host" });
  assert.ok(redeemed);
  const computerId = redeemed.computer.id;
  const cleanups = [
    () => {
      manager.stop();
      configureComputersStoreDir("");
      configureComputersClock(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ];
  return {
    bus,
    manager,
    computerId,
    token: redeemed.nodeToken,
    advance: (ms: number) => {
      now += ms;
    },
    cleanup: () => cleanups.forEach((fn) => fn()),
  };
}

test("remote runs: queue, claim, stream events and finish", () => {
  const env = setup();
  try {
    const started = env.manager.start("alice", { prompt: "Run the tests", computerId: env.computerId, projectId: "prj_x" });
    assert.equal(started.accepted, true);
    assert.match(started.runId, /^run_/);

    const events: string[] = [];
    env.bus.subscribe(started.runId, 0, (event) => events.push(event.type));
    const claimed = env.manager.claim("alice", env.computerId);
    assert.ok(claimed);
    assert.equal(claimed.job.prompt, "Run the tests");

    assert.equal(env.manager.publishEvent("alice", env.computerId, started.runId, { type: "assistant.text", text: "working" }), true);
    // The node may not forge lifecycle events.
    assert.equal(env.manager.publishEvent("alice", env.computerId, started.runId, { type: "run.finished" }), false);
    assert.equal(env.manager.publishEvent("alice", env.computerId, started.runId, { type: "Bad Type!" }), false);

    assert.equal(
      env.manager.complete("alice", env.computerId, started.runId, { status: "finished", exitCode: 0, text: "all green" }),
      true,
    );
    assert.ok(events.includes("run.created"));
    assert.ok(events.includes("run.queued"));
    assert.ok(events.includes("run.started"));
    assert.ok(events.includes("assistant.text"));
    assert.ok(events.includes("run.finished"));
    assert.equal(env.manager.list("alice").length, 0);
    assert.equal(env.manager.ownsRun("alice", started.runId), true);
    assert.equal(env.manager.ownsRun("bob", started.runId), false);
    // The queue is empty after the job completed.
    assert.equal(env.manager.claim("alice", env.computerId), null);
  } finally {
    env.cleanup();
  }
});

test("remote runs: live jobs survive a restart and the node can still complete", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-remote-state-"));
  const stateFile = path.join(stateDir, "remote_runs.json");
  const env = setup({ stateFile });
  const restartedManagers: RemoteRunManager[] = [];
  try {
    const running = env.manager.start("alice", { prompt: "Long job", computerId: env.computerId });
    assert.ok(running.accepted);
    assert.ok(env.manager.claim("alice", env.computerId));
    const waiting = env.manager.start("alice", { prompt: "Next job", computerId: env.computerId });
    assert.ok(waiting.accepted);

    // New process over the same durable snapshot.
    const restarted = new RemoteRunManager({
      bus: env.bus,
      autoSweep: false,
      stateStore: new RemoteRunStateStore({ filePath: stateFile }),
    });
    restartedManagers.push(restarted);

    const live = restarted.list("alice");
    assert.equal(live.find((run) => run.runId === running.runId)?.status, "running");
    assert.equal(live.find((run) => run.runId === waiting.runId)?.status, "queued");

    // The node that kept executing through the restart reports back.
    assert.equal(
      restarted.complete("alice", env.computerId, running.runId, {
        status: "finished",
        exitCode: 0,
        text: "finished after restart",
      }),
      true,
    );
    // Queued work is still claimable.
    assert.equal(restarted.claim("alice", env.computerId)?.job.runId, waiting.runId);
  } finally {
    for (const manager of restartedManagers) manager.stop();
    env.cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("remote runs: an offline computer refuses new work", () => {
  const env = setup();
  try {
    env.advance(ONLINE_WINDOW_MS + 1);
    const started = env.manager.start("alice", { prompt: "hello", computerId: env.computerId });
    assert.equal(started.accepted, false);
    assert.equal(started.status, 409);
    assert.match(started.error ?? "", /offline/i);
  } finally {
    env.cleanup();
  }
});

test("remote runs: offline sweep pauses, resume requeues on the same computer", () => {
  const env = setup();
  try {
    const started = env.manager.start("alice", { prompt: "Long job", computerId: env.computerId });
    assert.ok(started.accepted);
    assert.ok(env.manager.claim("alice", env.computerId));

    const events: string[] = [];
    env.bus.subscribe(started.runId, 0, (event) => events.push(event.type));
    env.advance(ONLINE_WINDOW_MS + 1);
    assert.equal(env.manager.sweepOffline(), 1);
    assert.ok(events.includes("run.paused"));

    const paused = env.manager.list("alice");
    assert.equal(paused.length, 1);
    assert.equal(paused[0].status, "paused");
    assert.equal(paused[0].pausedReason, "computer_offline");
    assert.deepEqual(paused[0].compute.computerId, env.computerId);

    // Still offline: resume is refused.
    assert.equal(env.manager.resume("alice", started.runId).status, 409);

    recordHeartbeat(env.computerId, env.token, { name: "Build box", os: "linux" });
    const resumed = env.manager.resume("alice", started.runId);
    assert.ok(resumed.runId);
    assert.notEqual(resumed.runId, started.runId);
    const claimed = env.manager.claim("alice", env.computerId);
    assert.equal(claimed?.job.runId, resumed.runId);
  } finally {
    env.cleanup();
  }
});

test("remote runs: revoking a computer cancels its live jobs", () => {
  const env = setup();
  try {
    const started = env.manager.start("alice", { prompt: "Cancel me", computerId: env.computerId });
    assert.ok(started.accepted);
    assert.equal(env.manager.cancelComputerRuns("bob", env.computerId), 0);
    assert.equal(env.manager.cancelComputerRuns("alice", env.computerId), 1);
    assert.equal(env.manager.list("alice").length, 0);
    assert.equal(env.manager.claim("alice", env.computerId), null);
    assert.equal(env.manager.publishEvent("alice", env.computerId, started.runId, { type: "assistant.text", text: "late" }), false);
  } finally {
    env.cleanup();
  }
});

test("remote runs: user pause keeps the prompt and resume validates ownership", () => {
  const env = setup();
  try {
    const started = env.manager.start("alice", { prompt: "Pause me", computerId: env.computerId });
    assert.ok(started.accepted);
    assert.equal(env.manager.pauseRun("bob", started.runId), false);
    assert.equal(env.manager.pauseRun("alice", started.runId, "user"), true);
    assert.equal(env.manager.list("alice")[0].pausedReason, "user");
    assert.equal(env.manager.resume("bob", started.runId).status, 404);
    assert.ok(env.manager.resume("alice", started.runId).runId);
  } finally {
    env.cleanup();
  }
});
