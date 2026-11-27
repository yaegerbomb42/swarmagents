// Warm VM pool: pre-booted containers handed out on first ensure.
// Covers the pool bound + replenishment, the FakeVmDriver prewarm/adoptWarm
// isolation contract (fresh workspace + fresh VNC password), and the
// manager fast path with cold fallback.

import test from "node:test";
import assert from "node:assert/strict";
import { FakeVmDriver } from "./fake-driver";
import { VmManager } from "./manager";
import { SWARM_VM_WARM_POOL_SIZE_ENV, WarmPool, resolveWarmPoolSize } from "./warm-pool";
import type { VmDriver, VmHandle } from "./types";

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function envWith(warmPoolSize?: string): NodeJS.ProcessEnv {
  const env = { NODE_ENV: "test" } as Record<string, string>;
  if (warmPoolSize !== undefined) env[SWARM_VM_WARM_POOL_SIZE_ENV] = warmPoolSize;
  return env as NodeJS.ProcessEnv;
}

test("resolveWarmPoolSize: default 0, integer parse, invalid values disable", () => {
  assert.equal(resolveWarmPoolSize(envWith()), 0);
  assert.equal(resolveWarmPoolSize(envWith("3")), 3);
  assert.equal(resolveWarmPoolSize(envWith("0")), 0);
  assert.equal(resolveWarmPoolSize(envWith("-2")), 0);
  assert.equal(resolveWarmPoolSize(envWith("junk")), 0);
  assert.equal(resolveWarmPoolSize(envWith(" 2 ")), 2);
});

test("FakeVmDriver adoptWarm: fresh workspace and fresh VNC password per user", async () => {
  const driver = new FakeVmDriver();
  const warm = await driver.prewarm();
  assert.notEqual(warm.userId, "user-a", "warm identity is never a real user");
  assert.ok(driver.vncPasswordFor(warm));

  // Warm-phase state that must never leak into the adopted VM.
  await driver.writeFile(warm, "/workspace/leftover.txt", "warm-phase state");

  const handle = await driver.adoptWarm(warm, "user-a");
  assert.equal(handle.userId, "user-a");
  await assert.rejects(driver.readFile(handle, "/workspace/leftover.txt"), /not found/i);
  assert.notEqual(driver.vncPasswordFor(handle), driver.vncPasswordFor(warm), "VNC password is regenerated");

  // Each adoption gets its own password: no credential reuse across users.
  const warm2 = await driver.prewarm();
  const handle2 = await driver.adoptWarm(warm2, "user-b");
  assert.notEqual(driver.vncPasswordFor(handle2), driver.vncPasswordFor(handle));
});

test("FakeVmDriver adoptWarm fails closed on a missing warm VM or an occupied user", async () => {
  const driver = new FakeVmDriver();
  const phantom: VmHandle = { userId: "__warm__:gone", containerName: "fake-x", createdAt: 0 };
  await assert.rejects(driver.adoptWarm(phantom, "user-a"));

  const warm = await driver.prewarm();
  await driver.adoptWarm(warm, "user-a");
  const warm2 = await driver.prewarm();
  await assert.rejects(driver.adoptWarm(warm2, "user-a"));
});

test("FakeVmDriver cold ensure never fakes a VNC password", async () => {
  const driver = new FakeVmDriver();
  const handle = await driver.ensure("plain-user");
  assert.equal(driver.vncPasswordFor(handle), undefined);
});

test("WarmPool: fill to bound, claim pops, replenish refills, non-capable driver never pools", async () => {
  const driver = new FakeVmDriver();
  const pool = new WarmPool(driver, 2);
  assert.equal(pool.available, true);
  pool.fill();
  await until(() => pool.depth() === 2);
  const first = pool.claim();
  assert.ok(first);
  pool.fill();
  await until(() => pool.depth() === 2);

  const inert = new WarmPool({} as VmDriver, 2);
  assert.equal(inert.available, false);
  assert.equal(inert.depth(), 0);
  assert.equal(inert.claim(), undefined);
  inert.fill();
  await assert.rejects(inert.adopt({ userId: "x", containerName: "c", createdAt: 0 }, "user-a"));
});

test("VmManager ensure claims a warm VM and asynchronously replenishes the pool", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, warmPoolSize: 1 });
  assert.equal(manager.warmPoolSize, 1);
  await until(() => manager.warmPoolDepth() === 1);

  const handle = await manager.ensure("user-a");
  assert.equal(handle.userId, "user-a");
  // Proves the fast path: the handle came from adoptWarm, not a cold ensure.
  assert.ok(driver.vncPasswordFor(handle));
  await until(() => manager.warmPoolDepth() === 1);

  // A second user drains the refilled pool; a third cold-ensures instead.
  const handleB = await manager.ensure("user-b");
  assert.ok(driver.vncPasswordFor(handleB));
});

test("VmManager with an empty or disabled pool cold-ensures exactly as before", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver });
  assert.equal(manager.warmPoolSize, 0);
  assert.equal(manager.warmPoolDepth(), 0);

  const handle = await manager.ensure("user-a");
  assert.equal(handle.userId, "user-a");
  assert.equal(driver.vncPasswordFor(handle), undefined);
  assert.equal(manager.warmPoolDepth(), 0);
});

test("VmManager: warm-phase files never survive adoption into the user's VM", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, warmPoolSize: 1 });
  await until(() => manager.warmPoolDepth() === 1);

  const handle = await manager.ensure("user-a");
  await manager.writeFile("user-a", "/workspace/user-file.txt", "real work");
  const listed = (await manager.driver.listDir?.(handle, "/workspace")) ?? [];
  const names = listed.map((e) => e.name);
  assert.deepEqual(names, ["user-file.txt"], "workspace was fresh at handoff");
});
