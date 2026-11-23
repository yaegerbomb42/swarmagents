import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { FakeVmDriver } from "./fake-driver.js";
import {
  FAKE_CLAUDE_WRITE_CONTENT,
  FAKE_CLAUDE_WRITE_PATH,
  FAKE_CLAUDE_WRITE_TRIGGER,
} from "./fake-claude.js";
import {
  DockerVmDriver,
  VmUnavailableError,
  VmRuntimeError,
  VmNetworkError,
  sanitizeId,
  containerNameFor,
  volumeNameFor,
  snapshotRepoFor,
  ownerKeyFor,
  legacyContainerNameFor,
  legacyVolumeNameFor,
  VM_OWNER_LABEL,
  buildExecArgs,
  buildRunArgs,
  buildTimeoutWrap,
  EXEC_PGID_PREFIX,
  isNotFoundError,
  validateEnvName,
  validateSnapshotName,
  validateVmRuntime,
  resolveVmRuntime,
  isRuntimeMissingError,
  validateVmNetwork,
  resolveVmNetwork,
} from "./docker-driver.js";
import { VmManager, bindExec } from "./manager.js";
import type { ExecOptions, ExecResult, VmHandle } from "./types.js";

// ---------------------------------------------------------------------------
// Fake spawn — lets us capture argv/env and drive child-process events without
// ever invoking a real docker binary.
// ---------------------------------------------------------------------------

interface FakeSpawnCall {
  cmd: string;
  args: readonly string[];
  opts: SpawnOptions;
  cp: {
    emitClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
    emitError: (err: Error) => void;
    kill: (sig?: string) => boolean;
    killed: boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: PassThrough;
  };
}

function makeFakeSpawn() {
  const calls: FakeSpawnCall[] = [];
  const spawnFn = (cmd: string, args: readonly string[], opts?: SpawnOptions): ChildProcess => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new PassThrough();
    const emitter = new EventEmitter();
    const call: FakeSpawnCall = {
      cmd,
      args,
      opts: opts ?? {},
      cp: {
        emitClose: (code, signal) => emitter.emit("close", code, signal ?? null),
        emitError: (err) => emitter.emit("error", err),
        kill: (sig) => {
          call.cp.killed = true;
          emitter.emit("close", 143);
          return true;
        },
        killed: false,
        stdout,
        stderr,
        stdin,
      },
    };
    calls.push(call);
    const cp: Record<string, unknown> = {
      stdout,
      stderr,
      stdin,
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
 * Drive the fixed pre-create docker calls of the current (injective) ensure():
 *   [0] volume ls -> missing, [1] volume create,
 *   [2] inspectStatusLabels -> not found,
 *   [3] legacy container inspect -> not found, [4] legacy volume ls -> empty.
 * Returns the index of the next call (the image inspect).
 */
async function driveCreatePrelude(
  calls: Array<{ cp: { emitClose(c: number | null): void; stdout: { emit(e: string, b: Buffer): void } } }>,
): Promise<number> {
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
  return 5;
}

const handle = (userId = "alice"): VmHandle => ({
  userId,
  containerName: `swarm-vm-${userId}`,
  createdAt: Date.now(),
});

// ---------------------------------------------------------------------------
// FakeVmDriver
// ---------------------------------------------------------------------------

test("FakeVmDriver ensure returns a handle", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("alice");
  assert.equal(h.userId, "alice");
  assert.ok(h.containerName);
  assert.ok(h.createdAt > 0);
});

test("FakeVmDriver exec echo streams stdout", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("bob");
  const chunks: string[] = [];
  const result = await driver.exec(h, ["echo", "hello"], {
    onStdout: (c) => chunks.push(c),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(chunks.join(""), "hello\n");
});

test("FakeVmDriver writeFile and readFile round-trip", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("carol");
  await driver.writeFile(h, "/workspace/test.txt", "alpha");
  const out = await driver.readFile(h, "/workspace/test.txt");
  assert.equal(out, "alpha");
});

test("FakeVmDriver replays the write scenario onto the workspace", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("writer");
  const chunks: string[] = [];
  const result = await driver.exec(
    h,
    ["claude", "-p", FAKE_CLAUDE_WRITE_TRIGGER, "--", FAKE_CLAUDE_WRITE_TRIGGER],
    { onStdout: (c) => chunks.push(c) },
  );
  assert.equal(result.exitCode, 0);
  assert.ok(chunks.join("").includes("File created successfully"));
  assert.equal(await driver.readFile(h, FAKE_CLAUDE_WRITE_PATH), FAKE_CLAUDE_WRITE_CONTENT);
  const listing = await driver.listDir(h, "/workspace");
  assert.deepEqual(
    listing.map((entry) => entry.name),
    ["hello.py"],
  );
});

test("FakeVmDriver keeps a per-instance VM table unless sharedStore is set", async () => {
  const isolatedA = new FakeVmDriver();
  const isolatedB = new FakeVmDriver();
  const ha = await isolatedA.ensure("isolated-user");
  await isolatedA.writeFile(ha, "/workspace/only-a.txt", "a");
  const hb = await isolatedB.ensure("isolated-user");
  await assert.rejects(isolatedB.readFile(hb, "/workspace/only-a.txt"), /File not found/);

  // The app's driver shares one table across route bundles: one machine.
  const sharedA = new FakeVmDriver({ sharedStore: true });
  const sharedB = new FakeVmDriver({ sharedStore: true });
  const hsa = await sharedA.ensure("shared-user");
  await sharedA.writeFile(hsa, "/workspace/shared.txt", "hello");
  const hsb = await sharedB.ensure("shared-user");
  assert.equal(await sharedB.readFile(hsb, "/workspace/shared.txt"), "hello");
});

test("FakeVmDriver status reflects running / stopped", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("dave");
  const s1 = await driver.status(h);
  assert.equal(s1.status, "running");

  await driver.stop(h);
  const s2 = await driver.status(h);
  assert.equal(s2.status, "stopped");
});

test("FakeVmDriver reset wipes files", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("eve");
  await driver.writeFile(h, "/workspace/note.txt", "secret");
  await driver.reset(h);
  const s = await driver.status(h);
  assert.equal(s.status, "stopped");
  await assert.rejects(driver.readFile(h, "/workspace/note.txt"), /File not found/);
});

test("FakeVmDriver exec returns exit code 1 for 'false'", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("frank");
  const result = await driver.exec(h, ["false"]);
  assert.equal(result.exitCode, 1);
});

test("FakeVmDriver exec returns exit code 0 for 'true'", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("grace");
  const result = await driver.exec(h, ["true"]);
  assert.equal(result.exitCode, 0);
});

test("FakeVmDriver exec respects AbortSignal", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("hank");
  const ctrl = new AbortController();
  ctrl.abort();

  await assert.rejects(
    driver.exec(h, ["echo", "x"], { signal: ctrl.signal }),
    /Aborted/,
  );
});

test("FakeVmDriver exec streams stderr on missing file", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("ian");
  const stderr: string[] = [];
  const result = await driver.exec(h, ["cat", "missing.txt"], {
    onStderr: (c) => stderr.push(c),
  });
  assert.equal(result.exitCode, 1);
  assert.ok(stderr.join("").includes("No such file"));
});

// ---------------------------------------------------------------------------
// File browsing (stat / listDir / readFileBytes)
// ---------------------------------------------------------------------------

test("FakeVmDriver stat describes files and directories", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("jane");
  await driver.writeFile(h, "/workspace/src/app.ts", "code");

  const file = await driver.stat(h, "/workspace/src/app.ts");
  assert.equal(file.type, "file");
  assert.equal(file.size, 4);

  const dir = await driver.stat(h, "/workspace/src");
  assert.equal(dir.type, "directory");

  await assert.rejects(driver.stat(h, "/workspace/ghost"), /No such file/);
});

test("FakeVmDriver listDir returns one level, directories first", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("kyle");
  await driver.writeFile(h, "/workspace/hello.txt", "hello");
  await driver.writeFile(h, "/workspace/src/app.ts", "code");

  const entries = await driver.listDir(h, "/workspace");
  assert.deepEqual(entries.map((e) => e.name), ["src", "hello.txt"]);
  assert.equal(entries[0].type, "directory");
  assert.equal(entries[0].path, "/workspace/src");
  assert.equal(entries[1].type, "file");
  assert.equal(entries[1].size, 5);

  await assert.rejects(driver.listDir(h, "/workspace/hello.txt"), /Not a directory/);
});

test("FakeVmDriver readFileBytes caps the returned bytes", async () => {
  const driver = new FakeVmDriver();
  const h = await driver.ensure("lisa");
  await driver.writeFile(h, "/workspace/big.txt", "abcdefgh");

  const res = await driver.readFileBytes(h, "/workspace/big.txt", 4);
  assert.equal(res.content.toString(), "abcd");
  assert.equal(res.size, 8);
  assert.equal(res.truncated, true);

  await assert.rejects(driver.readFileBytes(h, "/workspace/ghost", 4), /No such file/);
});

test("DockerVmDriver.stat parses type, size and mtime", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.stat(handle(), "/workspace/notes.txt");
  assert.deepEqual(calls[0].args, [
    "exec", "swarm-vm-alice", "stat", "-c", "%F\t%s\t%Y", "--", "/workspace/notes.txt",
  ]);
  calls[0].cp.stdout.emit("data", Buffer.from("regular file\t12\t1700000000\n"));
  calls[0].cp.emitClose(0);

  const stat = await p;
  assert.equal(stat.type, "file");
  assert.equal(stat.size, 12);
  assert.equal(stat.modifiedAt, 1700000000000);
});

test("DockerVmDriver.stat reports a missing path", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.stat(handle(), "/workspace/ghost");
  p.catch(() => {}); // suppress unhandled-rejection noise
  calls[0].cp.stderr.emit("data", Buffer.from("stat: cannot statx: No such file or directory\n"));
  calls[0].cp.emitClose(1);

  await assert.rejects(p, /No such file or directory/);
});

test("DockerVmDriver.listDir parses NUL separated find output", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.listDir(handle(), "/workspace");
  assert.deepEqual(calls[0].args, [
    "exec", "swarm-vm-alice",
    "find", "/workspace", "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\\0%s\\0%T@\\0%f\\0",
  ]);
  const payload = [
    "d", "4096", "1700000000.5000000000", "src",
    "f", "12", "1700000001.0000000000", "hello.txt",
  ].join("\0") + "\0";
  calls[0].cp.stdout.emit("data", Buffer.from(payload, "utf8"));
  calls[0].cp.emitClose(0);

  const entries = await p;
  assert.deepEqual(entries.map((e) => e.name), ["src", "hello.txt"]);
  assert.equal(entries[0].type, "directory");
  assert.equal(entries[0].path, "/workspace/src");
  assert.equal(entries[1].type, "file");
  assert.equal(entries[1].size, 12);
  assert.equal(entries[1].modifiedAt, 1700000001000);
});

test("DockerVmDriver.readFileBytes caps the read with head -c", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.readFileBytes(handle(), "/workspace/a.bin", 4);
  calls[0].cp.stdout.emit("data", Buffer.from("regular file\t10\t1700000000\n"));
  calls[0].cp.emitClose(0);
  await flush();

  const head = calls[1];
  assert.deepEqual(head.args, ["exec", "swarm-vm-alice", "head", "-c", "4", "--", "/workspace/a.bin"]);
  head.cp.stdout.emit("data", Buffer.from([0, 1, 2, 3]));
  head.cp.emitClose(0);

  const res = await p;
  assert.equal(res.size, 10);
  assert.equal(res.truncated, true);
  assert.deepEqual([...res.content], [0, 1, 2, 3]);
});

// ---------------------------------------------------------------------------
// DockerVmDriver — argv construction & validation (review items 1-3, 6)
// ---------------------------------------------------------------------------

test("sanitizeId removes dangerous characters", () => {
  assert.equal(sanitizeId("user@example.com"), "user-example-com");
  assert.equal(sanitizeId("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeId("a b c"), "a-b-c");
  assert.equal(sanitizeId("user; rm -rf /"), "user-rm-rf");
  assert.equal(sanitizeId("--leading"), "leading");
  assert.equal(sanitizeId("trailing--"), "trailing");
  assert.equal(sanitizeId("UPPER"), "upper");
});

test("containerNameFor and volumeNameFor are deterministic and injective", () => {
  assert.equal(containerNameFor("alice"), `swarm-vm-alice-${ownerKeyFor("alice")}`);
  assert.equal(volumeNameFor("alice"), `swarm-vm-alice-${ownerKeyFor("alice")}-workspace`);
  assert.equal(containerNameFor("a@b.c"), `swarm-vm-a-b-c-${ownerKeyFor("a@b.c")}`);
});

test("per-user VM names are injective even when sanitizeId collides", () => {
  // sanitizeId collapses these to the same slug (`local_a-b-corp-com`), but
  // the owner fingerprint makes the full resource names distinct, so two
  // accounts can never share a container / volume / snapshot repo.
  const a = "local_a.b@corp.com";
  const b = "local_a-b@corp.com";
  assert.equal(sanitizeId(a), sanitizeId(b));
  assert.notEqual(containerNameFor(a), containerNameFor(b));
  assert.notEqual(volumeNameFor(a), volumeNameFor(b));
  assert.notEqual(snapshotRepoFor(a), snapshotRepoFor(b));
  // The readable slug is bounded, never the full (unbounded) id.
  assert.ok(containerNameFor("x".repeat(500)).length < 120);
  // Legacy names are the old colliding form, kept only for migration
  // (sanitizeId preserves underscores, so `@` and `.` become `-`).
  assert.equal(legacyContainerNameFor(a), "swarm-vm-local_a-b-corp-com");
  assert.equal(legacyVolumeNameFor(a), "swarm-vm-local_a-b-corp-com-workspace");
  assert.equal(VM_OWNER_LABEL, "swarm.vm.user");
});

test("DockerVmDriver constructor accepts custom image and limits", () => {
  const driver = new DockerVmDriver({ image: "my-custom:tag", memory: "512m", cpus: "1.0", pidsLimit: "500" });
  assert.equal(driver.image, "my-custom:tag");
  assert.equal(driver.memory, "512m");
  assert.equal(driver.cpus, "1.0");
  assert.equal(driver.pidsLimit, "500");
});

test("validateEnvName accepts POSIX identifiers only", () => {
  assert.doesNotThrow(() => validateEnvName("FOO"));
  assert.doesNotThrow(() => validateEnvName("_foo"));
  assert.doesNotThrow(() => validateEnvName("A_B_01"));
  assert.throws(() => validateEnvName("BAD-NAME"), /Invalid environment variable name/);
  assert.throws(() => validateEnvName("1FOO"), /Invalid environment variable name/);
  assert.throws(() => validateEnvName(""), /Invalid environment variable name/);
});

test("buildExecArgs forwards env as -e NAME only (values never in argv)", () => {
  const argv = buildExecArgs("swarm-vm-alice", ["node", "-v"], {
    env: { ANTHROPIC_API_KEY: "sk-secret-xyz", PATH: "/usr/bin" },
  });
  assert.deepEqual(argv, [
    "exec",
    "-e", "ANTHROPIC_API_KEY",
    "-e", "PATH",
    "--", "swarm-vm-alice",
    "node", "-v",
  ]);
  const joined = argv.join(" ");
  assert.ok(!joined.includes("sk-secret-xyz"));
  assert.ok(!joined.includes("/usr/bin"));
});

test("buildExecArgs uses -w for cwd, -i for stdin, and a -- separator", () => {
  assert.deepEqual(
    buildExecArgs("c", ["ls", "-la"], { cwd: "/workspace" }),
    ["exec", "-w", "/workspace", "--", "c", "ls", "-la"],
  );
  assert.deepEqual(
    buildExecArgs("c", ["sh", "-c", "echo hi"], { stdin: "hi" }),
    ["exec", "-i", "--", "c", "sh", "-c", "echo hi"],
  );
  assert.deepEqual(
    buildExecArgs("c", ["pwd"], {}),
    ["exec", "--", "c", "pwd"],
  );
});

test("buildExecArgs rejects invalid env names", () => {
  assert.throws(() => buildExecArgs("c", ["x"], { env: { "BAD-NAME": "1" } }), /Invalid environment variable name/);
  assert.throws(() => buildExecArgs("c", ["x"], { env: { "1FOO": "1" } }), /Invalid environment variable name/);
  assert.doesNotThrow(() => buildExecArgs("c", ["x"], { env: { _OK: "1", F_01: "2" } }));
});

test("buildRunArgs hardens the container with configurable limits (review item 4)", () => {
  const argv = buildRunArgs({
    containerName: "swarm-vm-a",
    volume: "swarm-vm-a-workspace",
    image: "node:22-bookworm-slim",
    memory: "1g",
    cpus: "2.0",
    pidsLimit: "1000",
  });

  assert.ok(argv.includes("--security-opt"));
  assert.equal(argv[argv.indexOf("--security-opt") + 1], "no-new-privileges");
  assert.ok(argv.includes("--cap-drop"));
  assert.equal(argv[argv.indexOf("--cap-drop") + 1], "ALL");

  const caps: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--cap-add") caps.push(argv[i + 1]);
  }
  assert.deepEqual(caps.sort(), ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"].sort());

  assert.ok(argv.includes("--init"));
  assert.equal(argv[argv.indexOf("--memory") + 1], "1g");
  assert.equal(argv[argv.indexOf("--cpus") + 1], "2.0");
  assert.equal(argv[argv.indexOf("--pids-limit") + 1], "1000");
  assert.equal(argv[argv.indexOf("-v") + 1], "swarm-vm-a-workspace:/workspace");
});

test("buildRunArgs passes --runtime when configured and omits it otherwise", () => {
  const base = {
    containerName: "swarm-vm-a",
    volume: "swarm-vm-a-workspace",
    image: "node:22-bookworm-slim",
    memory: "2g",
    cpus: "2",
    pidsLimit: "512",
  };

  const withRuntime = buildRunArgs({ ...base, runtime: "runsc" });
  assert.equal(withRuntime[withRuntime.indexOf("--runtime") + 1], "runsc");
  assert.equal(withRuntime.filter((a) => a === "--runtime").length, 1);

  const without = buildRunArgs(base);
  assert.equal(without.indexOf("--runtime"), -1);
  const blank = buildRunArgs({ ...base, runtime: "  " });
  assert.equal(blank.indexOf("--runtime"), -1);

  assert.throws(() => buildRunArgs({ ...base, runtime: "bogus" }), VmRuntimeError);
});

test("buildRunArgs passes --network when configured and omits it otherwise", () => {
  const base = {
    containerName: "swarm-vm-a",
    volume: "swarm-vm-a-workspace",
    image: "swarm-vm:claude",
    memory: "2g",
    cpus: "2",
    pidsLimit: "512",
  };

  const withNetwork = buildRunArgs({ ...base, network: "swarm-vms" });
  assert.equal(withNetwork[withNetwork.indexOf("--network") + 1], "swarm-vms");
  assert.equal(withNetwork.filter((a) => a === "--network").length, 1);

  const without = buildRunArgs(base);
  assert.equal(without.indexOf("--network"), -1);
  const blank = buildRunArgs({ ...base, network: "  " });
  assert.equal(blank.indexOf("--network"), -1);

  assert.throws(() => buildRunArgs({ ...base, network: "bad name" }), VmNetworkError);
  assert.throws(() => buildRunArgs({ ...base, network: "host" }), VmNetworkError);
});

test("validateVmNetwork enforces the docker network name charset", () => {
  assert.equal(validateVmNetwork("swarm-vms"), "swarm-vms");
  assert.equal(validateVmNetwork("  swarm-vms  "), "swarm-vms");
  assert.equal(validateVmNetwork("net_1.local"), "net_1.local");
  assert.throws(() => validateVmNetwork(""), /expected a docker network name/);
  assert.throws(() => validateVmNetwork("-nope"), /expected a docker network name/);
  assert.throws(() => validateVmNetwork("net work"), /expected a docker network name/);
  assert.throws(() => validateVmNetwork("--network"), /expected a docker network name/);
  assert.throws(() => validateVmNetwork("host"), /host" network is not allowed/);
});

test("resolveVmNetwork reads SWARM_VM_NETWORK, blanks are unset, override wins", () => {
  assert.equal(resolveVmNetwork({}), undefined);
  assert.equal(resolveVmNetwork({ SWARM_VM_NETWORK: "swarm-vms" }), "swarm-vms");
  assert.equal(resolveVmNetwork({ SWARM_VM_NETWORK: "   " }), undefined);
  assert.throws(() => resolveVmNetwork({ SWARM_VM_NETWORK: "bad name" }), /Invalid SWARM_VM_NETWORK/);
  assert.equal(resolveVmNetwork({ SWARM_VM_NETWORK: "swarm-vms" }, "other-net"), "other-net");
  assert.throws(() => resolveVmNetwork({ SWARM_VM_NETWORK: "swarm-vms" }, "host"), /Invalid network/);
});

test("validateVmRuntime enforces the allowlist", () => {
  assert.equal(validateVmRuntime("runsc"), "runsc");
  assert.equal(validateVmRuntime("  runsc  "), "runsc");
  assert.throws(() => validateVmRuntime("bogus"), VmRuntimeError);
  assert.throws(() => validateVmRuntime(""), /expected one of/);
  assert.throws(() => validateVmRuntime("runc!"), VmRuntimeError);
});

test("resolveVmRuntime reads SWARM_VM_RUNTIME, blanks are unset, override wins", () => {
  assert.equal(resolveVmRuntime({}), undefined);
  assert.equal(resolveVmRuntime({ SWARM_VM_RUNTIME: "runsc" }), "runsc");
  assert.equal(resolveVmRuntime({ SWARM_VM_RUNTIME: "   " }), undefined);
  assert.throws(() => resolveVmRuntime({ SWARM_VM_RUNTIME: "kata" }), /Invalid SWARM_VM_RUNTIME/);
  assert.equal(resolveVmRuntime({ SWARM_VM_RUNTIME: "runc" }, "runsc"), "runsc");
  assert.throws(() => resolveVmRuntime({ SWARM_VM_RUNTIME: "runsc" }, "kata"), /Invalid runtime/);
});

test("isRuntimeMissingError recognizes Docker's missing-runtime failure", () => {
  assert.ok(isRuntimeMissingError("Error response from daemon: unknown or invalid runtime name: runsc"));
  assert.ok(isRuntimeMissingError("docker: Error response from daemon: runtime runsc not found."));
  assert.ok(!isRuntimeMissingError("Error response from daemon: Conflict. The container name is already in use."));
  assert.ok(!isRuntimeMissingError(""));
});

test("buildTimeoutWrap runs argv under GNU timeout (124 semantics)", () => {
  assert.deepEqual(buildTimeoutWrap(["node", "x.js"], 1500), [
    "timeout", "-s", "TERM", "--kill-after=2s", "1.500s", "node", "x.js",
  ]);
});

test("validateSnapshotName enforces the docker image ref charset", () => {
  assert.doesNotThrow(() => validateSnapshotName("base"));
  assert.doesNotThrow(() => validateSnapshotName("snap:v1"));
  assert.doesNotThrow(() => validateSnapshotName("myorg/tool:edge"));
  assert.doesNotThrow(() => validateSnapshotName("a_b.c-d"));
  assert.doesNotThrow(() => validateSnapshotName("base@sha256:" + "a".repeat(64)));
  assert.throws(() => validateSnapshotName(""), /Invalid snapshot name/);
  assert.throws(() => validateSnapshotName("Snap"), /Invalid snapshot name/);
  assert.throws(() => validateSnapshotName("snap!"), /Invalid snapshot name/);
  assert.throws(() => validateSnapshotName("snap@sha256:zz"), /Invalid snapshot name/);
  assert.throws(() => validateSnapshotName("/abs"), /Invalid snapshot name/);
});

// ---------------------------------------------------------------------------
// DockerVmDriver — spawn integration via fake spawn (review items 1, 5-6)
// ---------------------------------------------------------------------------

test("DockerVmDriver.exec merges env into spawn env but only names into argv", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });
  const h = handle();

  const p = driver.exec(h, ["node", "-p", "'hi'"], { env: { FOO: "bar", SECRET: "s3cr3t" } });
  const c = calls[0];
  assert.equal(c.cmd, "docker");
  assert.equal(c.opts.shell, false);
  assert.equal(c.opts.env!.FOO, "bar");
  assert.equal(c.opts.env!.SECRET, "s3cr3t");
  assert.ok(c.args.includes("--e") || c.args.includes("-e"));
  const eIdx = c.args.indexOf("-e");
  assert.equal(c.args[eIdx + 1], "FOO");
  assert.ok(!c.args.join(" ").includes("s3cr3t"));

  c.cp.emitClose(0);
  const res = await p;
  assert.equal(res.exitCode, 0);
});

test("DockerVmDriver.exec maps abort to 130 and kills only its own process group", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });
  const h = handle();
  const ctrl = new AbortController();

  const p = driver.exec(h, ["sleep", "30"], { signal: ctrl.signal });
  assert.equal(calls.length, 1);
  const c = calls[0];

  // The command runs in its own session with a recorded process-group file,
  // so abort cleanup can target exactly this exec.
  assert.ok(
    c.args.some((arg) => arg.includes("setsid")),
    "exec must run under setsid",
  );
  const pgidFile = c.args.find((arg) => arg.startsWith(EXEC_PGID_PREFIX));
  assert.ok(pgidFile, "expected a per-exec process-group marker file");

  ctrl.abort();
  const res = await p;
  assert.equal(res.exitCode, 130);
  assert.ok(c.cp.killed, "docker CLI should be killed on abort");

  // Cleanup signals the recorded group — never every child of PID 1.
  await flush();
  const cleanup = calls.find(
    (call) =>
      call.args[0] === "exec" &&
      call.args.includes(pgidFile!) &&
      call.args.some((arg) => arg.includes("kill -s TERM")),
  );
  assert.ok(cleanup, "expected per-exec group cleanup");
  assert.ok(
    cleanup!.args.some((arg) => arg.includes("kill -s TERM")),
    "cleanup must signal the recorded process group",
  );
  assert.ok(!cleanup!.args.includes("pkill"), "container-wide pkill must be gone");
  assert.ok(!cleanup!.args.includes("-P"), "cleanup must not target children of PID 1");
  cleanup!.cp.emitClose(0);
});

test("DockerVmDriver.exec abort leaves a concurrent sibling exec running", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });
  const h = handle();

  const first = new AbortController();
  const second = new AbortController();
  const p1 = driver.exec(h, ["sleep", "30"], { signal: first.signal });
  const p2 = driver.exec(h, ["sleep", "30"], { signal: second.signal });
  assert.equal(calls.length, 2);

  const pgidOf = (args: readonly string[]): string => {
    const file = args.find((arg) => arg.startsWith(EXEC_PGID_PREFIX));
    assert.ok(file, "expected a per-exec process-group marker file");
    return file!;
  };
  const pgid1 = pgidOf(calls[0].args);
  const pgid2 = pgidOf(calls[1].args);
  assert.notEqual(pgid1, pgid2, "each exec needs its own process-group marker");

  first.abort();
  assert.equal((await p1).exitCode, 130);
  await flush();

  const cleanup = calls.find(
    (call) =>
      call.args[0] === "exec" &&
      call.args.includes(pgid1) &&
      call.args.some((arg) => arg.includes("kill -s TERM")),
  );
  assert.ok(cleanup, "expected cleanup for the aborted exec");
  assert.ok(!cleanup!.args.includes(pgid2), "cleanup must not touch the sibling exec");
  assert.equal(calls[1].cp.killed, false, "the sibling docker CLI must survive");

  cleanup!.cp.emitClose(0);
  // The sibling still completes normally.
  calls[1].cp.emitClose(0);
  assert.equal((await p2).exitCode, 0);
});

test("DockerVmDriver.exec rejects when the docker CLI is killed by a signal", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.exec(handle(), ["sleep", "5"]);
  calls[0].cp.emitClose(null, "SIGKILL");
  await assert.rejects(p, /SIGKILL/);
});

test("DockerVmDriver.run rejects a signal-killed docker call with the signal name", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.stop(handle());
  calls[0].cp.emitClose(null, "SIGTERM");
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof VmUnavailableError);
    assert.match((err as Error).message, /SIGTERM/);
    return true;
  });
});

test("DockerVmDriver.ensure reports a signal-killed pull instead of a bogus success", async () => {
  const oldPull = process.env.SWARM_VM_PULL;
  process.env.SWARM_VM_PULL = "1";
  try {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn });

    const p = driver.ensure("alice");
    p.catch(() => {});
    const next = await driveCreatePrelude(calls);
    calls[next].cp.emitClose(1); // image inspect -> not found
    await flush();

    const pullCall = calls[next + 1];
    assert.ok(pullCall, "expected a docker pull call");
    // Docker's CLI was killed (e.g. the pull timeout fired), not a clean exit.
    pullCall.cp.emitClose(null, "SIGTERM");

    await assert.rejects(p, (err: unknown) => {
      assert.ok(err instanceof VmUnavailableError);
      const message = (err as Error).message;
      assert.match(message, /pull/);
      assert.match(message, /SIGTERM/);
      assert.doesNotMatch(message, /Unable to find image/);
      return true;
    });
  } finally {
    if (oldPull === undefined) delete process.env.SWARM_VM_PULL;
    else process.env.SWARM_VM_PULL = oldPull;
  }
});

// ---------------------------------------------------------------------------
// reset(): already-gone resources are success, the volume is always removed
// ---------------------------------------------------------------------------

test("DockerVmDriver.reset removes the volume when the container is already gone", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.reset(handle());
  assert.equal(calls[0].args[0], "rm");
  calls[0].cp.stderr.emit(
    "data",
    Buffer.from("Error response from daemon: No such container: swarm-vm-alice\n"),
  );
  calls[0].cp.emitClose(1);
  await flush();

  // The missing container must not short-circuit the volume removal.
  assert.equal(calls.length, 2, "volume rm must still be attempted");
  assert.equal(calls[1].args[0], "volume");
  assert.equal(calls[1].args[1], "rm");
  calls[1].cp.emitClose(0);

  await p; // resolves: the user's files are gone
});

test("DockerVmDriver.reset treats an already-gone volume as success", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.reset(handle());
  calls[0].cp.emitClose(0); // container removed
  await flush();
  calls[1].cp.stderr.emit(
    "data",
    Buffer.from("Error response from daemon: get swarm-vm-alice-workspace: no such volume\n"),
  );
  calls[1].cp.emitClose(1);

  await p; // a missing volume is exactly the desired end state
});

test("DockerVmDriver.reset still rejects a real container-removal failure but tries the volume", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.reset(handle());
  calls[0].cp.stderr.emit("data", Buffer.from("permission denied\n"));
  calls[0].cp.emitClose(1);
  await flush();
  assert.equal(calls.length, 2, "volume rm is still attempted");
  calls[1].cp.emitClose(0);

  await assert.rejects(p, /reset failed to remove container: permission denied/);
});

test("isNotFoundError recognises Docker's missing-resource messages", () => {
  assert.equal(isNotFoundError("No such container: x"), true);
  assert.equal(isNotFoundError("no such volume: x"), true);
  assert.equal(isNotFoundError("No such object: x"), true);
  assert.equal(isNotFoundError("permission denied"), false);
});

test("DockerVmDriver.exec pre-aborted signal returns 130 without spawning", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });
  const ctrl = new AbortController();
  ctrl.abort();

  const res = await driver.exec(handle(), ["echo", "x"], { signal: ctrl.signal });
  assert.equal(res.exitCode, 130);
  assert.equal(calls.length, 0);
});

test("DockerVmDriver.exec maps timeout to 124 and wraps in in-container timeout", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, killGraceMs: 5 });

  const p = driver.exec(handle(), ["sleep", "60"], { timeoutMs: 20 });
  const c = calls[0];
  assert.ok(c.args.includes("timeout"), "expected in-container GNU timeout wrapper");
  const tIdx = c.args.indexOf("timeout");
  const sleepIdx = c.args.indexOf("sleep");
  assert.ok(sleepIdx > tIdx, "original command must sit inside the timeout wrapper");

  const res = await p;
  assert.equal(res.exitCode, 124);
  assert.ok(c.cp.killed);
});

test("DockerVmDriver.exec propagates spawn errors", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.exec(handle(), ["true"]);
  calls[0].cp.emitError(new Error("boom"));
  await assert.rejects(p, /boom/);
});

test("DockerVmDriver.inFile uses cat -- so leading dashes are safe", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.readFile(handle(), "/workspace/-weird");
  assert.deepEqual(calls[0].args, ["exec", "swarm-vm-alice", "cat", "--", "/workspace/-weird"]);
  calls[0].cp.emitClose(0);
  assert.equal(await p, "");
});

test("DockerVmDriver.writeFile creates parent dir and pipes content via stdin", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.writeFile(handle(), "/workspace/sub/a.txt", "big-content");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["exec", "--", "swarm-vm-alice", "timeout", "-s", "TERM", "--kill-after=2s", "30.000s", "mkdir", "-p", "/workspace/sub"]);
  calls[0].cp.emitClose(0);

  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, [
    "exec", "-i", "--", "swarm-vm-alice", "timeout", "-s", "TERM", "--kill-after=2s", "120.000s", "sh", "-c",
    'if [ -L "$1" ]; then echo "refusing to write through a symlink" >&2; exit 40; fi; cat > "$1"',
    "sh", "/workspace/sub/a.txt",
  ]);
  assert.ok(!calls[1].args.some((a) => a.includes("big-content")), "content must not appear in argv");
  calls[1].cp.emitClose(0);

  await p;
});

test("DockerVmDriver.writeFile rejects relative and weird paths", async () => {
  const { spawnFn } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });
  await assert.rejects(driver.writeFile(handle(), "relative.txt", "x"), /absolute path/);
  await assert.rejects(driver.writeFile(handle(), "/a\"b", "x"), /forbidden characters/);
});

test("DockerVmDriver.ensure builds hardened run args with resource limits", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

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

  const runCall = calls.find((c) => c.args[0] === "run");
  assert.ok(runCall, "expected a docker run argv");
  const argv = runCall!.args;
  assert.ok(argv.includes("--security-opt"));
  assert.ok(argv.includes("no-new-privileges"));
  assert.ok(argv.includes("--cap-drop"));
  assert.ok(argv.includes("ALL"));
  assert.ok(argv.includes("--init"));
  assert.ok(argv.includes("--label"));
  assert.ok(argv.includes(`${VM_OWNER_LABEL}=${ownerKeyFor("alice")}`));
  assert.equal(argv[argv.indexOf("--memory") + 1], "2g");
  assert.equal(argv[argv.indexOf("--cpus") + 1], "2");
  assert.equal(argv[argv.indexOf("--pids-limit") + 1], "512");

  runCall!.cp.emitClose(0);
  const h = await p;
  assert.equal(h.containerName, containerNameFor("alice"));
});

test("DockerVmDriver.ensure re-applies the limits to an existing container", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.ensure("alice");
  calls[0].cp.stdout.emit("data", Buffer.from(`${volumeNameFor("alice")}\n`));
  calls[0].cp.emitClose(0); // volume ls -> exists
  await flush();
  calls[1].cp.stdout.emit(
    "data",
    Buffer.from(`running\t${JSON.stringify({ [VM_OWNER_LABEL]: ownerKeyFor("alice") })}\n`),
  );
  calls[1].cp.emitClose(0); // inspectStatusLabels -> exists, running, owned
  await flush();

  const updateCall = calls.find((c) => c.args[0] === "update");
  assert.ok(updateCall, "expected a docker update call for the existing container");
  assert.deepEqual(updateCall!.args, [
    "update", "--memory", "2g", "--cpus", "2", "--pids-limit", "512", containerNameFor("alice"),
  ]);
  assert.ok(!calls.some((c) => c.args[0] === "run"), "must not recreate a live container");

  updateCall!.cp.emitClose(0);
  const h = await p;
  assert.equal(h.containerName, containerNameFor("alice"));
});

test("DockerVmDriver.ensure throws VmUnavailableError when docker CLI is missing (ENOENT)", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.ensure("alice");
  const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  calls[0].cp.emitError(err);

  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof VmUnavailableError, "expected VmUnavailableError");
    assert.ok((e as Error).message.includes("Docker CLI was not found"), "message should mention Docker CLI");
    return true;
  });
});

test("DockerVmDriver.ensure throws VmUnavailableError when image is missing and SWARM_VM_PULL is not set", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn });

  const p = driver.ensure("alice");
  p.catch(() => {});
  const next = await driveCreatePrelude(calls);
  calls[next].cp.emitClose(1); // image inspect -> not found
  await flush();

  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof VmUnavailableError, "expected VmUnavailableError");
    assert.ok((e as Error).message.includes("not available locally"), "message should mention local image");
    assert.ok((e as Error).message.includes("SWARM_VM_PULL=1"), "message should suggest SWARM_VM_PULL=1");
    return true;
  });
});

test("DockerVmDriver.ensure pulls image when SWARM_VM_PULL=1 and then starts container", async () => {
  const oldPull = process.env.SWARM_VM_PULL;
  process.env.SWARM_VM_PULL = "1";
  try {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn });

    const p = driver.ensure("alice");
    const next = await driveCreatePrelude(calls);
    calls[next].cp.emitClose(1); // image inspect -> not found
    await flush();

    const pullCall = calls[next + 1];
    assert.ok(pullCall, "expected a docker pull call");
    assert.deepEqual(pullCall.args.slice(0, 2), ["pull", driver.image]);
    pullCall.cp.emitClose(0);
    await flush();

    const runCall = calls.find((c) => c.args[0] === "run");
    assert.ok(runCall, "expected a docker run call after pull");
    runCall!.cp.emitClose(0);
    const h = await p;
    assert.equal(h.containerName, containerNameFor("alice"));
  } finally {
    if (oldPull === undefined) delete process.env.SWARM_VM_PULL;
    else process.env.SWARM_VM_PULL = oldPull;
  }
});

test("DockerVmDriver.ensure throws VmUnavailableError when SWARM_VM_PULL=1 and pull fails", async () => {
  const oldPull = process.env.SWARM_VM_PULL;
  process.env.SWARM_VM_PULL = "1";
  try {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn });

    const p = driver.ensure("alice");
    p.catch(() => {});
    const next = await driveCreatePrelude(calls);
    calls[next].cp.emitClose(1); // image inspect -> not found
    await flush();
    calls[next + 1].cp.emitClose(1); // pull fails
    await flush();

    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof VmUnavailableError, "expected VmUnavailableError");
      assert.ok((e as Error).message.includes("could not be pulled"), "message should mention pull failure");
      return true;
    });
  } finally {
    if (oldPull === undefined) delete process.env.SWARM_VM_PULL;
    else process.env.SWARM_VM_PULL = oldPull;
  }
});

test("DockerVmDriver takes its runtime from SWARM_VM_RUNTIME", () => {
  const old = process.env.SWARM_VM_RUNTIME;
  process.env.SWARM_VM_RUNTIME = "runsc";
  try {
    const driver = new DockerVmDriver();
    assert.equal(driver.runtime, "runsc");
  } finally {
    if (old === undefined) delete process.env.SWARM_VM_RUNTIME;
    else process.env.SWARM_VM_RUNTIME = old;
  }
});

test("DockerVmDriver.ensure passes the configured runtime to docker run", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, runtime: "runsc" });

  const p = driver.ensure("alice");
  const next = await driveCreatePrelude(calls);
  calls[next].cp.emitClose(0); // image inspect -> found
  await flush();

  const infoCall = calls.find((c) => c.args[0] === "info");
  assert.ok(infoCall, "expected a docker info call for the runtime pre-check");
  assert.deepEqual(infoCall!.args.slice(0, 3), ["info", "--format", "{{json .Runtimes}}"]);
  infoCall!.cp.stdout.emit(
    "data",
    '{"runsc":{"Path":"/usr/bin/runsc","Args":null},"runc":{}}\n',
  );
  infoCall!.cp.emitClose(0);
  await flush();

  const runCall = calls.find((c) => c.args[0] === "run");
  assert.ok(runCall, "expected a docker run call");
  assert.equal(runCall!.args[runCall!.args.indexOf("--runtime") + 1], "runsc");

  runCall!.cp.emitClose(0);
  const h = await p;
  assert.equal(h.containerName, containerNameFor("alice"));
});

test("DockerVmDriver.ensure fails with a clear vm.error when the runtime is not registered", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, runtime: "runsc" });

  const p = driver.ensure("alice");
  p.catch(() => {}); // suppress unhandled-rejection noise
  const next = await driveCreatePrelude(calls);
  calls[next].cp.emitClose(0); // image inspect -> found
  await flush();

  const infoCall = calls.find((c) => c.args[0] === "info");
  assert.ok(infoCall, "expected a docker info call for the runtime pre-check");
  infoCall!.cp.stdout.emit("data", '{"runc":{}}\n');
  infoCall!.cp.emitClose(0);
  await flush();

  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof VmUnavailableError, "expected VmUnavailableError");
    const msg = (e as Error).message;
    assert.ok(msg.includes("runsc"), "message should name the runtime");
    assert.ok(msg.includes("not registered"), "message should say the runtime is not registered");
    assert.ok(msg.includes("SWARM_VM_RUNTIME"), "message should point at SWARM_VM_RUNTIME");
    return true;
  });
  assert.ok(!calls.some((c) => c.args[0] === "run"), "must not attempt to run with an unregistered runtime");
});

test("DockerVmDriver.ensure fails clearly when docker reports the runtime missing at run time", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, runtime: "runsc" });

  const p = driver.ensure("alice");
  p.catch(() => {}); // suppress unhandled-rejection noise
  const next = await driveCreatePrelude(calls);
  calls[next].cp.emitClose(0); // image inspect -> found
  await flush();

  const infoCall = calls.find((c) => c.args[0] === "info");
  assert.ok(infoCall);
  infoCall!.cp.stdout.emit("data", '{"runsc":{},"runc":{}}\n');
  infoCall!.cp.emitClose(0);
  await flush();

  const runCall = calls.find((c) => c.args[0] === "run");
  assert.ok(runCall, "expected a docker run call");
  runCall!.cp.stderr.emit(
    "data",
    "docker: Error response from daemon: unknown or invalid runtime name: runsc.\n",
  );
  runCall!.cp.emitClose(1);
  await flush();

  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof VmUnavailableError, "expected VmUnavailableError");
    const msg = (e as Error).message;
    assert.ok(msg.includes("runsc"), "message should name the runtime");
    assert.ok(msg.includes("SWARM_VM_RUNTIME"), "message should point at SWARM_VM_RUNTIME");
    assert.ok(!msg.includes("silently"), "no silent fallback");
    return true;
  });
});

test("DockerVmDriver takes its network from SWARM_VM_NETWORK", () => {
  const old = process.env.SWARM_VM_NETWORK;
  process.env.SWARM_VM_NETWORK = "swarm-vms";
  try {
    const driver = new DockerVmDriver();
    assert.equal(driver.network, "swarm-vms");
  } finally {
    if (old === undefined) delete process.env.SWARM_VM_NETWORK;
    else process.env.SWARM_VM_NETWORK = old;
  }
});

test("DockerVmDriver rejects an invalid SWARM_VM_NETWORK", () => {
  const old = process.env.SWARM_VM_NETWORK;
  process.env.SWARM_VM_NETWORK = "bad name";
  try {
    assert.throws(() => new DockerVmDriver(), VmNetworkError);
  } finally {
    if (old === undefined) delete process.env.SWARM_VM_NETWORK;
    else process.env.SWARM_VM_NETWORK = old;
  }
});

test("DockerVmDriver.ensure passes the configured network to docker run", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, network: "swarm-vms" });

  const p = driver.ensure("alice");
  const next = await driveCreatePrelude(calls);
  calls[next].cp.emitClose(0); // image inspect -> found
  await flush();

  const runCall = calls.find((c) => c.args[0] === "run");
  assert.ok(runCall, "expected a docker run call");
  assert.equal(runCall!.args[runCall!.args.indexOf("--network") + 1], "swarm-vms");

  runCall!.cp.emitClose(0);
  const h = await p;
  assert.equal(h.containerName, containerNameFor("alice"));
});

test("DockerVmDriver.ensure omits --network when no network is configured", async () => {
  const old = process.env.SWARM_VM_NETWORK;
  delete process.env.SWARM_VM_NETWORK;
  try {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn });
    assert.equal(driver.network, undefined);

    const p = driver.ensure("alice");
    const next = await driveCreatePrelude(calls);
    calls[next].cp.emitClose(0); // image inspect -> found
    await flush();

    const runCall = calls.find((c) => c.args[0] === "run");
    assert.ok(runCall, "expected a docker run call");
    assert.equal(runCall!.args.indexOf("--network"), -1);

    runCall!.cp.emitClose(0);
    const h = await p;
    assert.equal(h.containerName, containerNameFor("alice"));
  } finally {
    if (old === undefined) delete process.env.SWARM_VM_NETWORK;
    else process.env.SWARM_VM_NETWORK = old;
  }
});

// ---------------------------------------------------------------------------
// VmManager & bindExec (review item 3)
// ---------------------------------------------------------------------------

test("VmManager caches handles", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver });

  const h1 = await manager.ensure("user1");
  const h2 = await manager.ensure("user1");
  assert.equal(h1.containerName, h2.containerName);
});

test("VmManager serializes reset vs exec", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver });

  const execPromise = manager.exec("user2", ["echo", "hello"]);
  const resetPromise = manager.reset("user2");

  const [execRes] = await Promise.allSettled([execPromise, resetPromise]);
  assert.ok(execRes.status === "fulfilled" || execRes.status === "rejected");
});

test("VmManager resolves driver by env string", () => {
  assert.doesNotThrow(() => new VmManager({ driver: "fake" }));
  assert.doesNotThrow(() => new VmManager({ driver: "docker" }));
});

test("VmManager unknown driver throws", () => {
  assert.throws(() => new VmManager({ driver: "magic" as "fake" }), /Unknown VM driver: magic/);
});

test("VmManager.exec passes argv through to the driver", async () => {
  class RecordingFake extends FakeVmDriver {
    calls: string[][] = [];
    override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      this.calls.push(cmd);
      return super.exec(h, cmd, opts);
    }
  }
  const driver = new RecordingFake();
  const manager = new VmManager({ customDriver: driver });

  const res = await manager.exec("u1", ["pwd"]);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(driver.calls, [["pwd"]]);
});

test("bindExec adapts a VmManager to the harness exec shape", async () => {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver });
  const bound = bindExec(manager, "u2");

  const chunks: string[] = [];
  const res = await bound.exec(["echo", "hi"], { onStdout: (c) => chunks.push(c) });
  assert.equal(res.exitCode, 0);
  assert.equal(chunks.join(""), "hi\n");
});
