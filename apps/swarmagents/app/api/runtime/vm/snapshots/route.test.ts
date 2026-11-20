/**
 * Tests for /api/runtime/vm/snapshots with the fake VM driver.
 * Auth is the middleware-set x-swarm-user header.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { VmManager, setVmManagerForTesting } from "../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../lib/vm/fake-driver";

function install(driver = new FakeVmDriver()): VmManager {
  const manager = new VmManager({ customDriver: driver });
  setVmManagerForTesting(manager);
  return manager;
}

function request(path: string, init: RequestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${path}`, { ...init, headers, signal: init.signal ?? undefined });
}

function post(body: unknown, user: string | null = "alice"): Promise<Response> {
  return POST(request("/api/runtime/vm/snapshots", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }, user));
}

async function json(res: Response): Promise<any> {
  return res.json();
}

test.afterEach(() => {
  setVmManagerForTesting(null);
});

test("GET and POST reject unauthenticated requests", async () => {
  install();
  assert.equal((await GET(request("/api/runtime/vm/snapshots", {}, null))).status, 401);
  assert.equal((await post({ label: "checkpoint-1" }, null)).status, 401);
});

test("POST creates a checkpoint and GET lists it", async () => {
  install();

  const created = await post({ label: "checkpoint-1" });
  assert.equal(created.status, 201);
  const createdBody = await json(created);
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.snapshot.label, "checkpoint-1");

  const listed = await GET(request("/api/runtime/vm/snapshots"));
  assert.equal(listed.status, 200);
  const { snapshots } = await json(listed);
  assert.deepEqual(snapshots.map((s: { label: string }) => s.label), ["checkpoint-1"]);
});

test("POST restore rolls the VM back and supports the action form", async () => {
  const driver = new FakeVmDriver();
  const vm = install(driver);

  await vm.writeFile("alice", "/workspace/data.txt", "before");
  assert.equal((await post({ action: "create", label: "safe" })).status, 201);
  await vm.writeFile("alice", "/workspace/data.txt", "after");

  const restored = await post({ action: "restore", label: "safe" });
  assert.equal(restored.status, 200);
  assert.deepEqual(await json(restored), { ok: true, label: "safe" });
  assert.equal(await vm.readFile("alice", "/workspace/data.txt"), "before");
});

test("POST restore supports the restore shorthand and 404s unknown labels", async () => {
  install();
  assert.equal((await post({ restore: "missing" })).status, 404);

  await post({ create: "present" });
  assert.equal((await post({ restore: "present" })).status, 200);
});

test("POST delete removes the checkpoint and 404s unknown labels", async () => {
  install();

  await post({ label: "disposable" });
  await post({ label: "keeper" });

  const deleted = await post({ action: "delete", label: "disposable" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await json(deleted), { ok: true, label: "disposable" });
  const listed = await json(await GET(request("/api/runtime/vm/snapshots")));
  assert.deepEqual(listed.snapshots.map((s: { label: string }) => s.label), ["keeper"]);

  assert.equal((await post({ action: "delete", label: "disposable" })).status, 404);
  assert.equal((await post({ delete: "ghost" })).status, 404);
});

test("POST validates the label and the body", async () => {
  install();

  assert.equal((await post("not json")).status, 400);
  assert.equal((await post([])).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ label: 42 })).status, 400);
  assert.equal((await post({ label: "" })).status, 400);
  assert.equal((await post({ label: "has space" })).status, 400);
  assert.equal((await post({ label: "UPPER" })).status, 400);
  assert.equal((await post({ label: "../evil" })).status, 400);
  assert.equal((await post({ action: "explode", label: "ok" })).status, 400);
});

test("checkpoints are isolated per user", async () => {
  install();

  await post({ label: "alice-snap" }, "alice");
  const bobList = await json(await GET(request("/api/runtime/vm/snapshots", {}, "bob")));
  assert.deepEqual(bobList.snapshots, []);

  const aliceList = await json(await GET(request("/api/runtime/vm/snapshots", {}, "alice")));
  assert.deepEqual(aliceList.snapshots.map((s: { label: string }) => s.label), ["alice-snap"]);
});
