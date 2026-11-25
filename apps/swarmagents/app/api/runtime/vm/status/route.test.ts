/**
 * GET /api/runtime/vm/status is read-only: the 30 s UI poll must not create,
 * wake or exec in the caller's VM (VM-04). Disk usage comes from the manager's
 * last cached measurement, never from a fresh `du`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { VmManager, setVmManagerForTesting } from "../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../lib/vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../../../../../lib/vm/types";

class CountingDriver extends FakeVmDriver {
  ensureCalls = 0;
  duCalls = 0;

  override async ensure(userId: string): Promise<VmHandle> {
    this.ensureCalls++;
    return super.ensure(userId);
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "du") this.duCalls++;
    return super.exec(handle, cmd, opts);
  }
}

function request(user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest("http://localhost/api/runtime/vm/status", { headers });
}

test.afterEach(() => setVmManagerForTesting(null));

test("status route rejects unauthenticated requests", async () => {
  setVmManagerForTesting(new VmManager({ customDriver: new FakeVmDriver() }));
  assert.equal((await GET(request(null))).status, 401);
});

test("status route reports a never-seen VM as missing without creating it", async () => {
  const driver = new CountingDriver();
  const manager = new VmManager({ customDriver: driver });
  setVmManagerForTesting(manager);

  const res = await GET(request());
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.status.status, "missing");
  assert.deepEqual(body.disk, { usedMb: 0, quotaMb: 0, overQuota: false });
  assert.equal(driver.ensureCalls, 0, "polling must not create a VM");
});

test("status route serves the cached disk usage and never measures it", async () => {
  const driver = new CountingDriver();
  const manager = new VmManager({ customDriver: driver, quotas: { diskQuotaMb: 1 } });
  setVmManagerForTesting(manager);

  await manager.writeFile("alice", "/workspace/a.txt", "hello");
  // writeFile checks the quota first (VM-05), which caches the pre-write
  // measurement; drop it so diskUsage measures the written file.
  manager.clearDiskUsage("alice");
  const usage = await manager.diskUsage("alice");
  assert.equal(usage.usedMb, 1);
  const ensuresBefore = driver.ensureCalls;
  const duBefore = driver.duCalls;

  const body = (await (await GET(request())).json()) as any;
  assert.equal(body.status.status, "running");
  assert.equal(body.disk.usedMb, 1);
  assert.equal(body.desktop, false);
  assert.equal(driver.ensureCalls, ensuresBefore, "the poll must not re-ensure (wake) the VM");
  assert.equal(driver.duCalls, duBefore, "the poll must not run du");
});

test("POST status wakes/boots the caller's VM and rejects unauthenticated requests", async () => {
  const driver = new CountingDriver();
  const manager = new VmManager({ customDriver: driver });
  setVmManagerForTesting(manager);

  assert.equal((await POST(request(null))).status, 401);

  const res = await POST(request("alice"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.status.status, "running");
  assert.equal(driver.ensureCalls, 1, "POST status explicitly ensures the VM");

  // Simulate container removed/stopped outside VmManager while handle was cached:
  await driver.stop(await manager.ensure("alice"));
  const woke = await POST(request("alice"));
  assert.equal(woke.status, 200);
  const wokeBody = (await woke.json()) as any;
  assert.equal(wokeBody.status.status, "running");
  assert.equal(driver.ensureCalls, 2, "POST status recovers a dead/stopped cached container");
});
