/**
 * On-demand VM eviction support: idleVmCandidates / evictIdleVm expose the
 * idle sweeper's hibernate mechanism with a caller-chosen idle floor, so
 * the runtime manager can free a global VM slot for a capacity-queued run
 * instead of waiting out SWARM_VM_IDLE_MIN. The safety predicate is the
 * sweeper's own: idle long enough, no exec in flight, activity re-checked
 * under the per-user write lock. Eviction requires hibernation to be
 * enabled (SWARM_VM_IDLE_MIN > 0) and only ever stops a VM that actually
 * holds a slot (live per isVmLive).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { FakeVmDriver } from "./fake-driver.js";
import { VmManager } from "./manager.js";
import type { ExecOptions, ExecResult, VmHandle } from "./types.js";

class FakeClock {
  private t = 0;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

const SECOND = 1_000;
const MINUTE = 60_000;
const FLOOR = 60 * SECOND;

function managerWith(clock: FakeClock, idleMinutes = 30): VmManager {
  return new VmManager({
    customDriver: new FakeVmDriver(),
    idle: { idleMinutes },
    now: clock.now,
  });
}

test("candidates are longest-idle first and respect the floor", async () => {
  const clock = new FakeClock();
  const manager = managerWith(clock);

  await manager.ensure("alice"); // last activity t=0
  clock.advance(3 * MINUTE);
  await manager.ensure("bob"); // last activity t=3m
  clock.advance(2 * MINUTE); // alice idle 5m, bob idle 2m

  assert.deepEqual(manager.idleVmCandidates(FLOOR), [
    { userId: "alice", idleMs: 5 * MINUTE },
    { userId: "bob", idleMs: 2 * MINUTE },
  ]);
  assert.deepEqual(manager.idleVmCandidates(4 * MINUTE), [
    { userId: "alice", idleMs: 5 * MINUTE },
  ]);
  assert.deepEqual(manager.idleVmCandidates(6 * MINUTE), []);
});

test("candidates exclude unknown and stopped VMs (no slot held)", async () => {
  const clock = new FakeClock();
  const manager = managerWith(clock);

  await manager.ensure("alice");
  await manager.ensure("bob");
  await manager.stop("bob"); // stopped: cache dropped, no longer live
  clock.advance(10 * MINUTE);

  assert.deepEqual(
    manager.idleVmCandidates(FLOOR).map((c) => c.userId),
    ["alice"],
    "a stopped VM holds no slot and must not be an eviction candidate",
  );
  assert.equal(await manager.evictIdleVm("bob", FLOOR), false);
  assert.equal(await manager.evictIdleVm("nobody", FLOOR), false);
});

test("evictIdleVm hibernates a live idle VM and keeps the volume", async () => {
  const clock = new FakeClock();
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  await manager.ensure("alice");
  await manager.writeFile("alice", "/workspace/keep.txt", "data");
  clock.advance(5 * MINUTE);

  assert.equal(await manager.evictIdleVm("alice", FLOOR), true);
  assert.equal(manager.isVmLive("alice"), false);
  assert.equal(manager.lastActivityAt("alice"), undefined, "activity is forgotten on hibernate");
  assert.deepEqual(manager.idleVmCandidates(FLOOR), []);

  // The next use transparently restarts the container; files survive.
  await manager.ensure("alice");
  assert.equal(manager.isVmLive("alice"), true);
  assert.equal(driver.peekFile("alice", "/workspace/keep.txt"), "data");
});

test("evictIdleVm refuses a VM idle for less than the floor", async () => {
  const clock = new FakeClock();
  const manager = managerWith(clock);

  await manager.ensure("alice");
  clock.advance(30 * SECOND); // idle 30s < 60s floor

  assert.deepEqual(manager.idleVmCandidates(FLOOR), []);
  assert.equal(await manager.evictIdleVm("alice", FLOOR), false);
  assert.equal(manager.isVmLive("alice"), true);
});

/** Fake driver whose exec blocks until released (cmd contains "block"). */
class BlockingExecVm extends FakeVmDriver {
  release: (() => void) | null = null;

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd.includes("block")) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return super.exec(handle, cmd, opts);
  }
}

test("a VM with an exec in flight is never a candidate and never evicted", async () => {
  const clock = new FakeClock();
  const driver = new BlockingExecVm();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  await manager.ensure("alice");
  const running = manager.exec("alice", ["block"]);
  // Let the exec reach the driver (slot acquired, activity touched at t=0).
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.hasActiveExec("alice"), true);

  clock.advance(10 * MINUTE); // idle past the floor, but the exec still runs
  assert.deepEqual(manager.idleVmCandidates(FLOOR), []);
  assert.equal(await manager.evictIdleVm("alice", FLOOR), false);
  assert.equal(manager.isVmLive("alice"), true);

  driver.release?.();
  await running;
});

test("eviction is disabled when hibernation is disabled", async () => {
  const clock = new FakeClock();
  const manager = managerWith(clock, 0); // SWARM_VM_IDLE_MIN=0: never hibernate

  await manager.ensure("alice");
  clock.advance(60 * MINUTE);

  assert.deepEqual(manager.idleVmCandidates(0), []);
  assert.equal(await manager.evictIdleVm("alice", 0), false);
  assert.equal(manager.isVmLive("alice"), true);
});

test("candidate listing is read-only: no ensure, no activity touch", async () => {
  const clock = new FakeClock();
  const manager = managerWith(clock);

  assert.deepEqual(manager.idleVmCandidates(FLOOR), []);
  assert.equal(manager.lastActivityAt("alice"), undefined);

  await manager.ensure("alice");
  const touchedAt = manager.lastActivityAt("alice");
  clock.advance(5 * MINUTE);
  assert.equal(manager.idleVmCandidates(FLOOR).length, 1);
  assert.equal(manager.lastActivityAt("alice"), touchedAt, "listing must not reset the idle timer");
});

test("sweepIdle still hibernates at the idle window (shared stop path)", async () => {
  const clock = new FakeClock();
  const manager = managerWith(clock);

  await manager.ensure("alice");
  await manager.ensure("bob");
  clock.advance(31 * MINUTE);

  assert.deepEqual((await manager.sweepIdle()).sort(), ["alice", "bob"]);
  assert.equal(manager.isVmLive("alice"), false);
  assert.equal(manager.isVmLive("bob"), false);
});
