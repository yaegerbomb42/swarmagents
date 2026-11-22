import test from "node:test";
import assert from "node:assert/strict";
import { LockTimeoutError, RwLock } from "./rw-lock";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settlesWithin(promise: Promise<void>, ms = 20): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

test("multiple shared holders can run concurrently", async () => {
  const lock = new RwLock();
  await lock.acquireRead();
  await lock.acquireRead();

  let writerGranted = false;
  const writer = lock.acquireWrite().then(() => {
    writerGranted = true;
  });
  await tick();
  assert.equal(writerGranted, false, "a writer waits while readers hold the lock");

  lock.releaseRead();
  await tick();
  assert.equal(writerGranted, false, "one remaining reader still blocks the writer");

  lock.releaseRead();
  assert.equal(await settlesWithin(writer), true, "the writer starts after the last reader");
  lock.releaseWrite();
});

test("an exclusive waiter drains every shared holder before running", async () => {
  const lock = new RwLock();
  await lock.acquireRead();
  await lock.acquireRead();

  let writerGranted = false;
  const writer = lock.acquireWrite().then(() => {
    writerGranted = true;
  });
  await tick();

  lock.releaseRead();
  await tick();
  assert.equal(writerGranted, false);
  lock.releaseRead();
  assert.equal(await settlesWithin(writer), true);
  lock.releaseWrite();
});

test("a waiting writer blocks new readers (documented fairness)", async () => {
  const lock = new RwLock();
  await lock.acquireRead();
  const writer = lock.acquireWrite();
  await tick();

  let lateReaderGranted = false;
  const lateReader = lock.acquireRead().then(() => {
    lateReaderGranted = true;
  });
  await tick();
  assert.equal(lateReaderGranted, false, "a new reader queues behind the writer");

  lock.releaseRead();
  assert.equal(await settlesWithin(writer), true, "the writer is not starved by late readers");
  await tick();
  assert.equal(lateReaderGranted, false, "the late reader still waits for the writer");

  lock.releaseWrite();
  assert.equal(await settlesWithin(lateReader), true, "the late reader runs after the writer");
  lock.releaseRead();
});

test("queued readers are granted together after the writer releases", async () => {
  const lock = new RwLock();
  await lock.acquireWrite();
  let granted = 0;
  const readers = [
    lock.acquireRead().then(() => {
      granted += 1;
    }),
    lock.acquireRead().then(() => {
      granted += 1;
    }),
  ];
  await tick();
  assert.equal(granted, 0);

  lock.releaseWrite();
  await Promise.all(readers);
  assert.equal(granted, 2);
  lock.releaseRead();
  lock.releaseRead();
});

// --- Acquire timeouts (hardening: a leaked release must not wedge waiters) ---

test("acquireWrite times out while a reader holds the lock", async () => {
  const lock = new RwLock();
  await lock.acquireRead();
  await assert.rejects(lock.acquireWrite(20), (err: unknown) => {
    assert.ok(err instanceof LockTimeoutError);
    assert.equal((err as LockTimeoutError).code, "LOCK_TIMEOUT");
    return true;
  });
  lock.releaseRead();
  // The lock is still fully usable after a timeout.
  await lock.acquireWrite();
  lock.releaseWrite();
});

test("acquireRead times out while a writer holds the lock", async () => {
  const lock = new RwLock();
  await lock.acquireWrite();
  await assert.rejects(lock.acquireRead(20), LockTimeoutError);
  lock.releaseWrite();
  await lock.acquireRead();
  lock.releaseRead();
});

test("a timed-out writer unblocks readers queued behind it", async () => {
  const lock = new RwLock();
  await lock.acquireRead();
  const writer = lock.acquireWrite(20);
  let readerGranted = false;
  const reader = lock.acquireRead().then(() => {
    readerGranted = true;
  });
  await tick();
  assert.equal(readerGranted, false, "reader queues behind the writer (fairness)");
  await assert.rejects(writer, LockTimeoutError);
  // Writer dequeued: the reader may now share with the existing reader.
  assert.equal(await settlesWithin(reader), true, "reader granted once the writer times out");
  lock.releaseRead();
  lock.releaseRead();
  await lock.acquireWrite();
  lock.releaseWrite();
});

test("a waiter granted before its timeout does not reject", async () => {
  const lock = new RwLock();
  await lock.acquireRead();
  const writer = lock.acquireWrite(1_000);
  lock.releaseRead();
  assert.equal(await settlesWithin(writer), true);
  lock.releaseWrite();
});

test("an infinite timeout waits like no timeout", async () => {
  const lock = new RwLock();
  await lock.acquireWrite();
  let granted = false;
  const reader = lock.acquireRead(Number.POSITIVE_INFINITY).then(() => {
    granted = true;
  });
  await tick();
  await tick();
  assert.equal(granted, false, "Infinity must not arm a near-immediate timer");
  lock.releaseWrite();
  assert.equal(await settlesWithin(reader), true);
  lock.releaseRead();
});
