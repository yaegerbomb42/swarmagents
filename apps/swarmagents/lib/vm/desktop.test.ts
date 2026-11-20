// Desktop-mode tests for the Docker VM driver.
//
// Desktop mode is opt-in via SWARM_VM_DESKTOP=1 (or the constructor `desktop`
// option). It must: pick the desktop image, size /dev/shm for a browser,
// seed a generated VNC password through a node-owned pre-start tar entry,
// never publish ports, and expose desktopEndpoint(). Non-desktop behavior is
// unchanged — covered by the existing driver tests, plus the direct
// buildRunArgs assertions down below.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFileSync } from "node:child_process";
import { configureAuditPath } from "../audit.js";
import {
  DockerVmDriver,
  VmUnavailableError,
  buildRunArgs,
  desktopVncTarArgs,
  generateVncPassword,
  containerNameFor,
  volumeNameFor,
  snapshotVolumeFor,
  ownerKeyFor,
  legacyContainerNameFor,
  legacyVolumeNameFor,
  VM_OWNER_LABEL,
  SWARM_VM_DESKTOP_IMAGE,
  DEFAULT_DESKTOP_IMAGE,
  DESKTOP_DISPLAY,
  DESKTOP_VNC_PORT,
  DESKTOP_SHM_SIZE,
  DESKTOP_VNC_PASSWORD_ENV,
  DESKTOP_VNC_PASSWORD_FILE,
} from "./docker-driver.js";
import { DEFAULT_VM_DESKTOP_MEMORY } from "./limits.js";
import type { VmHandle } from "./types.js";

interface FakeSpawnCall {
  cmd: string;
  args: readonly string[];
  opts: SpawnOptions;
  cp: {
    emitClose: (code: number | null) => void;
    emitError: (err: Error) => void;
    kill: (sig?: string) => boolean;
    killed: boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
}

function makeFakeSpawn() {
  const calls: FakeSpawnCall[] = [];
  const spawnFn = (cmd: string, args: readonly string[], opts?: SpawnOptions): ChildProcess => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const emitter = new EventEmitter();
    const call: FakeSpawnCall = {
      cmd,
      args,
      opts: opts ?? {},
      cp: {
        emitClose: (code) => emitter.emit("close", code),
        emitError: (err) => emitter.emit("error", err),
        kill: (sig) => {
          call.cp.killed = true;
          emitter.emit("close", 143);
          return true;
        },
        killed: false,
        stdout,
        stderr,
      },
    };
    calls.push(call);
    const cp: Record<string, unknown> = {
      stdout,
      stderr,
      stdin: new PassThrough(),
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        emitter.on(ev, fn);
        return cp;
      },
      kill: call.cp.kill,
    };
    return cp as unknown as ChildProcess;
  };
  return { spawnFn, calls };
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * Wait until a spawned docker call matching `pred` appears. The desktop
 * create path touches the host filesystem between spawns, so a single
 * setImmediate is not a reliable barrier.
 */
async function waitForCall(
  calls: FakeSpawnCall[],
  pred: (call: FakeSpawnCall) => boolean,
  timeoutMs = 1000,
): Promise<FakeSpawnCall> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = calls.find(pred);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for a docker call");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const handle = (userId = "alice"): VmHandle => ({
  userId,
  containerName: containerNameFor(userId),
  createdAt: Date.now(),
});

/** The owner fingerprint a VM container/volume for `userId` must carry. */
const keyFor = (userId: string) => ownerKeyFor(userId);

/** The labels JSON docker returns for an owned container of `userId`. */
const labelJson = (userId: string) => JSON.stringify({ [VM_OWNER_LABEL]: keyFor(userId) });

/** stdout for `docker container inspect` with status + owner labels (ensure path). */
const statusWithLabels = (status: string, userId: string) => `${status}\t${labelJson(userId)}\n`;

/** stdout for the desktopEndpoint inspect (status + IP + owner labels). */
const endpointInspect = (status: string, ip: string, userId: string) =>
  `${status}\t${ip}\t${labelJson(userId)}\n`;

const baseRunOpts = {
  containerName: "swarm-vm-alice",
  volume: "swarm-vm-alice-workspace",
  image: "swarm-vm:desktop",
  memory: "2g",
  cpus: "2",
  pidsLimit: "512",
};

// ---------------------------------------------------------------------------
// testRunArgs — desktop vs non-desktop
// ---------------------------------------------------------------------------

test("buildRunArgs desktop mode sizes shm, forwards env by name, never publishes ports", () => {
  const argv = buildRunArgs({
    ...baseRunOpts,
    desktop: true,
    shmSize: DESKTOP_SHM_SIZE,
    env: { DISPLAY: DESKTOP_DISPLAY, [DESKTOP_VNC_PASSWORD_ENV]: "s3cr3t-vnc" },
  });

  // shm-size present, value correct.
  assert.ok(argv.includes("--shm-size"));
  assert.equal(argv[argv.indexOf("--shm-size") + 1], "1g");

  // No port publishing at all (-p / --publish / --publish-all).
  assert.ok(!argv.includes("-p"));
  assert.ok(!argv.includes("--publish"));
  assert.ok(!argv.includes("--publish-all"));
  assert.ok(!argv.some((a) => /^\d+(\.\d+)?:\d+/.test(a)), "no host:container port mapping");

  // Env forwarded by NAME only; values must never appear in argv.
  assert.ok(argv.includes("-e"));
  assert.ok(argv.includes("DISPLAY"));
  assert.ok(argv.includes(DESKTOP_VNC_PASSWORD_ENV));
  const joined = argv.join(" ");
  assert.ok(!joined.includes("s3cr3t-vnc"), "VNC password must not appear in argv");
  assert.ok(!argv.some((a) => a === DESKTOP_DISPLAY), "DISPLAY value must not appear in argv");

  // Desktop image CMD runs; no tail placeholder.
  assert.ok(!argv.includes("tail"));
  assert.ok(!argv.includes("/dev/null"));
});

test("buildRunArgs without desktop stays headless (tail CMD, no shm, no env)", () => {
  const argv = buildRunArgs({
    ...baseRunOpts,
    image: "swarm-vm:claude",
  });
  assert.ok(argv.includes("tail"));
  assert.equal(argv[argv.indexOf("tail") + 1], "-f");
  assert.ok(!argv.includes("--shm-size"));
  assert.ok(!argv.includes("-e"));
  assert.ok(!argv.includes("-p"));
});

// ---------------------------------------------------------------------------
// Driver constructor — desktop defaults
// ---------------------------------------------------------------------------

test("DockerVmDriver desktop mode defaults to the desktop image and memory", () => {
  const driver = new DockerVmDriver({ desktop: true });
  assert.equal(driver.desktop, true);
  assert.equal(driver.image, SWARM_VM_DESKTOP_IMAGE);
  assert.equal(SWARM_VM_DESKTOP_IMAGE, DEFAULT_DESKTOP_IMAGE);
  assert.equal(driver.memory, DEFAULT_VM_DESKTOP_MEMORY);
});

test("DockerVmDriver desktop mode honors explicit image and memory overrides", () => {
  const driver = new DockerVmDriver({ desktop: true, image: "my-desktop:tag", memory: "4g" });
  assert.equal(driver.image, "my-desktop:tag");
  assert.equal(driver.memory, "4g");
});

test("DockerVmDriver non-desktop keeps the headless image", () => {
  const driver = new DockerVmDriver({ desktop: false });
  assert.equal(driver.desktop, false);
  assert.equal(driver.image, "swarm-vm:claude");
  assert.notEqual(driver.image, DEFAULT_DESKTOP_IMAGE);
});

// ---------------------------------------------------------------------------
// generateVncPassword
// ---------------------------------------------------------------------------

test("generateVncPassword returns a random, non-empty password", () => {
  const a = generateVncPassword({});
  const b = generateVncPassword({});
  assert.ok(a.length >= 12);
  assert.notEqual(a, b);
  assert.ok(!/\s/.test(a));
});

test("generateVncPassword honors an explicit env override (test hook)", () => {
  const p = generateVncPassword({ [DESKTOP_VNC_PASSWORD_ENV]: "fixed-password" });
  assert.equal(p, "fixed-password");
});

// ---------------------------------------------------------------------------
// desktopVncTarArgs — portable VNC password seeding (BSD vs GNU tar)
// ---------------------------------------------------------------------------

test("desktopVncTarArgs uses GNU spelling on Linux and BSD spelling on macOS", () => {
  // GNU tar (Linux) rejects the BSD flags --uid/--gid/--no-xattrs outright,
  // which broke desktop VNC seeding on every Linux Docker host.
  const linux = desktopVncTarArgs("linux");
  assert.deepEqual(linux, ["--owner=1000", "--group=1000"]);
  assert.ok(!linux.some((a) => a === "--uid" || a === "--gid" || a === "--no-xattrs"));

  const macos = desktopVncTarArgs("darwin");
  assert.deepEqual(macos, ["--no-xattrs", "--uid", "1000", "--gid", "1000"]);

  // Any other platform falls back to the GNU spelling (the Linux Docker
  // hosts desktop mode actually runs on).
  assert.deepEqual(desktopVncTarArgs("win32"), ["--owner=1000", "--group=1000"]);
});

test("desktopVncTarArgs builds a real node-owned tar entry with the host tar", () => {
  // Live check against the host tar (GNU 1.35 on this Linux VM): the exact
  // archive seedDesktopPassword streams into `docker cp` must build and
  // carry uid/gid 1000. Skipped on non-Linux hosts is not an option here —
  // the default spelling is the host platform's, so this runs everywhere.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-vnc-tar-"));
  try {
    const entryName = path.basename(DESKTOP_VNC_PASSWORD_FILE);
    fs.writeFileSync(path.join(dir, entryName), "test-password\n", { mode: 0o600 });
    const tarball = execFileSync(
      "tar",
      ["-cf", "-", ...desktopVncTarArgs(), "-C", dir, entryName],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.ok(tarball.length > 0, "expected a non-empty tar archive");
    const listing = execFileSync("tar", ["-tvf", "-", "--numeric-owner"], {
      input: tarball,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
    // GNU tar prints `1000/1000`; BSD tar (macOS) prints `1000   1000`.
    assert.match(listing, /1000[\s/]+1000/, `expected uid/gid 1000 in: ${listing}`);
    assert.ok(listing.includes(entryName), `expected ${entryName} in: ${listing}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensure() — desktop create / reuse
// ---------------------------------------------------------------------------

test("DockerVmDriver.ensure desktop mode creates with shm, no secret env and no ports", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });

  const p = driver.ensure("alice");
  calls[0].cp.emitClose(0); // volume ls (no output -> volume missing)
  await flush();
  calls[1].cp.emitClose(0); // volume create (with owner label)
  await flush();
  calls[2].cp.emitClose(1); // inspectStatusLabels -> not found
  await flush();
  calls[3].cp.emitClose(1); // legacy container inspect -> not found
  await flush();
  calls[4].cp.stdout.emit("data", Buffer.from(""));
  calls[4].cp.emitClose(0); // legacy volume ls -> empty
  await flush();
  calls[5].cp.emitClose(0); // image inspect -> found
  await flush();

  // Desktop mode creates the container first (so the password can be copied
  // in as a file), then copies + starts it.
  const createCall = calls.find((c) => c.args[0] === "create");
  assert.ok(createCall, "expected a docker create argv");
  const argv = createCall!.args;
  assert.ok(argv.includes("--shm-size"));
  assert.equal(argv[argv.indexOf("--shm-size") + 1], "1g");
  assert.ok(argv.includes("-e"));
  assert.ok(argv.includes("DISPLAY"));
  // The VNC password must NOT be in the container environment (VM-10).
  assert.ok(!argv.includes(DESKTOP_VNC_PASSWORD_ENV));
  assert.ok(!createCall!.opts.env?.[DESKTOP_VNC_PASSWORD_ENV]);
  assert.ok(!argv.includes("-p"));
  assert.ok(!argv.includes("tail"), "desktop image CMD must run, not tail");
  // The created container carries the owner label.
  assert.ok(argv.includes("--label"));
  assert.ok(argv.includes(`${VM_OWNER_LABEL}=${keyFor("alice")}`));

  createCall!.cp.emitClose(0);

  // The password is copied in as a 0600, node-owned file before start.
  const copyCall = await waitForCall(calls, (c) => c.args[0] === "cp");
  assert.equal(copyCall.args[1], "-");
  assert.ok(!copyCall.args.some((arg) => arg.startsWith("--chown")));
  assert.ok(copyCall.args[copyCall.args.length - 1].endsWith(":/home/node/.vnc/"));
  copyCall.cp.emitClose(0);

  const startCall = await waitForCall(calls, (c) => c.args[0] === "start");
  assert.equal(startCall.args[1], containerNameFor("alice"));
  startCall.cp.emitClose(0);
  const h = await p;
  assert.equal(h.containerName, containerNameFor("alice"));

  // After ensure, desktopEndpoint serves the same generated password.
  const endpointP = driver.desktopEndpoint(h);
  const inspect = calls[calls.length - 1];
  inspect.cp.stdout.emit("data", Buffer.from(endpointInspect("running", "172.30.0.5", "alice")));
  inspect.cp.emitClose(0);
  const endpoint = await endpointP;
  assert.equal(endpoint?.host, "172.30.0.5");
  assert.equal(endpoint?.port, DESKTOP_VNC_PORT);
  assert.ok((endpoint?.password.length ?? 0) >= 12, "expected a generated VNC password");
});

test("DockerVmDriver.ensure reattaches an existing desktop container (one container per user)", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });

  // First ensure: full create path.
  const p1 = driver.ensure("alice");
  calls[0].cp.emitClose(0);
  await flush();
  calls[1].cp.emitClose(0);
  await flush();
  calls[2].cp.emitClose(1);
  await flush();
  calls[3].cp.emitClose(1);
  await flush();
  calls[4].cp.stdout.emit("data", Buffer.from(""));
  calls[4].cp.emitClose(0);
  await flush();
  calls[5].cp.emitClose(0);
  await flush();
  const create1 = calls.find((c) => c.args[0] === "create");
  assert.ok(create1);
  create1!.cp.emitClose(0);
  (await waitForCall(calls, (c) => c.args[0] === "cp")).cp.emitClose(0); // docker cp password
  (await waitForCall(calls, (c) => c.args[0] === "start")).cp.emitClose(0); // docker start
  await p1;

  const createCountBefore = calls.filter((c) => c.args[0] === "create").length;

  // Second ensure: same image, no recreate — just re-applies limits.
  const p2 = driver.ensure("alice");
  // The first spawn (volume ls) is recorded synchronously, so the index of
  // the first new call is calls.length - 1.
  const start = calls.length - 1;
  calls[start].cp.stdout.emit("data", Buffer.from(`${volumeNameFor("alice")}\n`));
  calls[start].cp.emitClose(0); // volume ls -> exists
  await flush();
  calls[start + 1].cp.stdout.emit("data", Buffer.from(statusWithLabels("running", "alice")));
  calls[start + 1].cp.emitClose(0); // inspectStatusLabels -> running, owned
  await flush();
  calls[start + 2].cp.stdout.emit("data", Buffer.from(`${SWARM_VM_DESKTOP_IMAGE}\n`));
  calls[start + 2].cp.emitClose(0); // desktopImageMismatch: same image ref -> no mismatch
  await flush();
  const updateCall = calls.find((c) => c.args[0] === "update");
  assert.ok(updateCall, "expected a docker update for the existing container");
  updateCall!.cp.emitClose(0);
  await p2;

  const createCountAfter = calls.filter((c) => c.args[0] === "create").length;
  assert.equal(createCountAfter, createCountBefore, "re-ensure must not recreate the container");
});

test("DockerVmDriver.ensure recreates a headless container when desktop mode is on", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });

  const p = driver.ensure("alice");
  calls[0].cp.stdout.emit("data", Buffer.from(`${volumeNameFor("alice")}\n`));
  calls[0].cp.emitClose(0); // volume ls -> exists
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from(statusWithLabels("running", "alice")));
  calls[1].cp.emitClose(0); // inspectStatusLabels -> running, owned
  await flush();
  // desktopImageMismatch: inspect image ref + compare image ids.
  calls[2].cp.stdout.emit("data", Buffer.from("swarm-vm:claude\n"));
  calls[2].cp.emitClose(0);
  await flush();
  calls[3].cp.stdout.emit("data", Buffer.from("sha256:aaa\n"));
  calls[3].cp.emitClose(0);
  await flush();
  calls[4].cp.stdout.emit("data", Buffer.from("sha256:bbb\n"));
  calls[4].cp.emitClose(0);
  await flush();
  calls[5].cp.emitClose(0); // image inspect (create branch)
  await flush();
  const createCall = calls.find((c) => c.args[0] === "create");
  assert.ok(createCall, "expected a recreation from the desktop image");
  assert.equal(createCall!.args[createCall!.args.indexOf("--name") + 1], containerNameFor("alice"));
  createCall!.cp.emitClose(0);
  (await waitForCall(calls, (c) => c.args[0] === "cp")).cp.emitClose(0); // docker cp password
  (await waitForCall(calls, (c) => c.args[0] === "start")).cp.emitClose(0); // docker start
  await p;
});

test("DockerVmDriver.ensure keeps a headless container when desktop mode is off (unchanged)", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });

  const p = driver.ensure("alice");
  calls[0].cp.emitClose(0); // volume ls -> missing
  await flush();
  calls[1].cp.emitClose(0); // volume create
  await flush();
  calls[2].cp.stdout.emit("data", Buffer.from(statusWithLabels("running", "alice")));
  calls[2].cp.emitClose(0); // inspectStatusLabels -> running, owned, no image check
  await flush();
  calls[3].cp.emitClose(0); // docker update
  await p;

  const runCalls = calls.filter((c) => c.args[0] === "run");
  assert.equal(runCalls.length, 0, "headless re-ensure must not create a container");
});

// ---------------------------------------------------------------------------
// desktopEndpoint
// ---------------------------------------------------------------------------

test("desktopEndpoint returns null for non-desktop drivers without touching docker", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });
  const endpoint = await driver.desktopEndpoint(handle());
  assert.equal(endpoint, null);
  assert.equal(calls.length, 0);
});

test("desktopEndpoint returns null when the container is missing", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });
  const p = driver.desktopEndpoint(handle());
  calls[0].cp.emitClose(1); // inspect -> not found
  assert.equal(await p, null);
});

test("desktopEndpoint returns null when the container is not running", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });
  const p = driver.desktopEndpoint(handle());
  calls[0].cp.stdout.emit("data", Buffer.from(endpointInspect("exited", "172.30.0.5", "alice")));
  calls[0].cp.emitClose(0);
  assert.equal(await p, null);
});

test("desktopEndpoint reads the VNC password back from the container when not cached", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });
  const p = driver.desktopEndpoint(handle());
  calls[0].cp.stdout.emit("data", Buffer.from(endpointInspect("running", "172.30.0.9", "alice")));
  calls[0].cp.emitClose(0);
  await flush();
  assert.equal(calls.length, 2);
  const read = calls[1];
  assert.deepEqual(read.args, ["exec", containerNameFor("alice"), "cat", "--", DESKTOP_VNC_PASSWORD_FILE]);
  read.cp.stdout.emit("data", Buffer.from("read-back-password\n"));
  read.cp.emitClose(0);
  const endpoint = await p;
  assert.deepEqual(endpoint, { host: "172.30.0.9", port: DESKTOP_VNC_PORT, password: "read-back-password" });
});

test("desktopEndpoint returns null when the password cannot be recovered", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });
  const p = driver.desktopEndpoint(handle());
  calls[0].cp.stdout.emit("data", Buffer.from(endpointInspect("running", "172.30.0.9", "alice")));
  calls[0].cp.emitClose(0);
  await flush();
  calls[1].cp.emitClose(1); // cat -> missing
  assert.equal(await p, null);
});

// ---------------------------------------------------------------------------
// exec() — DISPLAY forwarding
// ---------------------------------------------------------------------------

test("DockerVmDriver.exec in desktop mode forwards DISPLAY by name, value in spawn env", async () => {
  const oldDisplay = process.env.DISPLAY;
  delete process.env.DISPLAY;
  try {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn, desktop: true });
    const p = driver.exec(handle(), ["xdotool", "getactivewindow"]);
    const c = calls[0];
    assert.equal(c.opts.env!.DISPLAY, DESKTOP_DISPLAY);
    assert.ok(c.args.includes("-e"));
    assert.ok(c.args.includes("DISPLAY"));
    assert.ok(!c.args.join(" ").includes(DESKTOP_DISPLAY.slice(1)));
    c.cp.emitClose(0);
    assert.equal((await p).exitCode, 0);
  } finally {
    if (oldDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = oldDisplay;
  }
});

test("DockerVmDriver.exec respects an explicit DISPLAY override", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: true });
  const p = driver.exec(handle(), ["echo", "hi"], { env: { DISPLAY: ":9" } });
  const c = calls[0];
  assert.equal(c.opts.env!.DISPLAY, ":9");
  c.cp.emitClose(0);
  await p;
});

test("DockerVmDriver.exec without desktop does not inject DISPLAY", async () => {
  const oldDisplay = process.env.DISPLAY;
  delete process.env.DISPLAY;
  try {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn, desktop: false });
    const p = driver.exec(handle(), ["echo", "hi"]);
    const c = calls[0];
    assert.equal(c.opts.env!.DISPLAY, undefined);
    c.cp.emitClose(0);
    await p;
  } finally {
    if (oldDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = oldDisplay;
  }
});

// ---------------------------------------------------------------------------
// b10 security guarantees: owner labels, cross-user refusal, legacy migration
// ---------------------------------------------------------------------------

function auditText(auditFile: string): string {
  try {
    return fs.readFileSync(auditFile, "utf8");
  } catch {
    return "";
  }
}

function withAudit(run: (file: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-vm-audit-"));
  const file = path.join(dir, "audit.jsonl");
  configureAuditPath(file);
  return run(file)
    .catch((err) => {
      throw err;
    })
    .finally(() => {
      configureAuditPath(undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test("ensure refuses to attach to a container owned by another user", async () => {
  await withAudit(async (file) => {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn, desktop: true });

    const p = driver.ensure("alice");
    // Attach the assertion now so the eventual rejection is handled (no
    // unhandled-rejection noise), then drive the fake docker calls.
    const asserted = assert.rejects(p, VmUnavailableError);
    calls[0].cp.stdout.emit("data", Buffer.from(`${volumeNameFor("alice")}\n`));
    calls[0].cp.emitClose(0); // volume ls -> exists
    await flush();
    calls[1].cp.stdout.emit("data", Buffer.from(statusWithLabels("running", "bob")));
    calls[1].cp.emitClose(0); // inspectStatusLabels -> owned by bob
    await flush();

    await asserted;
    const txt = auditText(file);
    assert.match(txt, /"action":"vm\.access\.denied"/);
    assert.match(txt, /"user":"alice"/);
  });
});

test("desktopEndpoint refuses to serve a VM owned by another user", async () => {
  await withAudit(async (file) => {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn, desktop: true });
    const p = driver.desktopEndpoint(handle());
    calls[0].cp.stdout.emit("data", Buffer.from(endpointInspect("running", "172.30.0.5", "bob")));
    calls[0].cp.emitClose(0); // container owned by bob
    assert.equal(await p, null);
    assert.match(auditText(file), /"action":"vm\.access\.denied"/);
  });
});

test("restore refuses to destroy a container owned by another user", async () => {
  await withAudit(async (file) => {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn, desktop: false });
    const p = driver.restore(handle(), "v1");
    const asserted = assert.rejects(p, VmUnavailableError);
    calls[0].cp.emitClose(0); // image inspect -> found
    await flush();
    calls[1].cp.stdout.emit("data", Buffer.from(`${snapshotVolumeFor("alice", "v1")}\n`));
    calls[1].cp.emitClose(0); // volume ls -> workspace backup exists
    await flush();
    calls[2].cp.stdout.emit("data", Buffer.from(labelJson("bob")));
    calls[2].cp.emitClose(0); // container labels -> owned by bob
    await asserted;
    assert.match(auditText(file), /"action":"vm\.access\.denied"/);
  });
});

test("legacy migration: an unambiguous single owner is migrated to injective names", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({
    spawnFn,
    desktop: false,
    legacyOwnerCandidates: () => ["alice"],
  });

  const p = driver.ensure("alice");
  calls[0].cp.stdout.emit("data", Buffer.from(""));
  calls[0].cp.emitClose(0); // volume ls (new) -> missing
  await flush();
  calls[1].cp.emitClose(0); // volume create (new, labeled)
  await flush();
  calls[2].cp.emitClose(1); // inspectStatusLabels (new) -> not found
  await flush();
  calls[3].cp.emitClose(0); // legacy container inspect -> exists
  await flush();
  calls[4].cp.stdout.emit("data", Buffer.from(`${legacyVolumeNameFor("alice")}\n`));
  calls[4].cp.emitClose(0); // legacy volume ls -> exists
  await flush();
  calls[5].cp.emitClose(0); // docker container rename legacy -> new
  await flush();
  calls[6].cp.emitClose(0); // docker update --label-add (relabel)
  await flush();
  calls[7].cp.stdout.emit("data", Buffer.from(`${volumeNameFor("alice")}\n`));
  calls[7].cp.emitClose(0); // volume ls (new) inside migration -> exists
  await flush();
  calls[8].cp.emitClose(0); // docker run --rm copy legacy vol -> new vol
  await flush();
  calls[9].cp.emitClose(0); // docker volume rm legacy
  await flush();
  calls[10].cp.stdout.emit("data", Buffer.from(`${legacyVolumeNameFor("alice").replace(/-workspace$/, "-snap")}:v1\n`));
  calls[10].cp.emitClose(0); // images --filter reference=legacyRepo
  await flush();
  calls[11].cp.emitClose(0); // docker tag
  await flush();
  calls[12].cp.emitClose(0); // docker rmi
  await flush();
  calls[13].cp.stdout.emit("data", Buffer.from(statusWithLabels("running", "alice")));
  calls[13].cp.emitClose(0); // re-inspect (new) -> running, owned
  await flush();
  calls[14].cp.emitClose(0); // docker update (applyLimits)
  await flush();

  const h = await p;
  assert.equal(h.containerName, containerNameFor("alice"));

  // Legacy container renamed to the new name (`docker container rename <old> <new>`).
  const rename = calls.find((c) => c.args[0] === "container" && c.args[1] === "rename");
  assert.ok(rename, "expected a docker rename during migration");
  assert.deepEqual(rename.args.slice(2), [legacyContainerNameFor("alice"), containerNameFor("alice")]);
  // Relabel stamped the owner label (`docker container update --label-add ...`).
  const relabel = calls.find(
    (c) => c.args[0] === "container" && c.args[1] === "update" && c.args.includes("--label-add"),
  );
  assert.ok(relabel, "expected a relabel during migration");
  // No fresh VM container was created (the only `run` was the volume copy).
  const vmRuns = calls.filter((c) => c.args[0] === "run" && c.args.includes("--name"));
  assert.equal(vmRuns.length, 0, "migration must not create a fresh VM");
});

test("legacy migration: an ambiguous legacy name is left alone and a fresh VM is created", async () => {
  // Two known users map to the same legacy name (the exact collision being
  // fixed); the driver must NOT attach to it — it creates a fresh VM under
  // the injective name and logs the skipped migration.
  const colliding = ["local_a.b@corp.com", "local_a-b@corp.com"];
  assert.equal(legacyContainerNameFor(colliding[0]), legacyContainerNameFor(colliding[1]));

  await withAudit(async (file) => {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({
      spawnFn,
      desktop: false,
      legacyOwnerCandidates: () => [...colliding],
    });

    const p = driver.ensure(colliding[0]);
    calls[0].cp.stdout.emit("data", Buffer.from(""));
    calls[0].cp.emitClose(0); // volume ls (new) -> missing
    await flush();
    calls[1].cp.emitClose(0); // volume create (new, labeled)
    await flush();
    calls[2].cp.emitClose(1); // inspectStatusLabels (new) -> not found
    await flush();
    calls[3].cp.emitClose(0); // legacy container inspect -> exists
    await flush();
    calls[4].cp.stdout.emit("data", Buffer.from(`${legacyVolumeNameFor(colliding[0])}\n`));
    calls[4].cp.emitClose(0); // legacy volume ls -> exists
    await flush();
    calls[5].cp.emitClose(0); // image inspect -> found
    await flush();
    calls[6].cp.emitClose(0); // docker run --name (fresh VM)
    await flush();

    const h = await p;
    assert.equal(h.containerName, containerNameFor(colliding[0]));

    // Legacy artifacts were NOT touched.
    assert.ok(!calls.some((c) => c.args[0] === "rename"), "ambiguous legacy must not be renamed");
    // A fresh VM was created under the injective name.
    const vmRun = calls.find((c) => c.args[0] === "run" && c.args.includes("--name"));
    assert.ok(vmRun, "expected a fresh VM for the ambiguous case");
    assert.equal(vmRun.args[vmRun.args.indexOf("--name") + 1], containerNameFor(colliding[0]));

    const txt = auditText(file);
    assert.match(txt, /"action":"vm\.migrate"/);
    assert.match(txt, /"result":"failure"/);
  });
});
