/**
 * Symlink confinement (VM-10 / Bug 27): /workspace containment must be
 * enforced on the *resolved* path, not just lexically.
 *
 * The fake driver models symlinks so these tests exercise the same
 * VmManager -> VmDriver.realpath path the Docker driver uses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { VmManager } from "./manager";
import { FakeVmDriver } from "./fake-driver";
import { VmPathError } from "./files";
import type { VmHandle } from "./types";

function install(): { driver: FakeVmDriver; manager: VmManager; handle: VmHandle } {
  const driver = new FakeVmDriver();
  const manager = new VmManager({ customDriver: driver });
  return { driver, manager, handle: { userId: "alice", containerName: "fake-alice", createdAt: 0 } };
}

function isOutsideError(err: unknown): boolean {
  return err instanceof VmPathError && err.code === "outside_workspace";
}

test("read, stat and readFileBytes refuse a symlink that points outside /workspace", async () => {
  const { driver, manager, handle } = install();
  await driver.writeFile(handle, "/workspace/notes.txt", "inside");
  driver.symlink("alice", "/workspace/secret.txt", "/etc/passwd");

  await assert.rejects(manager.readFile("alice", "/workspace/secret.txt"), isOutsideError);
  await assert.rejects(manager.readFileBytes("alice", "/workspace/secret.txt", 1024), isOutsideError);
  await assert.rejects(manager.stat("alice", "/workspace/secret.txt"), isOutsideError);
  assert.equal(await manager.readFile("alice", "/workspace/notes.txt"), "inside");
});

test("write (file save/edit) refuses a symlink that points outside /workspace", async () => {
  const { driver, manager, handle } = install();
  await driver.writeFile(handle, "/workspace/file.txt", "original");
  // A symlink to a sensitive host path, and a symlinked directory.
  driver.symlink("alice", "/workspace/settings-link.json", "/home/node/.claude/settings.json");
  driver.symlink("alice", "/workspace/secret-dir", "/etc");

  await assert.rejects(manager.writeFile("alice", "/workspace/settings-link.json", "{}"), isOutsideError);
  await assert.rejects(manager.writeFile("alice", "/workspace/secret-dir/passwd", "x"), isOutsideError);
  // Nothing was written through the link.
  assert.equal(driver.peekFile("alice", "/home/node/.claude/settings.json"), undefined);
  assert.equal(driver.peekFile("alice", "/etc/passwd"), undefined);
  // Editing an ordinary file still works.
  await manager.writeFile("alice", "/workspace/file.txt", "edited");
  assert.equal(await manager.readFile("alice", "/workspace/file.txt"), "edited");
});

test("listDir refuses a directory symlink that points outside /workspace", async () => {
  const { driver, manager, handle } = install();
  await driver.writeFile(handle, "/workspace/src/app.ts", "code");
  driver.symlink("alice", "/workspace/out", "/etc");

  await assert.rejects(manager.listDir("alice", "/workspace/out"), isOutsideError);
  assert.deepEqual(
    (await manager.listDir("alice", "/workspace/src")).map((entry) => entry.name),
    ["app.ts"],
  );
});

test("symlinks that stay inside /workspace still work for read and write", async () => {
  const { driver, manager, handle } = install();
  await driver.writeFile(handle, "/workspace/real.txt", "real content");
  driver.symlink("alice", "/workspace/alias.txt", "/workspace/real.txt");
  driver.symlink("alice", "/workspace/alias-dir", "/workspace/nested");

  assert.equal(await manager.readFile("alice", "/workspace/alias.txt"), "real content");
  const bytes = await manager.readFileBytes("alice", "/workspace/alias.txt", 1024);
  assert.equal(bytes.content.toString("utf8"), "real content");

  await manager.writeFile("alice", "/workspace/alias.txt", "through the link");
  assert.equal(driver.peekFile("alice", "/workspace/real.txt"), "through the link");

  await manager.writeFile("alice", "/workspace/alias-dir/file.txt", "nested");
  assert.equal(driver.peekFile("alice", "/workspace/nested/file.txt"), "nested");
});

test("a symlink loop is refused rather than followed", async () => {
  const { driver, manager } = install();
  driver.symlink("alice", "/workspace/loop-a", "/workspace/loop-b");
  driver.symlink("alice", "/workspace/loop-b", "/workspace/loop-a");

  await assert.rejects(
    manager.readFile("alice", "/workspace/loop-a"),
    (err: unknown) => err instanceof VmPathError,
  );
});
