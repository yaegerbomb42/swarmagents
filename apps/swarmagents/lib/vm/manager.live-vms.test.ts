/**
 * FIX-19 support: isVmLive / liveVmUserIds report which user VMs currently
 * hold host resources (ensured and not stopped/hibernated/reset). The
 * runtime manager's global concurrent-VM cap counts these, so a hibernated
 * VM (volume kept, container stopped) must not count, and the checks must
 * stay read-only (never ensure or touch activity — polling must not wake
 * a VM or reset its idle timer).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { FakeVmDriver } from "./fake-driver.js";
import { VmManager } from "./manager.js";

class FakeClock {
  private t = 0;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

const MINUTE = 60_000;

test("unknown user is not live; ensure makes it live", async () => {
  const manager = new VmManager({ customDriver: new FakeVmDriver() });
  assert.equal(manager.isVmLive("alice"), false);
  assert.deepEqual(manager.liveVmUserIds(), []);

  await manager.ensure("alice");
  assert.equal(manager.isVmLive("alice"), true);
  assert.deepEqual(manager.liveVmUserIds(), ["alice"]);
});

test("stop and reset release liveness; re-ensure restores it", async () => {
  const manager = new VmManager({ customDriver: new FakeVmDriver() });
  await manager.ensure("alice");

  await manager.stop("alice");
  assert.equal(manager.isVmLive("alice"), false);
  assert.deepEqual(manager.liveVmUserIds(), []);

  await manager.ensure("alice");
  assert.equal(manager.isVmLive("alice"), true);

  await manager.reset("alice");
  assert.equal(manager.isVmLive("alice"), false);
  assert.deepEqual(manager.liveVmUserIds(), []);
});

test("hibernation releases liveness for every idle VM", async () => {
  const clock = new FakeClock();
  const manager = new VmManager({
    customDriver: new FakeVmDriver(),
    idle: { idleMinutes: 30 },
    now: clock.now,
  });
  await manager.ensure("alice");
  await manager.ensure("bob");
  assert.deepEqual(manager.liveVmUserIds().sort(), ["alice", "bob"]);

  clock.advance(31 * MINUTE);
  assert.deepEqual((await manager.sweepIdle()).sort(), ["alice", "bob"]);
  assert.equal(manager.isVmLive("alice"), false);
  assert.equal(manager.isVmLive("bob"), false);
  assert.deepEqual(manager.liveVmUserIds(), []);

  // The next use transparently restarts the container and counts again.
  await manager.ensure("alice");
  assert.deepEqual(manager.liveVmUserIds(), ["alice"]);
});

test("a VM with activity inside the idle window stays live across sweeps", async () => {
  const clock = new FakeClock();
  const manager = new VmManager({
    customDriver: new FakeVmDriver(),
    idle: { idleMinutes: 30 },
    now: clock.now,
  });
  await manager.ensure("alice");

  clock.advance(29 * MINUTE);
  assert.deepEqual(await manager.sweepIdle(), []);
  assert.equal(manager.isVmLive("alice"), true);

  clock.advance(2 * MINUTE);
  assert.deepEqual(await manager.sweepIdle(), ["alice"]);
  assert.equal(manager.isVmLive("alice"), false);
});

test("liveness checks are read-only: no ensure, no activity touch", async () => {
  const clock = new FakeClock();
  const manager = new VmManager({ customDriver: new FakeVmDriver(), now: clock.now });
  assert.equal(manager.isVmLive("alice"), false);
  assert.deepEqual(manager.liveVmUserIds(), []);
  assert.equal(manager.lastActivityAt("alice"), undefined, "liveness must not touch activity");

  await manager.ensure("alice");
  const touchedAt = manager.lastActivityAt("alice");
  clock.advance(5 * MINUTE);
  assert.equal(manager.isVmLive("alice"), true);
  assert.deepEqual(manager.liveVmUserIds(), ["alice"]);
  assert.equal(manager.lastActivityAt("alice"), touchedAt, "liveness must not reset the idle timer");
});
