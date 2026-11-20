import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  handleShutdown,
  registerShutdownHandler,
  type ShutdownDeps,
} from "./shutdown";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { TelemetryBus, type SequencedEvent, type TelemetryEvent } from "../telemetry/bus";
import { readRunEvents } from "../telemetry/run-log";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-shutdown-"));
}

test("registers the signal handlers exactly once", () => {
  assert.equal(registerShutdownHandler(), true);
  assert.equal(registerShutdownHandler(), false);
});

test("handleShutdown cancels runs with reason 'shutdown', flushes, then exits 0", async () => {
  const calls: string[] = [];
  let exitCode: number | undefined;
  const deps: ShutdownDeps = {
    cancelActiveRuns: (reason) => {
      assert.equal(reason, "shutdown");
      calls.push("cancel");
      return ["run_1"];
    },
    flush: () => {
      calls.push("flush");
    },
    exit: (code) => {
      exitCode = code;
      calls.push(`exit:${code}`);
    },
    timeoutMs: 1000,
  };

  await handleShutdown("SIGTERM", deps);

  assert.deepEqual(calls, ["cancel", "flush", "exit:0"]);
  assert.equal(exitCode, 0);
});

test("handleShutdown force-exits within the timeout when flushing hangs", async () => {
  let exitCode: number | undefined;
  const deps: ShutdownDeps = {
    cancelActiveRuns: () => [],
    // A writer that never resolves: the shutdown must not wait on it.
    flush: () => new Promise<void>(() => {}),
    exit: (code) => {
      exitCode = code;
    },
    timeoutMs: 25,
  };

  const startedAt = Date.now();
  await handleShutdown("SIGINT", deps);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(exitCode, 0);
  assert.ok(elapsedMs < 1000, `expected force-exit near the 25ms timeout, took ${elapsedMs}ms`);
});

test("handleShutdown still exits 0 when cancelling or flushing throws", async () => {
  const exits: number[] = [];
  const deps: ShutdownDeps = {
    cancelActiveRuns: () => {
      throw new Error("cancel boom");
    },
    flush: () => {
      throw new Error("flush boom");
    },
    exit: (code) => {
      exits.push(code);
    },
    timeoutMs: 1000,
  };

  await handleShutdown("SIGTERM", deps);

  assert.deepEqual(exits, [0]);
});

test("default shutdown timeout is 10s", () => {
  assert.equal(DEFAULT_SHUTDOWN_TIMEOUT_MS, 10_000);
});

/** A VM driver whose ensure stays pending so runs are still active at cancel time. */
class SlowEnsureDriver extends FakeVmDriver {
  override async ensure(userId: string): Promise<VmHandle> {
    await sleep(200);
    return super.ensure(userId);
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    return super.exec(handle, cmd, opts);
  }
}

test("RuntimeManager.cancelAll cancels every active run with reason 'shutdown'", () => {
  const bus = new TelemetryBus();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: new SlowEnsureDriver() }), bus });
  const alice = manager.start("alice", { prompt: "a" });
  const bob = manager.start("bob", { prompt: "b" });

  const events: SequencedEvent[] = [];
  bus.subscribe(alice.runId, 0, (event) => events.push(event));
  bus.subscribe(bob.runId, 0, (event) => events.push(event));

  const cancelled = manager.cancelAll("shutdown");

  assert.deepEqual([...cancelled].sort(), [alice.runId, bob.runId].sort());
  for (const userId of ["alice", "bob"]) {
    const summary = manager.list(userId)[0];
    assert.equal(summary.status, "cancelled");
    assert.equal(summary.cancelledReason, "shutdown");
  }
  const cancelEvents = events.filter((event) => event.type === "run.cancelled");
  assert.equal(cancelEvents.length, 2);
  for (const event of cancelEvents) {
    assert.equal((event as { reason?: unknown }).reason, "shutdown");
  }
  // Nothing left to cancel.
  assert.deepEqual(manager.cancelAll("shutdown"), []);
});

test("TelemetryBus.flush leaves persisted run logs intact", () => {
  const dir = tmpDir();
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    bus.publish("run_flush", { type: "run.created", data: { prompt: "flush me", userId: "alice" } });
    bus.publish("run_flush", { type: "run.finished", exitCode: 0 } as TelemetryEvent);

    assert.doesNotThrow(() => bus.flush());

    const replayed = readRunEvents("run_flush", dir);
    assert.deepEqual(
      replayed.map((event) => event.type),
      ["run.created", "run.finished"],
    );
    assert.ok(fs.existsSync(path.join(dir, "run_flush.jsonl")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
