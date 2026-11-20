import test from "node:test";
import assert from "node:assert/strict";
import { FakeVmDriver } from "./fake-driver.js";
import { VmManager } from "./manager.js";
import { IdleSweeper, startVmIdleSweeper, stopVmIdleSweeper } from "./idle-sweeper.js";
import {
  DEFAULT_VM_IDLE_MIN,
  parseIdleMinutes,
  resolveIdlePolicy,
} from "./idle.js";
import type { ExecOptions, ExecResult, VmHandle } from "./types.js";

// ---------------------------------------------------------------------------
// Fake clock + fake interval: deterministic time, no wall-clock waiting.
// ---------------------------------------------------------------------------

class FakeClock {
  private t = 0;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

type TimerFn = () => void | Promise<unknown>;

class FakeTimers {
  private handlers = new Map<number, { fn: TimerFn; ms: number; next: number }>();
  private nextId = 1;
  private current = 0;

  readonly setInterval = (fn: TimerFn, ms: number): number => {
    const id = this.nextId++;
    this.handlers.set(id, { fn, ms, next: this.current + ms });
    return id;
  };

  readonly clearInterval = (handle: unknown): void => {
    this.handlers.delete(handle as number);
  };

  get pending(): number {
    return this.handlers.size;
  }

  /** Advance the fake timers, firing every due interval in order. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, h] of this.handlers) {
        if (h.next <= target && h.next < dueAt) {
          dueId = id;
          dueAt = h.next;
        }
      }
      if (dueId === null) break;
      const handler = this.handlers.get(dueId)!;
      handler.next = dueAt + handler.ms;
      this.current = dueAt;
      const result = handler.fn();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        await result;
      }
    }
    this.current = target;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await flush();
  }
}

/** Exec blocks until releaseExec(); stop() is counted. */
class BlockingExecDriver extends FakeVmDriver {
  execStarts = 0;
  stops = 0;
  private pending: Array<() => void> = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execStarts++;
    await new Promise<void>((resolve) => this.pending.push(resolve));
    return super.exec(handle, cmd, opts);
  }

  override async stop(handle: VmHandle): Promise<void> {
    this.stops++;
    return super.stop(handle);
  }

  releaseExec(): void {
    this.pending.shift()?.();
  }
}

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test("resolveIdlePolicy defaults to 30 idle minutes", () => {
  const policy = resolveIdlePolicy();
  assert.equal(policy.idleMinutes, DEFAULT_VM_IDLE_MIN);
  assert.equal(policy.idleMs, 30 * MINUTE);
  assert.ok(policy.sweepIntervalMs > 0);
});

test("resolveIdlePolicy reads SWARM_VM_IDLE_MIN and 0 disables hibernate", () => {
  const prev = process.env.SWARM_VM_IDLE_MIN;
  try {
    process.env.SWARM_VM_IDLE_MIN = "5";
    assert.equal(resolveIdlePolicy().idleMinutes, 5);
    assert.equal(resolveIdlePolicy().idleMs, 5 * MINUTE);

    process.env.SWARM_VM_IDLE_MIN = "0";
    const disabled = resolveIdlePolicy();
    assert.equal(disabled.idleMinutes, 0);
    assert.equal(disabled.idleMs, 0);
    assert.equal(disabled.sweepIntervalMs, 0);
  } finally {
    if (prev === undefined) delete process.env.SWARM_VM_IDLE_MIN;
    else process.env.SWARM_VM_IDLE_MIN = prev;
  }
});

test("parseIdleMinutes rejects garbage and negatives", () => {
  assert.equal(parseIdleMinutes(undefined), DEFAULT_VM_IDLE_MIN);
  assert.equal(parseIdleMinutes(""), DEFAULT_VM_IDLE_MIN);
  assert.equal(parseIdleMinutes("nope"), DEFAULT_VM_IDLE_MIN);
  assert.equal(parseIdleMinutes(-3), DEFAULT_VM_IDLE_MIN);
  assert.equal(parseIdleMinutes("0.5"), 0.5);
  assert.equal(parseIdleMinutes(0), 0);
});

test("resolveIdlePolicy never sweeps slower than the idle window", () => {
  const policy = resolveIdlePolicy({ idleMinutes: 1, sweepIntervalMs: 10 * MINUTE });
  assert.equal(policy.sweepIntervalMs, MINUTE);
});

// ---------------------------------------------------------------------------
// Activity tracking
// ---------------------------------------------------------------------------

test("VmManager tracks the last activity per user", async () => {
  const clock = new FakeClock();
  const manager = new VmManager({ customDriver: new FakeVmDriver(), idle: { idleMinutes: 30 }, now: clock.now });

  assert.equal(manager.lastActivityAt("nobody"), undefined);
  assert.equal(manager.idleForMs("nobody"), 0);
  assert.equal(manager.isIdle("nobody"), false);

  await manager.exec("alice", ["echo", "hi"]);
  const first = manager.lastActivityAt("alice") ?? 0;
  assert.ok(first > 0 || first === 0);

  clock.advance(5 * MINUTE);
  assert.equal(manager.idleForMs("alice"), 5 * MINUTE);
  assert.equal(manager.isIdle("alice"), false);

  await manager.exec("alice", ["echo", "again"]);
  assert.equal(manager.idleForMs("alice"), 0, "a new exec resets the idle timer");
  assert.ok((manager.lastActivityAt("alice") ?? 0) >= first);

  // A second user has its own timeline.
  assert.equal(manager.lastActivityAt("bob"), undefined);
});

// ---------------------------------------------------------------------------
// Hibernation: stop + wake
// ---------------------------------------------------------------------------

test("sweepIdle stops a VM that has been idle for too long", async () => {
  const clock = new FakeClock();
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  await manager.exec("alice", ["echo", "hi"]);
  assert.equal((await manager.status("alice")).status, "running");

  clock.advance(31 * MINUTE);
  const hibernated = await manager.sweepIdle();

  assert.deepEqual(hibernated, ["alice"]);
  assert.equal((await manager.status("alice")).status, "stopped");
});

test("sweepIdle keeps VMs that are still within the idle window", async () => {
  const clock = new FakeClock();
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  await manager.exec("alice", ["echo", "hi"]);
  clock.advance(29 * MINUTE);

  assert.deepEqual(await manager.sweepIdle(), []);
  assert.equal((await manager.status("alice")).status, "running");
});

test("the next exec re-ensures the VM and keeps the /workspace volume", async () => {
  const clock = new FakeClock();
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  await manager.writeFile("alice", "/workspace/keep.txt", "persisted");
  clock.advance(31 * MINUTE);
  assert.deepEqual(await manager.sweepIdle(), ["alice"]);

  // The VM was stopped, the next exec transparently restarts it.
  const chunks: string[] = [];
  const result = await manager.exec("alice", ["cat", "/workspace/keep.txt"], {
    onStdout: (c) => chunks.push(c),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(chunks.join(""), "persisted", "the workspace volume survives hibernation");
  assert.equal((await manager.status("alice")).status, "running");
});

test("a manually stopped VM is re-ensured on the next exec", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 } });

  await manager.writeFile("alice", "/workspace/keep.txt", "persisted");
  await manager.stop("alice");
  assert.equal((await manager.status("alice")).status, "stopped");

  const chunks: string[] = [];
  const result = await manager.exec("alice", ["cat", "/workspace/keep.txt"], {
    onStdout: (c) => chunks.push(c),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(chunks.join(""), "persisted");
  assert.equal((await manager.status("alice")).status, "running");
});

test("SWARM_VM_IDLE_MIN=0 disables hibernation entirely", async () => {
  const clock = new FakeClock();
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 0 }, now: clock.now });

  await manager.exec("alice", ["echo", "hi"]);
  clock.advance(10 * 60 * MINUTE);

  assert.deepEqual(await manager.sweepIdle(), []);
  assert.equal((await manager.status("alice")).status, "running");
});

// ---------------------------------------------------------------------------
// A running exec is never stopped
// ---------------------------------------------------------------------------

test("sweepIdle never stops a VM with a running exec", async () => {
  const clock = new FakeClock();
  const driver = new BlockingExecDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  const execPromise = manager.exec("alice", ["echo", "slow"]);
  await waitFor(() => driver.execStarts === 1, "exec to start");

  // Time passes well beyond the idle window while the exec is running.
  clock.advance(45 * MINUTE);

  assert.deepEqual(await manager.sweepIdle(), [], "no VM may be hibernated during an exec");
  assert.equal(driver.stops, 0, "the driver must not be stopped during an exec");
  assert.equal((await manager.status("alice")).status, "running");

  driver.releaseExec();
  const result = await execPromise;
  assert.equal(result.exitCode, 0, "the running exec completes normally");

  // Once the exec is done the VM is idle again and gets hibernated.
  clock.advance(31 * MINUTE);
  assert.deepEqual(await manager.sweepIdle(), ["alice"]);
  assert.equal(driver.stops, 1);
  assert.equal((await manager.status("alice")).status, "stopped");
});

test("an exec that starts during a sweep keeps its VM alive", async () => {
  const clock = new FakeClock();
  const driver = new BlockingExecDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  const firstExec = manager.exec("alice", ["echo", "one"]);
  await waitFor(() => driver.execStarts === 1, "first exec to start");
  driver.releaseExec();
  await firstExec;

  clock.advance(31 * MINUTE);

  // The sweep snapshots the idle user, then an exec starts before the sweep
  // gets the lock: the VM must not be stopped underneath the running exec.
  const sweepPromise = manager.sweepIdle(clock.now());
  const secondExec = manager.exec("alice", ["echo", "two"]);
  await waitFor(() => driver.execStarts === 2, "second exec to start");

  assert.deepEqual(await sweepPromise, [], "a VM that became busy is not hibernated");
  assert.equal(driver.stops, 0);

  driver.releaseExec();
  assert.equal((await secondExec).exitCode, 0);
});

// ---------------------------------------------------------------------------
// Sweeper with fake timers
// ---------------------------------------------------------------------------

test("IdleSweeper hibernates idle VMs on its timer", async () => {
  const clock = new FakeClock();
  const timers = new FakeTimers();
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  const sweeper = new IdleSweeper({
    manager,
    intervalMs: MINUTE,
    now: clock.now,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });

  sweeper.start();
  assert.equal(sweeper.running, true);
  assert.equal(timers.pending, 1);

  await manager.exec("alice", ["echo", "hi"]);
  clock.advance(31 * MINUTE);

  await timers.advance(MINUTE);
  assert.equal((await manager.status("alice")).status, "stopped");

  sweeper.stop();
  assert.equal(sweeper.running, false);
  assert.equal(timers.pending, 0);
});

test("IdleSweeper keeps a busy VM running across timer ticks", async () => {
  const clock = new FakeClock();
  const timers = new FakeTimers();
  const driver = new BlockingExecDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  const sweeper = new IdleSweeper({
    manager,
    intervalMs: MINUTE,
    now: clock.now,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });
  sweeper.start();

  const execPromise = manager.exec("alice", ["echo", "slow"]);
  await waitFor(() => driver.execStarts === 1, "exec to start");

  clock.advance(60 * MINUTE);
  await timers.advance(60 * MINUTE);

  assert.equal(driver.stops, 0, "a running exec is never stopped by the sweeper");
  assert.equal((await manager.status("alice")).status, "running");

  driver.releaseExec();
  assert.equal((await execPromise).exitCode, 0);
  sweeper.stop();
});

test("startVmIdleSweeper starts one sweeper per manager", () => {
  const clock = new FakeClock();
  const timers = new FakeTimers();
  const manager = new VmManager({ customDriver: new FakeVmDriver(), idle: { idleMinutes: 30 }, now: clock.now });

  const first = startVmIdleSweeper(manager, {
    intervalMs: MINUTE,
    now: clock.now,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });
  const second = startVmIdleSweeper(manager, {
    intervalMs: MINUTE,
    now: clock.now,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });

  assert.equal(first, second);
  assert.equal(timers.pending, 1, "only one timer per manager");

  stopVmIdleSweeper(manager);
  assert.equal(timers.pending, 0);
});

test("IdleSweeper hibernates an idle VM on node's mocked timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    const driver = new FakeVmDriver();
    const manager = new VmManager({
      customDriver: driver,
      idle: { idleMinutes: 30 },
      now: () => Date.now(),
    });
    const sweeper = new IdleSweeper({ manager, intervalMs: MINUTE });
    sweeper.start();

    await manager.exec("alice", ["echo", "hi"]);
    t.mock.timers.tick(31 * MINUTE);
    await flush();
    t.mock.timers.tick(MINUTE);
    await flush();

    assert.equal((await manager.status("alice")).status, "stopped");
    sweeper.stop();
  } finally {
    t.mock.timers.reset();
  }
});
