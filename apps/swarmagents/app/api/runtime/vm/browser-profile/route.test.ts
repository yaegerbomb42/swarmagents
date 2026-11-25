/**
 * GET /api/runtime/vm/browser-profile reports only { exists, sizeMb } —
 * never file names, let alone cookie or token contents — and DELETE removes
 * the caller's own profile only. Both reject unauthenticated requests, and
 * one user's profile is invisible to (and undeletable by) another user.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, DELETE } from "./route";
import { VmManager, setVmManagerForTesting, VM_BROWSER_PROFILE_PATH } from "../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../lib/vm/fake-driver";

function request(user: string | null = "alice", method = "GET"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest("http://localhost/api/runtime/vm/browser-profile", { headers, method });
}

test.afterEach(() => setVmManagerForTesting(null));

test("browser-profile rejects unauthenticated requests", async () => {
  setVmManagerForTesting(new VmManager({ customDriver: new FakeVmDriver() }));
  assert.equal((await GET(request(null))).status, 401);
  assert.equal((await DELETE(request(null, "DELETE"))).status, 401);
});

test("GET reports a missing profile as absent with zero size", async () => {
  setVmManagerForTesting(new VmManager({ customDriver: new FakeVmDriver() }));
  const res = await GET(request());
  assert.equal(res.status, 200);
  const body = (await res.json()) as unknown;
  assert.deepEqual(body, { exists: false, sizeMb: 0 });
  assert.deepEqual(Object.keys(body as Record<string, unknown>).sort(), ["exists", "sizeMb"]);
});

test("GET reports an existing profile with its size and nothing else", async () => {
  const manager = new VmManager({ customDriver: new FakeVmDriver() });
  setVmManagerForTesting(manager);

  await manager.writeFile("alice", `${VM_BROWSER_PROFILE_PATH}/Cookies`, "x".repeat(2048));
  await manager.writeFile("alice", `${VM_BROWSER_PROFILE_PATH}/Login Data`, "y".repeat(1024));

  const res = await GET(request());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { exists: boolean; sizeMb: number };
  assert.equal(body.exists, true);
  // 2048 + 1024 bytes = 3 KB -> 1 MB rounded up.
  assert.equal(body.sizeMb, 1);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("xxx") && !text.includes("yyy"), "no file contents leak into the response");
});

test("DELETE removes the profile and is idempotent when already absent", async () => {
  const manager = new VmManager({ customDriver: new FakeVmDriver() });
  setVmManagerForTesting(manager);

  await manager.writeFile("alice", `${VM_BROWSER_PROFILE_PATH}/Cookies`, "x".repeat(2048));
  assert.equal(((await (await GET(request())).json()) as { exists: boolean }).exists, true);

  const res = await DELETE(request("alice", "DELETE"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { exists: false, sizeMb: 0 });
  assert.deepEqual(await (await GET(request())).json(), { exists: false, sizeMb: 0 });

  // Deleting a missing profile still succeeds.
  const again = await DELETE(request("alice", "DELETE"));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { exists: false, sizeMb: 0 });
});

test("one user's profile is invisible to and undeletable by another user", async () => {
  const manager = new VmManager({ customDriver: new FakeVmDriver() });
  setVmManagerForTesting(manager);

  await manager.writeFile("alice", `${VM_BROWSER_PROFILE_PATH}/Cookies`, "x".repeat(2048));

  // Bob sees no profile, even though Alice has one.
  assert.deepEqual(await (await GET(request("bob"))).json(), { exists: false, sizeMb: 0 });

  // Bob's DELETE succeeds (idempotent) but removes nothing of Alice's.
  const del = await DELETE(request("bob", "DELETE"));
  assert.equal(del.status, 200);
  assert.deepEqual(await (await GET(request("alice"))).json(), { exists: true, sizeMb: 1 });
});
