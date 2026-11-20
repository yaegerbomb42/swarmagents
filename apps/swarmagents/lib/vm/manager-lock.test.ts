import test from "node:test";
import assert from "node:assert/strict";
import { FakeVmDriver } from "./fake-driver.js";
import { VmManager } from "./manager.js";
import type { ExecOptions, ExecResult, VmHandle } from "./types.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}

/** Exec blocks until releaseExec() is called; tracks peak concurrency. */
class BlockingExecDriver extends FakeVmDriver {
  activeExecs = 0;
  maxActiveExecs = 0;
  execStarts = 0;
  resetStarts = 0;
  private pending: Array<() => void> = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execStarts++;
    this.activeExecs++;
    this.maxActiveExecs = Math.max(this.maxActiveExecs, this.activeExecs);
    await new Promise<void>((resolve) => this.pending.push(resolve));
    this.activeExecs--;
    return super.exec(handle, cmd, opts);
  }

  override async reset(handle: VmHandle): Promise<void> {
    this.resetStarts++;
    return super.reset(handle);
  }

  releaseExec(): void {
    this.pending.shift()?.();
  }

  releaseAll(): void {
    while (this.pending.length > 0) this.pending.shift()?.();
  }
}

/** reset() blocks until releaseReset(); exec is recorded and immediate. */
class GatedResetDriver extends FakeVmDriver {
  resetStarts = 0;
  resetCalls = 0;
  execCalls = 0;
  resetStarted = deferred();
  releaseReset = deferred();

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execCalls++;
    return super.exec(handle, cmd, opts);
  }

  override async reset(handle: VmHandle): Promise<void> {
    this.resetStarts++;
    this.resetStarted.resolve();
    await this.releaseReset.promise;
    this.resetCalls++;
    await super.reset(handle);
  }
}

test("VmManager allows two execs to overlap for the same user", async () => {
  const driver = new BlockingExecDriver();
  const manager = new VmManager({ customDriver: driver, quotas: { maxConcurrentExecsPerUser: 2 } });

  const first = manager.exec("overlap", ["echo", "one"]);
  const second = manager.exec("overlap", ["echo", "two"]);

  await waitFor(() => driver.execStarts === 2, "both execs to start");
  assert.equal(driver.maxActiveExecs, 2, "execs should run concurrently");

  driver.releaseAll();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => r.exitCode), [0, 0]);
});

test("VmManager reset waits for in-flight execs", async () => {
  const driver = new BlockingExecDriver();
  const manager = new VmManager({ customDriver: driver });

  const execPromise = manager.exec("waiting", ["echo", "slow"]);
  await waitFor(() => driver.execStarts === 1, "exec to start");

  let resetSettled = false;
  const resetPromise = manager.reset("waiting").then(() => {
    resetSettled = true;
  });

  await new Promise((r) => setImmediate(r));
  assert.equal(resetSettled, false, "reset must wait for the running exec");
  assert.equal(driver.resetStarts, 0, "driver.reset must not start early");

  driver.releaseExec();
  await execPromise;
  await resetPromise;
  assert.equal(driver.resetStarts, 1);
});

test("VmManager blocks new execs while a reset is running", async () => {
  const driver = new GatedResetDriver();
  const manager = new VmManager({ customDriver: driver });

  const resetPromise = manager.reset("blocking");
  await driver.resetStarted.promise;
  assert.equal(driver.resetStarts, 1, "reset should be in progress");

  const execPromise = manager.exec("blocking", ["echo", "blocked"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(driver.execCalls, 0, "exec must not start while reset holds the write lock");

  driver.releaseReset.resolve();
  await resetPromise;
  const result = await execPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(driver.execCalls, 1);
  assert.equal(driver.resetCalls, 1);
});