import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireFileLock,
  FileLockTimeoutError,
  isFileLockTimeoutError,
} from "./file-lock.js";

let dir = "";
let lockPath = "";

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-file-lock-test-"));
  lockPath = path.join(dir, "users.json.lock");
});

test.afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("acquire creates the lock file and release removes it", async () => {
  const release = await acquireFileLock(lockPath);
  assert.ok(fs.existsSync(lockPath), "lock file exists while held");
  // The token records the owning pid for operator debugging.
  assert.match(fs.readFileSync(lockPath, "utf-8"), new RegExp(`^${process.pid}:`));
  release();
  assert.ok(!fs.existsSync(lockPath), "lock file removed on release");
  // Release is idempotent.
  release();
  assert.ok(!fs.existsSync(lockPath));
});

test("a second acquire waits until the first holder releases", async () => {
  const order: string[] = [];
  const releaseFirst = await acquireFileLock(lockPath);
  order.push("first-acquired");
  const second = acquireFileLock(lockPath, { retryMs: 5 }).then((release) => {
    order.push("second-acquired");
    return release;
  });
  // Give the second acquire ample chances to (incorrectly) barge in.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(order, ["first-acquired"], "second acquire must still be waiting");
  order.push("first-releasing");
  releaseFirst();
  const releaseSecond = await second;
  assert.deepEqual(order, ["first-acquired", "first-releasing", "second-acquired"]);
  releaseSecond();
});

test("a stale lock left by a crashed holder is broken", async () => {
  // Simulate a crashed holder: lock file with an old mtime.
  fs.writeFileSync(lockPath, "999999:deadbeef:0", { mode: 0o600 });
  const longAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, longAgo, longAgo);
  const release = await acquireFileLock(lockPath, { staleMs: 1_000, timeoutMs: 2_000 });
  assert.match(fs.readFileSync(lockPath, "utf-8"), new RegExp(`^${process.pid}:`));
  release();
  assert.ok(!fs.existsSync(lockPath));
});

test("a fresh lock held by someone else times out instead of being broken", async () => {
  fs.writeFileSync(lockPath, "424242:cafef00d:0", { mode: 0o600 });
  await assert.rejects(
    acquireFileLock(lockPath, { staleMs: 60_000, timeoutMs: 200, retryMs: 10 }),
    (err: unknown) => {
      assert.ok(isFileLockTimeoutError(err));
      assert.ok(err instanceof FileLockTimeoutError);
      assert.equal((err as FileLockTimeoutError).lockPath, lockPath);
      return true;
    },
  );
  // The other holder's lock is untouched.
  assert.equal(fs.readFileSync(lockPath, "utf-8"), "424242:cafef00d:0");
});

test("release does not delete a lock that was broken and re-acquired by someone else", async () => {
  const release = await acquireFileLock(lockPath);
  // Simulate: we were judged stale, our lock broken, another holder took it.
  fs.writeFileSync(lockPath, "31337:beefcafe:0", { mode: 0o600 });
  release();
  assert.equal(
    fs.readFileSync(lockPath, "utf-8"),
    "31337:beefcafe:0",
    "the new holder's lock must survive our release",
  );
});

test("acquire creates the lock directory when it does not exist yet", async () => {
  const nested = path.join(dir, "deep", "deeper", "users.json.lock");
  const release = await acquireFileLock(nested);
  assert.ok(fs.existsSync(nested));
  release();
  assert.ok(!fs.existsSync(nested));
});
