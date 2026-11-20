import test from "node:test";
import assert from "node:assert/strict";
import { FakeVmDriver } from "./fake-driver.js";
import { VmManager } from "./manager.js";
import { validateSnapshotLabel } from "./docker-driver.js";
import type { ExecOptions, ExecResult, VmHandle } from "./types.js";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A driver whose restore always fails, counting ensures. */
class FailingRestoreDriver extends FakeVmDriver {
  ensureCalls = 0;
  failRestore = true;

  override async ensure(userId: string): Promise<VmHandle> {
    this.ensureCalls++;
    return super.ensure(userId);
  }

  override async restore(handle: VmHandle, label: string): Promise<void> {
    if (this.failRestore) throw new Error("restore boom");
    return super.restore(handle, label);
  }
}

/** ensure() blocks until released; restore/exec are counted. */
class GatedEnsureDriver extends FakeVmDriver {
  ensureCalls = 0;
  restoreCalls = 0;
  execCalls = 0;
  ensureStarted = deferred();
  releaseEnsure = deferred();

  override async ensure(userId: string): Promise<VmHandle> {
    this.ensureCalls++;
    this.ensureStarted.resolve();
    await this.releaseEnsure.promise;
    return super.ensure(userId);
  }

  override async restore(): Promise<void> {
    this.restoreCalls++;
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execCalls++;
    return super.exec(handle, cmd, opts);
  }
}

test("FakeVmDriver snapshots and restores files and running state", async () => {
  const driver = new FakeVmDriver();
  const handle = await driver.ensure("alice");
  await driver.writeFile(handle, "/workspace/notes.txt", "before");

  const snap = await driver.snapshot(handle, "before-edit");
  assert.equal(snap.label, "before-edit");
  assert.ok(snap.createdAt > 0);

  await driver.writeFile(handle, "/workspace/notes.txt", "after");
  await driver.stop(handle);
  await driver.restore(handle, "before-edit");

  assert.equal(await driver.readFile(handle, "/workspace/notes.txt"), "before");
  assert.equal((await driver.status(handle)).status, "running");
});

test("FakeVmDriver lists snapshots per user, newest first", async () => {
  const driver = new FakeVmDriver();
  const alice = await driver.ensure("alice");
  const bob = await driver.ensure("bob");

  await driver.snapshot(alice, "first");
  await new Promise((r) => setTimeout(r, 2));
  await driver.snapshot(alice, "second");
  await driver.snapshot(bob, "other");

  const list = await driver.listSnapshots(alice);
  assert.deepEqual(list.map((s) => s.label), ["second", "first"]);
  assert.deepEqual((await driver.listSnapshots(bob)).map((s) => s.label), ["other"]);
});

test("FakeVmDriver restore rejects an unknown label", async () => {
  const driver = new FakeVmDriver();
  const handle = await driver.ensure("alice");
  await assert.rejects(() => driver.restore(handle, "ghost"), /Snapshot not found/);
});

test("FakeVmDriver deleteSnapshot removes the snapshot and rejects unknown labels", async () => {
  const driver = new FakeVmDriver();
  const handle = await driver.ensure("alice");
  await driver.snapshot(handle, "to-delete");
  await driver.snapshot(handle, "to-keep");

  await driver.deleteSnapshot(handle, "to-delete");
  assert.deepEqual((await driver.listSnapshots(handle)).map((s) => s.label), ["to-keep"]);
  await assert.rejects(() => driver.restore(handle, "to-delete"), /Snapshot not found/);
  await assert.rejects(() => driver.deleteSnapshot(handle, "to-delete"), /Snapshot not found/);
  await assert.rejects(() => driver.deleteSnapshot(handle, "ghost"), /Snapshot not found/);
});

test("VmManager deleteSnapshot round-trips through the route's path", async () => {
  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver });

  await vm.snapshot("alice", "checkpoint-1");
  assert.deepEqual((await vm.listSnapshots("alice")).map((s) => s.label), ["checkpoint-1"]);

  await vm.deleteSnapshot("alice", "checkpoint-1");
  assert.deepEqual(await vm.listSnapshots("alice"), []);
  await assert.rejects(() => vm.deleteSnapshot("alice", "checkpoint-1"), /Snapshot not found/);
  await assert.rejects(() => vm.deleteSnapshot("alice", "UPPER"), /Invalid snapshot label/);
});

test("VmManager snapshot/listSnapshots/restore round-trips", async () => {
  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver });

  await vm.writeFile("alice", "/workspace/app.txt", "v1");
  const created = await vm.snapshot("alice", "checkpoint-1");
  assert.equal(created.label, "checkpoint-1");

  await vm.writeFile("alice", "/workspace/app.txt", "v2");
  assert.equal(await vm.readFile("alice", "/workspace/app.txt"), "v2");

  const list = await vm.listSnapshots("alice");
  assert.deepEqual(list.map((s) => s.label), ["checkpoint-1"]);

  await vm.restore("alice", "checkpoint-1");
  assert.equal(await vm.readFile("alice", "/workspace/app.txt"), "v1");
});

test("VmManager rejects invalid labels before touching the driver", async () => {
  const driver = new FakeVmDriver();
  const vm = new VmManager({ customDriver: driver });

  for (const label of ["", "UPPER", "has space", "../escape", "a/b", "x".repeat(65)]) {
    await assert.rejects(() => vm.snapshot("alice", label), /Invalid snapshot label/);
    await assert.rejects(() => vm.restore("alice", label), /Invalid snapshot label/);
  }
});

test("validateSnapshotLabel accepts safe docker tag labels", () => {
  for (const label of ["base", "before-edit", "v1.2", "a_b", "checkpoint-2026"]) {
    assert.doesNotThrow(() => validateSnapshotLabel(label));
  }
  for (const label of ["", "Snap", "snap!", "snap:tag", "/abs", "a..b", "-lead", "x".repeat(65)]) {
    assert.throws(() => validateSnapshotLabel(label), /Invalid snapshot label/);
  }
});

// ---------------------------------------------------------------------------
// VM-08: a failed restore must not leave a stale handle cached
// ---------------------------------------------------------------------------

test("a failed restore invalidates the cached handle so the next op re-ensures", async () => {
  const driver = new FailingRestoreDriver();
  const vm = new VmManager({ customDriver: driver });

  await vm.writeFile("alice", "/workspace/app.txt", "v1");
  assert.equal(driver.ensureCalls, 1);

  await assert.rejects(() => vm.restore("alice", "checkpoint-1"), /restore boom/);

  // The container may already have been removed before the failed `docker
  // run`; the manager must not keep serving the dead handle.
  assert.equal((await vm.status("alice")).status, "missing", "the stale handle is dropped");

  driver.failRestore = false;
  assert.equal(await vm.readFile("alice", "/workspace/app.txt"), "v1");
  assert.equal(driver.ensureCalls, 2, "the next operation re-ensures the VM");
});

test("restore ensures and runs under the per-user write lock", async () => {
  const driver = new GatedEnsureDriver();
  const vm = new VmManager({ customDriver: driver });

  const restorePromise = vm.restore("alice", "checkpoint-1");
  await driver.ensureStarted.promise;

  // The restore holds the write lock while its ensure (and the driver's
  // inspect/rm/run) is in flight: an exec must wait, not interleave.
  const execPromise = vm.exec("alice", ["echo", "blocked"]);
  await flush();
  assert.equal(driver.execCalls, 0, "exec must not start during a restore");
  assert.equal(driver.restoreCalls, 0, "restore waits for its ensure");

  driver.releaseEnsure.resolve();
  await restorePromise;
  assert.equal(driver.restoreCalls, 1);

  const result = await execPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(driver.execCalls, 1);
});
