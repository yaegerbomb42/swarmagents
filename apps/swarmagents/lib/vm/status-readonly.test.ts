/**
 * VM-04: GET /api/runtime/vm/status is polled every 30 s, so it must be
 * strictly read-only. It may not ensure()/exec() du/touch() anything — doing
 * so wakes hibernated VMs and resets the idle timer, so SWARM_VM_IDLE_MIN is
 * never reached.
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

/** Counts every side-effecting call the manager could make. */
class CountingDriver extends FakeVmDriver {
  ensureCalls = 0;
  execCalls = 0;
  duCalls = 0;

  override async ensure(userId: string): Promise<VmHandle> {
    this.ensureCalls++;
    return super.ensure(userId);
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execCalls++;
    if (cmd[0] === "du") this.duCalls++;
    return super.exec(handle, cmd, opts);
  }
}

const MINUTE = 60_000;

test("status of an unknown user is missing without creating a VM", async () => {
  const clock = new FakeClock();
  const driver = new CountingDriver();
  const manager = new VmManager({
    customDriver: driver,
    idle: { idleMinutes: 30 },
    quotas: { diskQuotaMb: 1 },
    now: clock.now,
  });

  const state = await manager.status("alice");
  assert.equal(state.status, "missing");
  assert.equal(driver.ensureCalls, 0, "status must not ensure a VM");
  assert.equal(driver.execCalls, 0, "status must not run anything");
  assert.equal(manager.lastActivityAt("alice"), undefined, "status must not touch activity");
});

test("polling a hibernated VM never wakes it or resets the idle timer", async () => {
  const clock = new FakeClock();
  const driver = new CountingDriver();
  const manager = new VmManager({
    customDriver: driver,
    idle: { idleMinutes: 30 },
    quotas: { diskQuotaMb: 1 },
    now: clock.now,
  });

  // A normal run populates the VM, the handle cache and the disk measurement.
  await manager.writeFile("alice", "/workspace/notes.txt", "hello");
  // writeFile checks the quota first (VM-05), which caches the pre-write
  // measurement; drop it so diskUsage measures the written file.
  manager.clearDiskUsage("alice");
  const usage = await manager.diskUsage("alice");
  assert.equal(usage.usedMb, 1);
  const ensuresAfterRun = driver.ensureCalls;
  const execsAfterRun = driver.execCalls;
  const duAfterRun = driver.duCalls;

  // Idle past the window: the sweeper hibernates the VM and forgets activity.
  clock.advance(31 * MINUTE);
  assert.deepEqual(await manager.sweepIdle(), ["alice"]);
  assert.equal(manager.lastActivityAt("alice"), undefined);

  // Thirty seconds of UI polling (many times over) changes nothing.
  for (let i = 0; i < 10; i++) {
    clock.advance(30_000);
    assert.equal((await manager.status("alice")).status, "stopped");
    const disk = manager.cachedDiskUsage("alice");
    assert.equal(disk.usedMb, 1, "status reports the last known disk usage");
    assert.equal(disk.overQuota, false);
  }

  assert.equal(driver.ensureCalls, ensuresAfterRun, "polling must not wake the VM");
  assert.equal(driver.execCalls, execsAfterRun, "polling must not run docker exec");
  assert.equal(driver.duCalls, duAfterRun, "polling must not measure disk usage");
  assert.equal(manager.lastActivityAt("alice"), undefined, "polling must not reset idle time");
  assert.equal(manager.isIdle("alice", clock.now()), false, "a forgotten VM is not re-activated");
});

test("cachedDiskUsage is 0 before the first measurement and never measures", async () => {
  const driver = new CountingDriver();
  const manager = new VmManager({
    customDriver: driver,
    quotas: { diskQuotaMb: 1 },
  });

  const disk = manager.cachedDiskUsage("alice");
  assert.deepEqual(disk, { usedMb: 0, quotaMb: 1, overQuota: false });
  assert.equal(driver.duCalls, 0);
  assert.equal(driver.ensureCalls, 0);
  assert.equal(manager.lastActivityAt("alice"), undefined);
});
