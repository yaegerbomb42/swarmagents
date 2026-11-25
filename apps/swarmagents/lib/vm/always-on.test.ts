// 24/7 mode: persistent VM lifecycle & idle-sweeper hardening.
//
// A VM flagged always-on (24/7) is never stopped by the idle sweeper, a VM
// with an exec in flight is never stopped either, and a stopped VM
// transparently restarts on the next exec with /workspace intact. The
// docker driver also restarts containers left in the "created" state —
// otherwise ensure() would hand back a handle for a container that never
// runs and the next exec would fail.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { FakeVmDriver } from "./fake-driver.js";
import { VmManager } from "./manager.js";
import {
  DockerVmDriver,
  VM_OWNER_LABEL,
  containerNameFor,
  ownerKeyFor,
  volumeNameFor,
  type DockerSpawnFn,
} from "./docker-driver.js";
import { parseAlwaysOnUsers, resolveIdlePolicy } from "./idle.js";
import type { ExecOptions, ExecResult, VmHandle } from "./types.js";

const MINUTE = 60_000;

class FakeClock {
  private t = 0;
  readonly now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await flush();
  }
}

/** Exec blocks until releaseExec(); stop() is counted. */
class BlockingExecDriver extends FakeVmDriver {
  execStarts = 0;
  stops = 0;
  private pending: Array<() => void> = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execStarts++;
    await new Promise<void>((resolve) => this.pending.push(resolve));
    return super.exec(handle, cmd, opts);
  }

  override async stop(handle: VmHandle): Promise<void> {
    this.stops++;
    return super.stop(handle);
  }

  releaseExec(): void {
    this.pending.shift()?.();
  }
}

// ---------------------------------------------------------------------------
// 24/7 flag parsing
// ---------------------------------------------------------------------------

test("parseAlwaysOnUsers trims, drops empties, and dedupes", () => {
  assert.deepEqual(parseAlwaysOnUsers(undefined), []);
  assert.deepEqual(parseAlwaysOnUsers(""), []);
  assert.deepEqual(parseAlwaysOnUsers("alice, bob ,alice,, carol "), ["alice", "bob", "carol"]);
  assert.deepEqual(parseAlwaysOnUsers(["alice", "alice", "bob"]), ["alice", "bob"]);
});

test("resolveIdlePolicy reads SWARM_VM_ALWAYS_ON_USERS", () => {
  const prev = process.env.SWARM_VM_ALWAYS_ON_USERS;
  try {
    process.env.SWARM_VM_ALWAYS_ON_USERS = "alice, bob,alice";
    assert.deepEqual(resolveIdlePolicy().alwaysOnUsers, ["alice", "bob"]);

    delete process.env.SWARM_VM_ALWAYS_ON_USERS;
    assert.deepEqual(resolveIdlePolicy().alwaysOnUsers, []);

    // Explicit options win over the env list.
    process.env.SWARM_VM_ALWAYS_ON_USERS = "alice";
    assert.deepEqual(resolveIdlePolicy({ alwaysOnUsers: ["carol"] }).alwaysOnUsers, ["carol"]);
  } finally {
    if (prev === undefined) delete process.env.SWARM_VM_ALWAYS_ON_USERS;
    else process.env.SWARM_VM_ALWAYS_ON_USERS = prev;
  }
});

// ---------------------------------------------------------------------------
// The sweeper never stops a 24/7 VM
// ---------------------------------------------------------------------------

test("a 24/7-flagged VM is never hibernated, however long it is idle", async () => {
  const clock = new FakeClock();
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  await manager.exec("alice", ["echo", "hi"]);
  await manager.exec("bob", ["echo", "hi"]);
  manager.setAlwaysOn("alice");

  assert.equal(manager.isAlwaysOn("alice"), true);
  assert.equal(manager.isAlwaysOn("bob"), false);
  assert.deepEqual(manager.alwaysOnUserIds(), ["alice"]);

  // 10 hours idle: far past the 30-minute window.
  clock.advance(10 * 60 * MINUTE);

  assert.equal(manager.isIdle("alice"), false, "a 24/7 VM is never idle for sweep purposes");
  assert.equal(manager.isIdle("bob"), true);
  assert.deepEqual(manager.usersInPreHibernateWindow(), [], "no pre-hibernate window for a 24/7 VM");
  assert.deepEqual(await manager.sweepIdle(), ["bob"]);
  assert.equal((await manager.status("alice")).status, "running");
  assert.equal((await manager.status("bob")).status, "stopped");
});

test("clearing the 24/7 flag re-enables hibernation", async () => {
  const clock = new FakeClock();
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  await manager.exec("alice", ["echo", "hi"]);
  manager.setAlwaysOn("alice");
  clock.advance(60 * MINUTE);
  assert.deepEqual(await manager.sweepIdle(), [], "flagged: never swept");

  manager.setAlwaysOn("alice", false);
  assert.equal(manager.isAlwaysOn("alice"), false);
  assert.deepEqual(await manager.sweepIdle(), ["alice"], "unflagged: swept like any idle VM");
  assert.equal((await manager.status("alice")).status, "stopped");
});

test("SWARM_VM_ALWAYS_ON_USERS flags users at construction", async () => {
  const prev = process.env.SWARM_VM_ALWAYS_ON_USERS;
  const clock = new FakeClock();
  try {
    process.env.SWARM_VM_ALWAYS_ON_USERS = "alice,carol";
    const driver = new FakeVmDriver();
    const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

    assert.deepEqual(manager.alwaysOnUserIds().sort(), ["alice", "carol"]);

    await manager.exec("alice", ["echo", "hi"]);
    await manager.exec("bob", ["echo", "hi"]);
    await manager.exec("carol", ["echo", "hi"]);
    clock.advance(60 * MINUTE);

    assert.deepEqual(await manager.sweepIdle(), ["bob"], "only the unflagged VM is hibernated");
  } finally {
    if (prev === undefined) delete process.env.SWARM_VM_ALWAYS_ON_USERS;
    else process.env.SWARM_VM_ALWAYS_ON_USERS = prev;
  }
});

test("the 24/7 flag survives stop and reset", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 } });

  await manager.exec("alice", ["echo", "hi"]);
  manager.setAlwaysOn("alice");
  await manager.stop("alice");
  assert.equal(manager.isAlwaysOn("alice"), true, "a manual stop does not clear the flag");

  await manager.exec("alice", ["echo", "hi"]);
  await manager.reset("alice");
  assert.equal(manager.isAlwaysOn("alice"), true, "reset wipes the VM, not the lifecycle preference");
});

// ---------------------------------------------------------------------------
// Active-exec protection
// ---------------------------------------------------------------------------

test("sweepIdle never stops a VM with a running exec, even a 24/7 one", async () => {
  const clock = new FakeClock();
  const driver = new BlockingExecDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  manager.setAlwaysOn("alice");
  const execPromise = manager.exec("alice", ["echo", "slow"]);
  await waitFor(() => driver.execStarts === 1, "exec to start");

  // Time passes well beyond the idle window while the exec is running.
  clock.advance(45 * MINUTE);

  assert.deepEqual(await manager.sweepIdle(), [], "no VM may be hibernated during an exec");
  assert.equal(driver.stops, 0, "the driver must not be stopped during an exec");
  assert.equal((await manager.status("alice")).status, "running");

  driver.releaseExec();
  assert.equal((await execPromise).exitCode, 0, "the running exec completes normally");
  assert.equal(driver.stops, 0, "still never stopped: the 24/7 flag outlives the exec");
});

// ---------------------------------------------------------------------------
// Transparent restart
// ---------------------------------------------------------------------------

test("a hibernated VM transparently restarts on next exec with /workspace intact", async () => {
  const clock = new FakeClock();
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver, idle: { idleMinutes: 30 }, now: clock.now });

  await manager.writeFile("alice", "/workspace/keep.txt", "persisted");
  clock.advance(31 * MINUTE);
  assert.deepEqual(await manager.sweepIdle(), ["alice"]);
  assert.equal((await manager.status("alice")).status, "stopped");

  const chunks: string[] = [];
  const result = await manager.exec("alice", ["cat", "/workspace/keep.txt"], {
    onStdout: (c) => chunks.push(c),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(chunks.join(""), "persisted", "the workspace volume survives hibernation");
  assert.equal((await manager.status("alice")).status, "running");
});

// ---------------------------------------------------------------------------
// Docker driver: a container left in "created" restarts on ensure()
// ---------------------------------------------------------------------------

interface ScriptedResult {
  code: number;
  stdout: string;
  stderr?: string;
}

/**
 * A fake docker CLI: answers each call from a script keyed on argv and
 * records every call, so ensure() can be driven without a daemon.
 */
function scriptedSpawn(
  script: (args: readonly string[]) => ScriptedResult,
  calls: string[][],
): DockerSpawnFn {
  return ((_command: string, args: readonly string[]) => {
    calls.push([...args]);
    const { code, stdout, stderr = "" } = script(args);
    const emitter = new EventEmitter();
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const stdinStream = new PassThrough();
    const cp = Object.assign(emitter, {
      stdout: stdoutStream,
      stderr: stderrStream,
      stdin: stdinStream,
      kill: () => true,
    }) as unknown as ChildProcess;
    setImmediate(() => {
      if (stdout) stdoutStream.write(stdout);
      if (stderr) stderrStream.write(stderr);
      stdoutStream.end();
      stderrStream.end();
      emitter.emit("close", code, null);
    });
    return cp;
  }) as DockerSpawnFn;
}

test("docker ensure() starts a container left in the created state", async () => {
  const userId = "alice";
  const name = containerNameFor(userId);
  const vol = volumeNameFor(userId);
  const labels = JSON.stringify({ [VM_OWNER_LABEL]: ownerKeyFor(userId) });
  const calls: string[][] = [];

  const driver = new DockerVmDriver({
    desktop: false,
    spawnFn: scriptedSpawn((args) => {
      if (args[0] === "volume" && args[1] === "ls") return { code: 0, stdout: `${vol}\n` };
      if (args[0] === "container" && args[1] === "inspect") {
        return { code: 0, stdout: `created\t${labels}` };
      }
      if (args[0] === "update") return { code: 0, stdout: name };
      if (args[0] === "start") return { code: 0, stdout: `${name}\n` };
      return { code: 1, stdout: "", stderr: `unexpected docker call: ${args.join(" ")}` };
    }, calls),
  });

  const handle = await driver.ensure(userId);
  assert.equal(handle.containerName, name);

  const starts = calls.filter((args) => args[0] === "start");
  assert.equal(starts.length, 1, "a created container is started on ensure()");
  assert.deepEqual(starts[0], ["start", name]);
});
