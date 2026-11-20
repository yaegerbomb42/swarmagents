/**
 * GET /api/runtime/vm/screenshot captures to a unique path per request and
 * deletes it immediately after the read, so concurrent requests never share
 * (or truncate) one frame file. Tested with a stub driver that records the
 * scrot target and simulates the frame, so no Docker or X server is needed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { VmManager, setVmManagerForTesting } from "../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../lib/vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../../../../../lib/vm/types";

const FRAME = "fake-png-frame-bytes";
const FRAME_PATH_RE = /^\/tmp\/swarm-desktop-frame-[0-9a-f-]{36}\.png$/;

class ScrotDriver extends FakeVmDriver {
  scrotPaths: string[] = [];
  removedPaths: string[] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "scrot") {
      const target = cmd[cmd.length - 1];
      this.scrotPaths.push(target);
      // scrot writes the frame; the route then reads it back.
      await this.writeFile(handle, target, FRAME);
      return { exitCode: 0 };
    }
    const result = await super.exec(handle, cmd, opts);
    if (cmd[0] === "rm") this.removedPaths.push(cmd[cmd.length - 1]);
    return result;
  }
}

function request(user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest("http://localhost/api/runtime/vm/screenshot", { headers });
}

test.afterEach(() => setVmManagerForTesting(null));

test("screenshot route rejects unauthenticated requests", async () => {
  setVmManagerForTesting(new VmManager({ customDriver: new ScrotDriver() }));
  assert.equal((await GET(request(null))).status, 401);
});

test("screenshot route returns 404 when the VM is not running", async () => {
  setVmManagerForTesting(new VmManager({ customDriver: new ScrotDriver() }));
  assert.equal((await GET(request())).status, 404);
});

test("each request captures to its own unique path and deletes it after the read", async () => {
  const driver = new ScrotDriver();
  const manager = new VmManager({ customDriver: driver });
  setVmManagerForTesting(manager);
  await manager.writeFile("alice", "/workspace/seed.txt", "x");

  const first = await GET(request());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/png");
  assert.equal(await first.text(), FRAME);

  const second = await GET(request());
  assert.equal(second.status, 200);
  assert.equal(await second.text(), FRAME);

  assert.equal(driver.scrotPaths.length, 2);
  assert.ok(driver.scrotPaths.every((p) => FRAME_PATH_RE.test(p)), `paths must be unique per request: ${driver.scrotPaths}`);
  assert.notEqual(driver.scrotPaths[0], driver.scrotPaths[1], "two requests must not share a frame path");
  assert.ok(!driver.scrotPaths.includes("/tmp/swarm-desktop-frame.png"), "the legacy shared path must never be used");
  assert.deepEqual([...driver.removedPaths].sort(), [...driver.scrotPaths].sort(), "every frame must be removed after its read");
  for (const path of driver.scrotPaths) {
    await assert.rejects(
      manager.readFileBytes("alice", path, 1024),
      "the frame must be gone from the VM after the response",
    );
  }
});

test("concurrent requests never share a frame path", async () => {
  const driver = new ScrotDriver();
  const manager = new VmManager({ customDriver: driver });
  setVmManagerForTesting(manager);
  await manager.writeFile("alice", "/workspace/seed.txt", "x");

  const [a, b] = await Promise.all([GET(request()), GET(request())]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(await a.text(), FRAME);
  assert.equal(await b.text(), FRAME);
  assert.equal(driver.scrotPaths.length, 2);
  assert.notEqual(driver.scrotPaths[0], driver.scrotPaths[1]);
  assert.deepEqual([...driver.removedPaths].sort(), [...driver.scrotPaths].sort());
});
