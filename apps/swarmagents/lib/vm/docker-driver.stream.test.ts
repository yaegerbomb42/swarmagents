// Regression tests for the VM-02 EPIPE crash.
//
// A docker child that exits before its stdin is drained (target is a
// directory, workspace full, container gone) emits EPIPE on the child's stdio
// stream. Without listeners that becomes an uncaught exception and takes down
// the Next.js process. The driver must (a) reject the exec promise with a
// typed EPIPE-class error and (b) never leave an `error` event unhandled.
//
// These tests use an injectable spawn so no Docker daemon is required.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { DockerVmDriver, containerNameFor } from "./docker-driver.js";
import { VmStreamError, installCrashGuard, isKnownStreamError } from "./stream-errors.js";
import type { VmHandle } from "./types.js";

interface FakeChild {
  cp: ChildProcess;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  emitClose: (code: number | null) => void;
}

/** A minimal ChildProcess with real streams and an EventEmitter core. */
function fakeChild(opts: { stdin?: Writable } = {}): FakeChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = opts.stdin ?? new PassThrough();
  const cp = Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    kill: () => {
      emitter.emit("close", 143);
      return true;
    },
  }) as unknown as ChildProcess;
  return {
    cp,
    stdin,
    stdout,
    stderr,
    emitClose: (code) => emitter.emit("close", code),
  };
}

const handle = (userId = "alice"): VmHandle => ({
  userId,
  containerName: containerNameFor(userId),
  createdAt: Date.now(),
});

/** An errno-style error, as a child stream would emit it. */
const errnoError = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

test("exec rejects with EPIPE when the child closes stdin early", async () => {
  // Writable whose first write fails with EPIPE, exactly like a child that
  // exited before consuming its input.
  const brokenStdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(errnoError("EPIPE", "write EPIPE"));
    },
  });
  const child = fakeChild({ stdin: brokenStdin });
  const driver = new DockerVmDriver({ spawnFn: () => child.cp, desktop: false });

  await assert.rejects(
    driver.exec(handle(), ["sh", "-c", "cat > \"$1\"", "sh", "/workspace/uploads/dir"], {
      stdin: "x".repeat(1024 * 1024),
    }),
    (err: unknown) => {
      assert.ok(err instanceof VmStreamError, "expected a typed VmStreamError");
      assert.equal(err.stream, "stdin");
      assert.equal(err.code, "EPIPE");
      assert.ok(isKnownStreamError(err));
      return true;
    },
  );

  // A missing listener would have thrown while the pipeline tore down. Give
  // any late event a turn; the test process must still be alive here.
  await new Promise((resolve) => setImmediate(resolve));
});

test("exec rejects when spawn returns no stdin but input was supplied", async () => {
  const child = fakeChild();
  // Simulate a spawn configured without a stdin pipe.
  (child.cp as unknown as { stdin: null }).stdin = null;
  const driver = new DockerVmDriver({ spawnFn: () => child.cp, desktop: false });

  await assert.rejects(
    driver.exec(handle(), ["cat"], { stdin: "payload" }),
    (err: unknown) => err instanceof VmStreamError && err.stream === "stdin" && err.code === "EPIPE",
  );
});

test("a broken stdout pipe settles exec instead of crashing", async () => {
  const child = fakeChild();
  const driver = new DockerVmDriver({ spawnFn: () => child.cp, desktop: false });

  const pending = driver.exec(handle(), ["echo", "hi"]);
  child.stdout.emit("error", errnoError("EPIPE", "write EPIPE"));

  await assert.rejects(
    pending,
    (err: unknown) => err instanceof VmStreamError && err.stream === "stdout" && err.code === "EPIPE",
  );
});

test("installCrashGuard ignores known stream errors and keeps serving", () => {
  const target = new EventEmitter();
  const logs: string[] = [];
  let exits = 0;
  const uninstall = installCrashGuard({
    target,
    log: (message) => logs.push(message),
    exit: () => {
      exits += 1;
    },
  });

  try {
    assert.doesNotThrow(() => target.emit("uncaughtException", errnoError("EPIPE")));
    assert.doesNotThrow(() => target.emit("unhandledRejection", errnoError("ECONNRESET")));
    assert.equal(exits, 0, "known stream errors must not exit the process");
    assert.equal(logs.length, 2);
    assert.match(logs[0], /keeps serving/);
  } finally {
    uninstall();
  }
});

test("installCrashGuard still exits on an unknown error", () => {
  const target = new EventEmitter();
  const logs: string[] = [];
  let exits = 0;
  const uninstall = installCrashGuard({
    target,
    log: (message) => logs.push(message),
    exit: () => {
      exits += 1;
    },
  });

  try {
    target.emit("uncaughtException", new Error("unexpected"));
    assert.equal(exits, 1, "unknown errors must remain fatal");
    assert.match(logs[0], /fatal uncaught exception/);
  } finally {
    uninstall();
  }
});

test("readFile refuses a file larger than the buffered-output cap", async () => {
  const child = fakeChild();
  const driver = new DockerVmDriver({
    spawnFn: () => child.cp,
    desktop: false,
    maxRunStdoutBytes: 8,
  });

  const pending = driver.readFile(handle(), "/workspace/big.txt");
  child.stdout.write(Buffer.alloc(100, 0x61));
  // Let the PassThrough deliver before the close lands.
  await new Promise((resolve) => setImmediate(resolve));
  child.emitClose(0);

  await assert.rejects(pending, /buffered read cap/);
});

test("readFile returns content under the cap unchanged", async () => {
  const child = fakeChild();
  const driver = new DockerVmDriver({
    spawnFn: () => child.cp,
    desktop: false,
    maxRunStdoutBytes: 8,
  });

  const pending = driver.readFile(handle(), "/workspace/small.txt");
  child.stdout.write("hello");
  await new Promise((resolve) => setImmediate(resolve));
  child.emitClose(0);

  assert.equal(await pending, "hello");
});

test("runRaw keeps only the stderr tail past the cap", async () => {
  const child = fakeChild();
  const driver = new DockerVmDriver({
    spawnFn: () => child.cp,
    desktop: false,
    maxRunStderrBytes: 8,
  });

  // status() surfaces stderr as the error on a non-zero inspect.
  const pending = driver.status(handle());
  child.stderr.write(`${"x".repeat(90)}TAILMARKER`);
  await new Promise((resolve) => setImmediate(resolve));
  child.emitClose(1);

  const state = await pending;
  assert.equal(state.status, "missing");
  assert.equal(state.error, "ILMARKER");
});
