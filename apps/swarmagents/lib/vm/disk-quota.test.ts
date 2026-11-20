import test from "node:test";
import assert from "node:assert/strict";
import { VmManager } from "./manager";
import { FakeVmDriver } from "./fake-driver";
import { QuotaError } from "./quotas";
import type { ExecOptions, ExecResult, VmHandle } from "./types";

class CountingFake extends FakeVmDriver {
  duCalls = 0;

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "du") this.duCalls += 1;
    return super.exec(handle, cmd, opts);
  }
}

/** 1 MiB string. */
function mib(n: number): string {
  return "x".repeat(1024 * 1024 * n);
}

/**
 * Seed files directly through the driver. The manager's writeFile is itself
 * quota-gated (VM-05), so it must not be used to set up an over-quota state.
 */
async function seed(
  driver: FakeVmDriver,
  userId: string,
  path: string,
  content: string,
): Promise<void> {
  const handle = await driver.ensure(userId);
  await driver.writeFile(handle, path, content);
}

test("VmManager reports workspace disk usage from du and flags over-quota", async () => {
  const driver = new CountingFake();
  const manager = new VmManager({
    customDriver: driver,
    quotas: { diskQuotaMb: 1 },
  });

  // Empty workspace: under the quota.
  const empty = await manager.diskUsage("alice");
  assert.equal(empty.usedMb, 0);
  assert.equal(empty.quotaMb, 1);
  assert.equal(empty.overQuota, false);

  // Fill 2 MB -> over a 1 MB quota. The empty measurement above is cached,
  // so drop it (as the 60 s TTL would) before re-measuring.
  await seed(driver, "alice", "/workspace/big.bin", mib(2));
  manager.clearDiskUsage("alice");
  const over = await manager.diskUsage("alice");
  assert.equal(over.usedMb, 2);
  assert.equal(over.overQuota, true);

  await assert.rejects(
    manager.assertDiskQuota("alice"),
    (err: unknown) =>
      err instanceof QuotaError &&
      err.kind === "disk_quota" &&
      err.limit === 1 &&
      err.userId === "alice" &&
      /exceeds the quota/.test(err.message),
  );

  // Reset wipes the workspace: usage drops back to 0 and the run gate opens.
  await manager.reset("alice");
  const after = await manager.diskUsage("alice");
  assert.equal(after.usedMb, 0);
  assert.equal(after.overQuota, false);
  await manager.assertDiskQuota("alice"); // does not throw
});

test("VmManager disk usage is cached for 60s", async () => {
  const driver = new CountingFake();
  let t = 1_000_000;
  const manager = new VmManager({
    customDriver: driver,
    quotas: { diskQuotaMb: 1 },
    now: () => t,
  });

  await seed(driver, "alice", "/workspace/a.bin", mib(2));
  assert.equal((await manager.diskUsage("alice")).usedMb, 2);
  const firstCalls = driver.duCalls;
  assert.ok(firstCalls >= 1);

  // Grow the workspace without measuring: the cached value is still served.
  await seed(driver, "alice", "/workspace/b.bin", mib(1));
  assert.equal((await manager.diskUsage("alice")).usedMb, 2);
  assert.equal(driver.duCalls, firstCalls);

  // 59s later the cache is still valid.
  t += 59_000;
  assert.equal((await manager.diskUsage("alice")).usedMb, 2);
  assert.equal(driver.duCalls, firstCalls);

  // After the TTL expires the measurement re-runs and sees the new file.
  t += 2_000;
  assert.equal((await manager.diskUsage("alice")).usedMb, 3);
  assert.equal(driver.duCalls, firstCalls + 1);
});

test("VmManager disk quota of 0 disables the quota", async () => {
  const driver = new CountingFake();
  const manager = new VmManager({
    customDriver: driver,
    quotas: { diskQuotaMb: 0 },
  });

  await seed(driver, "alice", "/workspace/big.bin", mib(2));
  const usage = await manager.diskUsage("alice");
  assert.equal(usage.quotaMb, 0);
  assert.equal(usage.overQuota, false);
  await manager.assertDiskQuota("alice"); // does not throw
});

test("VmManager disk usage is per-user", async () => {
  const driver = new CountingFake();
  const manager = new VmManager({
    customDriver: driver,
    quotas: { diskQuotaMb: 1 },
  });

  await seed(driver, "alice", "/workspace/big.bin", mib(2));
  const alice = await manager.diskUsage("alice");
  const bob = await manager.diskUsage("bob");
  assert.equal(alice.overQuota, true);
  assert.equal(bob.overQuota, false);
});
