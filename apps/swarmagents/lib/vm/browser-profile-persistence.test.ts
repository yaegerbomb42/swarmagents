// Chromium browser-profile persistence across VM idle stop and restart.
//
// The takeover/handoff loop leans on the VM browser staying signed in: the
// user solves a 2FA/SSO wall once, and the session must still be there after
// the idle sweeper hibernates the VM and the next run boots it again. That
// holds only while every invariant below stays true:
//
//   1. the profile path is a fixed constant inside /workspace (the named
//      volume every driver keeps across stop/hibernate/recreate);
//   2. the desktop image pins CHROMIUM_USER_DATA_DIR to that path, so any
//      Chromium (the launcher, the Playwright MCP) uses it without wiring;
//   3. the launcher script defaults to the same path;
//   4. driver stop() never touches the volume (contrast reset(), the only
//      path allowed to wipe it).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CHROMIUM_SINGLETON_LOCKS, VM_BROWSER_PROFILE_PATH, VM_WORKSPACE_DISK_PATH, VmManager } from "./manager.js";
import {
  DockerVmDriver,
  containerNameFor,
  volumeNameFor,
} from "./docker-driver.js";
import type { VmHandle } from "./types.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCKERFILE = path.join(APP_ROOT, "vm-image-desktop", "Dockerfile");
const LAUNCHER = path.join(APP_ROOT, "vm-image-desktop", "files", "chromium-launch.sh");

test("the browser profile lives on the /workspace named volume, not in the container", () => {
  assert.ok(
    VM_BROWSER_PROFILE_PATH.startsWith(`${VM_WORKSPACE_DISK_PATH}/`),
    `${VM_BROWSER_PROFILE_PATH} must be inside ${VM_WORKSPACE_DISK_PATH}`,
  );
  assert.match(VM_BROWSER_PROFILE_PATH, /browser-profile$/);
});

test("the desktop image pins CHROMIUM_USER_DATA_DIR to the workspace profile path", () => {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
  assert.match(
    dockerfile,
    new RegExp(`CHROMIUM_USER_DATA_DIR=${VM_BROWSER_PROFILE_PATH.replace(/\//g, "\\/")}`),
    "the image env must point Chromium's user-data dir at the workspace volume",
  );
});

test("the Chromium launcher defaults its user-data dir to the workspace profile path", () => {
  const script = fs.readFileSync(LAUNCHER, "utf8");
  const exec = script.match(/--user-data-dir="\$\{CHROMIUM_USER_DATA_DIR:-(.+?)\}"/);
  assert.ok(exec, "the launcher must pass --user-data-dir with a workspace default");
  assert.equal(exec[1], VM_BROWSER_PROFILE_PATH);
});

/** A spawn fake whose docker calls always succeed (exit 0, empty output). */
function makeSuccessSpawn() {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const spawnFn = (cmd: string, args: readonly string[], _opts?: SpawnOptions): ChildProcess => {
    calls.push({ cmd, args });
    const emitter = new PassThrough();
    const cp = {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        emitter.on(ev, fn);
        return cp;
      },
      kill: () => true,
    };
    queueMicrotask(() => {
      cp.stdout.end();
      cp.stderr.end();
      emitter.emit("close", 0);
    });
    return cp as unknown as ChildProcess;
  };
  return { spawnFn, calls };
}

const handleFor = (userId: string): VmHandle => ({
  userId,
  containerName: containerNameFor(userId),
  createdAt: Date.now(),
});

test("driver stop() stops the container and never removes the workspace volume", async () => {
  const { spawnFn, calls } = makeSuccessSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });
  const userId = "profile-user";
  await driver.stop(handleFor(userId));
  const stopCalls = calls.filter((c) => c.args[0] === "stop");
  assert.equal(stopCalls.length, 1, "exactly one docker stop");
  assert.deepEqual(stopCalls[0].args, ["stop", containerNameFor(userId)]);
  const rmCalls = calls.filter((c) => c.args[0] === "rm" || (c.args[0] === "volume" && c.args[1] === "rm"));
  assert.equal(rmCalls.length, 0, "an idle stop must not delete the volume (the browser profile lives there)");
});

test("driver reset() is the only path that wipes the workspace volume", async () => {
  const { spawnFn, calls } = makeSuccessSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });
  const userId = "profile-user";
  await driver.reset(handleFor(userId));
  const volumeRm = calls.find((c) => c.args[0] === "volume" && c.args[1] === "rm");
  assert.ok(volumeRm, "reset removes the volume");
  assert.equal(volumeRm.args[3], volumeNameFor(userId), "reset removes exactly this user's workspace volume");
});

test("VmManager.ensure clears stale Chromium SingletonLock files on container boot", async () => {
  const execCalls: string[][] = [];
  const fakeDriver = {
    async ensure(userId: string) {
      return handleFor(userId);
    },
    async exec(_handle: VmHandle, cmd: string[]) {
      execCalls.push(cmd);
      return { exitCode: 0 };
    },
    async stop() {},
    async reset() {},
    async readFile() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
  };
  const manager = new VmManager({ customDriver: fakeDriver as never, warmPoolSize: 0 });
  await manager.cleanStaleBrowserLocks("u1");
  const lockCleanup = execCalls.find((cmd) => cmd[0] === "rm" && cmd.includes(CHROMIUM_SINGLETON_LOCKS[0]));
  assert.ok(lockCleanup, "cleanStaleBrowserLocks removes stale SingletonLock, SingletonCookie, and SingletonSocket");
  assert.deepEqual(lockCleanup, ["rm", "-f", "--", ...CHROMIUM_SINGLETON_LOCKS]);
});
