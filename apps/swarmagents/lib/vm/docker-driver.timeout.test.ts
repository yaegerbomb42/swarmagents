// FIX-05 regression tests: every docker CLI call is deadline-bound.
//
// A wedged Docker daemon must fail the operation with a typed
// DockerTimeoutError (and kill the CLI: SIGTERM, then SIGKILL after the
// grace period) instead of holding the per-user VM lock forever. These
// tests use an injectable spawn so no Docker daemon is required.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_DOCKER_TIMEOUTS,
  DockerTimeoutError,
  DockerVmDriver,
  containerNameFor,
  dockerTimeoutClassFor,
} from "./docker-driver.js";
import { VmManager } from "./manager.js";
import type { VmHandle } from "./types.js";

interface HangingChild {
  cp: ChildProcess;
  kills: string[];
}

/**
 * A docker CLI that never answers: SIGTERM is recorded and ignored, only
 * SIGKILL ends it (close with a null code, like a real killed process).
 */
function hangingChild(): HangingChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const kills: string[] = [];
  const cp = Object.assign(emitter, {
    stdout,
    stderr,
    stdin,
    kill: (signal?: string) => {
      kills.push(signal ?? "SIGTERM");
      if (signal === "SIGKILL") {
        emitter.emit("close", null, "SIGKILL");
      }
      return true;
    },
  }) as unknown as ChildProcess;
  return { cp, kills };
}

const handle = (userId = "alice"): VmHandle => ({
  userId,
  containerName: containerNameFor(userId),
  createdAt: Date.now(),
});

function hangingDriver(child: HangingChild): DockerVmDriver {
  return new DockerVmDriver({
    spawnFn: () => child.cp,
    desktop: false,
    killGraceMs: 15,
    dockerTimeouts: { quick: 40, standard: 40, long: 40, commit: 40 },
  });
}

/** Fail fast instead of hanging the suite if a deadline regresses. */
async function within<T>(promise: Promise<T>, ms = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("a wedged docker CLI times out with a typed error and is SIGKILLed", async () => {
  const child = hangingChild();
  const driver = hangingDriver(child);

  await assert.rejects(within(driver.status(handle())), (err: unknown) => {
    assert.ok(err instanceof DockerTimeoutError, "expected a typed DockerTimeoutError");
    assert.equal(err.command, "container");
    assert.equal(err.timeoutMs, 40);
    assert.match(err.message, /timed out after 40ms/);
    return true;
  });
  // SIGTERM first, SIGKILL after the grace period: no zombie CLI.
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("docker deadline classes: inspect/ls/info quick, commit longest, default standard", () => {
  assert.equal(dockerTimeoutClassFor(["container", "inspect", "-f", "x", "c"]), "quick");
  assert.equal(dockerTimeoutClassFor(["image", "inspect", "img"]), "quick");
  assert.equal(dockerTimeoutClassFor(["volume", "ls", "-q"]), "quick");
  assert.equal(dockerTimeoutClassFor(["info"]), "quick");
  assert.equal(dockerTimeoutClassFor(["run", "-d", "img"]), "long");
  assert.equal(dockerTimeoutClassFor(["create", "img"]), "long");
  assert.equal(dockerTimeoutClassFor(["cp", "src", "c:/dst"]), "long");
  assert.equal(dockerTimeoutClassFor(["commit", "c", "img"]), "commit");
  assert.equal(dockerTimeoutClassFor(["stop", "c"]), "standard");
  assert.equal(dockerTimeoutClassFor(["exec", "c", "true"]), "standard");
  assert.equal(dockerTimeoutClassFor(["volume", "create", "v"]), "standard");

  // Built-in budgets: quick < standard < long < commit, none infinite.
  assert.equal(DEFAULT_DOCKER_TIMEOUTS.quick, 15_000);
  assert.equal(DEFAULT_DOCKER_TIMEOUTS.standard, 30_000);
  assert.equal(DEFAULT_DOCKER_TIMEOUTS.long, 120_000);
  assert.equal(DEFAULT_DOCKER_TIMEOUTS.commit, 300_000);
});

test("exec backstop kills a wedged CLI and resolves 124", async () => {
  const child = hangingChild();
  const driver = hangingDriver(child);

  const res = await within(driver.exec(handle(), ["sleep", "100"], { timeoutMs: 30 }));
  assert.equal(res.exitCode, 124);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("a timed-out ensure releases the per-user lock (next ensure settles too)", async () => {
  const child = hangingChild();
  const manager = new VmManager({ customDriver: hangingDriver(child) });

  await assert.rejects(within(manager.ensure("alice")), (err: unknown) => {
    assert.ok(err instanceof DockerTimeoutError, "expected a typed DockerTimeoutError");
    return true;
  });
  // Before FIX-05 this second call queued behind a lock that never freed.
  await assert.rejects(within(manager.ensure("alice")), (err: unknown) => {
    assert.ok(err instanceof DockerTimeoutError, "expected a typed DockerTimeoutError");
    return true;
  });
});
