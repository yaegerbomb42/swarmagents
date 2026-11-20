/**
 * Tests for the runner's execution backends.
 *
 * Host mode has to present the same `/workspace` contract as the container
 * (the server sends absolute sandbox paths); these tests pin that mapping and
 * the workspace containment check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContainerBackend, HostBackend, NODE_DESKTOP_PORT, sanitizeUserId } from "./backend";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-node-backend-"));
}

test("host backend: /workspace maps to the user's workspace directory", () => {
  const root = tempRoot();
  const backend = new HostBackend({ root });
  assert.equal(backend.resolve("alice", "/workspace"), backend.workspace("alice"));
  assert.equal(
    backend.resolve("alice", "/workspace/sub/a.txt"),
    path.join(backend.workspace("alice"), "sub", "a.txt"),
  );
});

test("host backend: a path cannot escape the workspace", () => {
  const root = tempRoot();
  const backend = new HostBackend({ root });
  assert.throws(() => backend.resolve("alice", "/workspace/../bob"), /outside of the workspace/);
  assert.throws(() => backend.resolve("alice", "../../etc/passwd"), /outside of the workspace/);
});

test("host backend: files written through the VM contract are readable back", async () => {
  const root = tempRoot();
  const backend = new HostBackend({ root });
  await backend.ensure("alice");
  await backend.writeFile("alice", "/workspace/notes/hello.txt", "hi there");
  assert.equal(await backend.readFile("alice", "/workspace/notes/hello.txt"), "hi there");
  assert.deepEqual(
    fs.readdirSync(path.join(backend.workspace("alice"), "notes")),
    ["hello.txt"],
  );
});

test("host backend: exec runs with /workspace as the sandbox cwd", async () => {
  const root = tempRoot();
  const backend = new HostBackend({ root });
  await backend.ensure("alice");
  let stdout = "";
  const result = await backend.exec("alice", ["pwd"], {
    cwd: "/workspace",
    onStdout: (chunk) => {
      stdout += chunk;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.realpathSync(stdout.trim()), fs.realpathSync(backend.workspace("alice")));
});

test("container backend: the sandbox is hardened and the desktop stays on loopback", () => {
  const backend = new ContainerBackend({
    image: "swarm-vm:desktop",
    desktop: true,
    desktopPassword: "test-password",
  });
  const args = backend.runArgs("alice").join(" ");
  assert.ok(args.includes("--security-opt no-new-privileges"));
  assert.ok(args.includes("--cap-drop ALL"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes(`127.0.0.1::${NODE_DESKTOP_PORT}`));
  // The workspace is a volume, never a host bind mount.
  assert.ok(args.includes("/workspace"));
  assert.ok(!args.includes(":rw"));
});

test("container backend: user ids cannot inject docker flags", () => {
  assert.equal(sanitizeUserId("--privileged"), "privileged");
  assert.equal(sanitizeUserId("../../root"), "root");
  const backend = new ContainerBackend({ image: "swarm-vm:desktop", desktopPassword: "test-password" });
  const name = backend.runArgs("--rm").join(" ");
  assert.ok(!name.includes("--rm"));
});
