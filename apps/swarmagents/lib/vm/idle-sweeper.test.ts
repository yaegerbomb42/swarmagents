import test from "node:test";
import assert from "node:assert/strict";
import { IdleSweeper, type SetIntervalFn } from "./idle-sweeper";
import { FakeVmDriver } from "./fake-driver";
import { VmManager } from "./manager";

interface FakeVm {
  lastUsed: number;
}

/** Minimal manager surface the sweeper uses; decisions stay in this fake. */
function fakeManager(vms: Record<string, FakeVm>, windowMs = 1_000) {
  const calls: number[] = [];
  const manager = {
    idle: { idleMinutes: 1, idleMs: windowMs, sweepIntervalMs: 500 },
    usersInPreHibernateWindow: (now: number) =>
      Object.entries(vms)
        .filter(([, vm]) => now - vm.lastUsed >= windowMs)
        .map(([userId]) => userId),
    sweepIdle: async (now: number) => {
      calls.push(now);
      return Object.entries(vms)
        .filter(([, vm]) => now - vm.lastUsed >= windowMs)
        .map(([userId]) => userId);
    },
  } as unknown as VmManager;
  return { manager, calls };
}

test("a sweep hibernates idle VMs and skips recently used ones", async () => {
  const vms = { idle: { lastUsed: 0 }, active: { lastUsed: 9_500 } };
  const { manager, calls } = fakeManager(vms);
  const hibernated: string[][] = [];
  const sweeper = new IdleSweeper({
    manager,
    now: () => 10_000,
    onHibernated: (ids) => hibernated.push(ids),
  });

  const result = await sweeper.sweep();
  assert.deepEqual(result, ["idle"]);
  assert.deepEqual(hibernated, [["idle"]]);
  assert.deepEqual(calls, [10_000], "the fake clock is passed to sweepIdle");
});

test("a hibernate failure is reported and the next sweep still runs", async () => {
  const { manager } = fakeManager({ idle: { lastUsed: 0 } });
  let fail = true;
  const original = manager.sweepIdle;
  manager.sweepIdle = async (now: number) => {
    if (fail) throw new Error("driver stop failed");
    return original(now);
  };
  const errors: unknown[] = [];
  const sweeper = new IdleSweeper({
    manager,
    now: () => 10_000,
    onError: (error) => errors.push(error),
  });

  assert.deepEqual(await sweeper.sweep(), []);
  assert.equal(errors.length, 1);

  fail = false;
  assert.deepEqual(await sweeper.sweep(), ["idle"]);
});

test("onIdleWindow runs before sweepIdle and a hook failure does not stop the sweep", async () => {
  const { manager, calls } = fakeManager({ idle: { lastUsed: 0 } });
  const order: string[] = [];
  const sweeper = new IdleSweeper({
    manager,
    now: () => 10_000,
    onIdleWindow: async (ids) => {
      order.push(`window:${ids.join(",")}`);
      throw new Error("hook failed");
    },
    onHibernated: () => order.push("hibernated"),
    onError: () => order.push("error"),
  });

  assert.deepEqual(await sweeper.sweep(), ["idle"]);
  assert.deepEqual(order, ["window:idle", "error", "hibernated"]);
  assert.deepEqual(calls, [10_000]);
});

test("always-on users are never hibernated while ordinary idle VMs are", async () => {
  let now = 0;
  const driver = new FakeVmDriver();
  const manager = new VmManager({
    customDriver: driver,
    now: () => now,
    idle: { idleMinutes: 1 },
    alwaysOnUsers: new Set(["always"]),
  });
  const alwaysHandle = await manager.ensure("always");
  await manager.ensure("regular");
  assert.equal(manager.isAlwaysOnUser("always"), true);
  assert.equal(manager.isAlwaysOnUser("regular"), false);

  // Both VMs are now past the 60s idle window.
  now = 2 * 60_000;
  const sweeper = new IdleSweeper({ manager, now: () => now });
  const hibernated = await sweeper.sweep();

  assert.ok(hibernated.includes("regular"), "the ordinary idle VM hibernates");
  assert.equal(hibernated.includes("always"), false, "the 24/7 VM is exempt");
  assert.equal(manager.isVmLive("always"), true);
  assert.equal(manager.isVmLive("regular"), false);
  assert.equal((await driver.status(alwaysHandle)).status, "running");
});

test("a stopped always-on VM is re-ensured by the health sweep", async () => {
  let now = 0;
  const driver = new FakeVmDriver();
  const manager = new VmManager({
    customDriver: driver,
    now: () => now,
    idle: { idleMinutes: 1 },
    isAlwaysOn: (userId) => userId === "always",
  });
  const handle = await manager.ensure("always");
  await driver.stop(handle); // the container dies behind the manager's back
  assert.equal((await driver.status(handle)).status, "stopped");

  const originalEnsure = driver.ensure.bind(driver);
  let ensureCalls = 0;
  driver.ensure = async (userId: string) => {
    ensureCalls++;
    return originalEnsure(userId);
  };

  now = 2 * 60_000;
  const sweeper = new IdleSweeper({ manager, now: () => now });
  assert.deepEqual(await sweeper.sweep(), []);
  assert.equal(ensureCalls, 1, "ensure() was called to restart the dead container");
  assert.equal((await driver.status(handle)).status, "running");
  assert.equal(manager.isVmLive("always"), true);
});

test("start/stop are idempotent and respect a disabled interval", () => {
  const { manager } = fakeManager({});
  const handles: object[] = [];
  const cleared: object[] = [];
  const setIntervalFn: SetIntervalFn = () => {
    const handle = {};
    handles.push(handle);
    return handle;
  };
  const sweeper = new IdleSweeper({
    manager,
    setIntervalFn,
    clearIntervalFn: (handle) => cleared.push(handle as object),
  });

  sweeper.start();
  sweeper.start();
  assert.equal(handles.length, 1, "starting twice does not stack timers");
  assert.equal(sweeper.running, true);
  sweeper.stop();
  sweeper.stop();
  assert.equal(cleared.length, 1);
  assert.equal(sweeper.running, false);

  const disabled = new IdleSweeper({
    manager: { ...manager, idle: { ...manager.idle, sweepIntervalMs: 0 } } as unknown as VmManager,
    setIntervalFn,
  });
  disabled.start();
  assert.equal(disabled.running, false);
});
