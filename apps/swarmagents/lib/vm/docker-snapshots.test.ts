// Driver-level snapshot tests for the Docker VM driver.
//
// Job zero: `docker commit` captures only the container's writable layer —
// the /workspace named volume is NOT in the image. These tests drive the
// docker CLI call sequence (fake spawn) to prove that snapshot() backs the
// workspace volume up into a per-snapshot volume and restore() copies it
// back before recreating the container. Docker itself is not available in
// this VM, so the live create -> mutate -> restore round-trip cannot run
// here; the fake-driver round-trip is covered by snapshots.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  DockerVmDriver,
  containerNameFor,
  volumeNameFor,
  snapshotRepoFor,
  snapshotVolumeFor,
  ownerKeyFor,
  VM_OWNER_LABEL,
} from "./docker-driver.js";
import type { VmHandle } from "./types.js";

interface FakeSpawnCall {
  cmd: string;
  args: readonly string[];
  opts: SpawnOptions;
  cp: {
    emitClose: (code: number | null) => void;
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
        kill: () => {
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

const handle = (userId = "alice"): VmHandle => ({
  userId,
  containerName: containerNameFor(userId),
  createdAt: Date.now(),
});

/** Labels JSON for a container owned by `userId`. */
const labelJson = (userId: string): string =>
  JSON.stringify({ [VM_OWNER_LABEL]: ownerKeyFor(userId) });

test("snapshotVolumeFor is deterministic and injective", () => {
  assert.equal(
    snapshotVolumeFor("alice", "v1"),
    `${snapshotRepoFor("alice")}-v1`,
  );
  assert.notEqual(snapshotVolumeFor("alice", "v1"), snapshotVolumeFor("alice", "v2"));
  assert.notEqual(snapshotVolumeFor("alice", "v1"), snapshotVolumeFor("bob", "v1"));
  // Volume-name charset: label chars are a subset, so the name is valid.
  assert.match(snapshotVolumeFor("alice", "checkpoint-1"), /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
});

test("snapshot commits the container and backs up the workspace volume", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });
  const snapVol = snapshotVolumeFor("alice", "v1");

  const p = driver.snapshot(handle(), "v1");
  const asserted = assert.doesNotReject(p);

  calls[0].cp.emitClose(0); // docker commit -> ok
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from("")); // volume ls -> backup missing
  calls[1].cp.emitClose(0);
  await flush();
  calls[2].cp.emitClose(0); // volume create -> ok
  await flush();
  calls[3].cp.emitClose(0); // docker run --rm copy -> ok
  await flush();

  const snap = await p;
  await asserted;
  assert.equal(snap.label, "v1");
  assert.equal(snap.image, `${snapshotRepoFor("alice")}:v1`);

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].args.slice(0, 3), ["commit", containerNameFor("alice"), snap.image]);
  assert.deepEqual(calls[1].args, ["volume", "ls", "-q", "-f", `name=${snapVol}`]);
  assert.deepEqual(calls[2].args, [
    "volume", "create", "--label", `${VM_OWNER_LABEL}=${ownerKeyFor("alice")}`, snapVol,
  ]);
  const copy = calls[3];
  assert.equal(copy.args[0], "run");
  assert.ok(copy.args.includes("--rm"), "copy runs in a throwaway container");
  assert.ok(copy.args.includes(`${volumeNameFor("alice")}:/src`), "workspace volume is the source");
  assert.ok(copy.args.includes(`${snapVol}:/dst`), "snapshot volume is the destination");
  const script = copy.args[copy.args.length - 1];
  assert.match(script, /cp -a \/src\/\. \/dst\//, "copy preserves the workspace tree");
});

test("snapshot re-snapshotting a label overwrites the old workspace backup", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });
  const snapVol = snapshotVolumeFor("alice", "v1");

  const p = driver.snapshot(handle(), "v1");
  calls[0].cp.emitClose(0); // docker commit -> ok
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from(`${snapVol}\n`)); // volume ls -> backup exists
  calls[1].cp.emitClose(0);
  await flush();
  // No volume create: the existing backup is reused, emptied, and recopied.
  calls[2].cp.emitClose(0); // docker run --rm copy -> ok
  await flush();

  await p;
  assert.equal(calls.length, 3);
  const script = calls[2].args[calls[2].args.length - 1];
  assert.match(
    script,
    /find \/dst -mindepth 1 -delete/,
    "old backup contents are cleared before the re-copy",
  );
});

test("snapshot failure during the workspace backup removes the half-created snapshot", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });
  const snapVol = snapshotVolumeFor("alice", "v1");

  const p = driver.snapshot(handle(), "v1");
  const asserted = assert.rejects(p, /back up workspace/);
  calls[0].cp.emitClose(0); // docker commit -> ok
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from(""));
  calls[1].cp.emitClose(0); // volume ls -> missing
  await flush();
  calls[2].cp.emitClose(0); // volume create -> ok
  await flush();
  calls[3].cp.stderr.emit("data", Buffer.from("copy exploded\n"));
  calls[3].cp.emitClose(1); // docker run --rm copy -> fails
  await flush();
  calls[4].cp.emitClose(0); // docker rmi <image> (cleanup)
  await flush();
  calls[5].cp.emitClose(0); // docker volume rm -f <snapVol> (cleanup)
  await flush();

  await asserted;
  assert.deepEqual(calls[4].args, ["rmi", `${snapshotRepoFor("alice")}:v1`]);
  assert.deepEqual(calls[5].args, ["volume", "rm", "-f", snapVol]);
});

test("restore copies the workspace backup back before recreating the container", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });
  const snapVol = snapshotVolumeFor("alice", "v1");

  const p = driver.restore(handle(), "v1");
  calls[0].cp.emitClose(0); // image inspect -> found
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from(`${snapVol}\n`)); // volume ls -> backup exists
  calls[1].cp.emitClose(0);
  await flush();
  calls[2].cp.stdout.emit("data", Buffer.from(labelJson("alice"))); // container labels -> owned
  calls[2].cp.emitClose(0);
  await flush();
  calls[3].cp.emitClose(0); // docker rm -f -> ok
  await flush();
  calls[4].cp.emitClose(0); // docker run --rm copy back -> ok
  await flush();
  calls[5].cp.emitClose(0); // docker run -d from snapshot image -> ok
  await flush();

  await p;

  const copy = calls.find(
    (c) => c.args[0] === "run" && c.args.includes("--rm") && c.args.includes(`${snapVol}:/src`),
  );
  assert.ok(copy, "expected a helper run copying the backup back into the workspace volume");
  assert.ok(
    copy.args.includes(`${volumeNameFor("alice")}:/dst`),
    "the live workspace volume is the copy destination",
  );
  assert.match(
    copy.args[copy.args.length - 1],
    /find \/dst -mindepth 1 -delete; cp -a \/src\/\. \/dst\//,
    "post-snapshot files are cleared before the backup is copied back",
  );

  const recreate = calls.find(
    (c) => c.args[0] === "run" && c.args.includes(`${snapshotRepoFor("alice")}:v1`),
  );
  assert.ok(recreate, "expected the container to be recreated from the snapshot image");
  assert.ok(
    calls.indexOf(copy) < calls.indexOf(recreate),
    "the workspace is rolled back before the new container mounts it",
  );
  assert.ok(
    recreate.args.includes(`${volumeNameFor("alice")}:/workspace`),
    "the recreated container remounts the restored workspace volume",
  );
});

test("restore refuses when the workspace backup volume is missing", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });

  const p = driver.restore(handle(), "v1");
  const asserted = assert.rejects(p, /workspace backup missing/);
  calls[0].cp.emitClose(0); // image inspect -> found (pre-fix snapshot image)
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from("")); // volume ls -> no backup
  calls[1].cp.emitClose(0);
  await flush();

  await asserted;
  assert.equal(calls.length, 2, "nothing is destroyed when the backup is missing");
});

test("deleteSnapshot removes the image and the workspace backup volume", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });
  const snapVol = snapshotVolumeFor("alice", "v1");
  const image = `${snapshotRepoFor("alice")}:v1`;

  const p = driver.deleteSnapshot(handle(), "v1");
  const asserted = assert.doesNotReject(p);
  calls[0].cp.emitClose(0); // image inspect -> found
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from(`${snapVol}\n`)); // volume ls -> backup exists
  calls[1].cp.emitClose(0);
  await flush();
  calls[2].cp.emitClose(0); // docker rmi -> ok
  await flush();
  calls[3].cp.emitClose(0); // docker volume rm -f -> ok
  await flush();

  await p;
  await asserted;
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].args, ["image", "inspect", "-f", "{{.Id}}", image]);
  assert.deepEqual(calls[1].args, ["volume", "ls", "-q", "-f", `name=${snapVol}`]);
  assert.deepEqual(calls[2].args, ["rmi", image]);
  assert.deepEqual(calls[3].args, ["volume", "rm", "-f", snapVol]);
});

test("deleteSnapshot reports not found when neither half exists", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });

  const p = driver.deleteSnapshot(handle(), "ghost");
  const asserted = assert.rejects(p, /Snapshot not found: ghost/);
  calls[0].cp.emitClose(1); // image inspect -> missing
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from("")); // volume ls -> no backup
  calls[1].cp.emitClose(0);
  await flush();

  await asserted;
  assert.equal(calls.length, 2, "nothing is removed when the snapshot does not exist");
});

test("deleteSnapshot still removes the half that exists", async () => {
  // Image without its backup (a half-created snapshot): the image goes.
  {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn, desktop: false });
    const image = `${snapshotRepoFor("alice")}:v1`;

    const p = driver.deleteSnapshot(handle(), "v1");
    calls[0].cp.emitClose(0); // image inspect -> found
    await flush();
    calls[1].cp.stdout.emit("data", Buffer.from(""));
    calls[1].cp.emitClose(0); // volume ls -> no backup
    await flush();
    calls[2].cp.emitClose(0); // docker rmi -> ok
    await flush();

    await p;
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].args, ["rmi", image]);
  }
  // Backup volume without its image: the volume goes.
  {
    const { spawnFn, calls } = makeFakeSpawn();
    const driver = new DockerVmDriver({ spawnFn, desktop: false });
    const snapVol = snapshotVolumeFor("alice", "v1");

    const p = driver.deleteSnapshot(handle(), "v1");
    calls[0].cp.emitClose(1); // image inspect -> missing
    await flush();
    calls[1].cp.stdout.emit("data", Buffer.from(`${snapVol}\n`));
    calls[1].cp.emitClose(0); // volume ls -> backup exists
    await flush();
    calls[2].cp.emitClose(0); // docker volume rm -f -> ok
    await flush();

    await p;
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].args, ["volume", "rm", "-f", snapVol]);
  }
});

test("deleteSnapshot surfaces an image-in-use failure and keeps the volume", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });
  const snapVol = snapshotVolumeFor("alice", "v1");

  const p = driver.deleteSnapshot(handle(), "v1");
  const asserted = assert.rejects(p, /remove image/);
  calls[0].cp.emitClose(0); // image inspect -> found
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from(`${snapVol}\n`)); // volume ls -> backup exists
  calls[1].cp.emitClose(0);
  await flush();
  // The live VM was recreated from this snapshot: the daemon refuses rmi.
  calls[2].cp.stderr.emit("data", Buffer.from("image is being used by running container\n"));
  calls[2].cp.emitClose(1);
  await flush();

  await asserted;
  assert.equal(calls.length, 3, "the volume must not be removed when the image removal fails");
});

test("restore refuses when the container removal fails", async () => {
  const { spawnFn, calls } = makeFakeSpawn();
  const driver = new DockerVmDriver({ spawnFn, desktop: false });
  const snapVol = snapshotVolumeFor("alice", "v1");

  const p = driver.restore(handle(), "v1");
  const asserted = assert.rejects(p, /remove container/);
  calls[0].cp.emitClose(0); // image inspect -> found
  await flush();
  calls[1].cp.stdout.emit("data", Buffer.from(`${snapVol}\n`));
  calls[1].cp.emitClose(0); // volume ls -> backup exists
  await flush();
  calls[2].cp.stdout.emit("data", Buffer.from(labelJson("alice")));
  calls[2].cp.emitClose(0); // container labels -> owned
  await flush();
  calls[3].cp.stderr.emit("data", Buffer.from("Error response from daemon: cannot remove\n"));
  calls[3].cp.emitClose(1); // docker rm -f -> fails
  await flush();

  await asserted;
  assert.equal(calls.length, 4, "the workspace copy must not run while the container is alive");
});
