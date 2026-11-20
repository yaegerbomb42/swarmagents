import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { USER_HEADER } from "../../../lib/auth";

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/health?ready=1", { headers });
}

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-health-route-"));
  for (const key of ["SWARM_SERVER_MODE", "SWARM_OWNER_EMAIL", "SWARM_HOME", "SWARM_VM_DRIVER"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.SWARM_SERVER_MODE = "1";
  process.env.SWARM_OWNER_EMAIL = "owner@example.com";
  process.env.SWARM_VM_DRIVER = "fake";
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("anonymous readiness failure exposes only booleans and reason codes", async () => {
  const notADir = join(tempDir, "not-a-dir");
  writeFileSync(notADir, "x");
  process.env.SWARM_HOME = notADir;

  const res = await GET(request());
  assert.equal(res.status, 503);
  const body = await res.json();

  assert.equal(body.ready, false);
  assert.deepEqual(body.home, { ok: false, writable: false, reason: "HOME_NOT_WRITABLE" });
  assert.equal(body.vmDriver.ok, true);
  assert.equal("detail" in body, false);

  const text = JSON.stringify(body);
  assert.equal(text.includes(notADir), false);
  assert.equal(text.includes(tempDir), false);
  assert.equal(text.includes("/"), false);
  assert.equal(text.includes("not a directory"), false);
});

test("non-owner signed-in users still get the redacted payload", async () => {
  const notADir = join(tempDir, "not-a-dir");
  writeFileSync(notADir, "x");
  process.env.SWARM_HOME = notADir;

  const res = await GET(request({ [USER_HEADER]: "local_other@example.com" }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal("detail" in body, false);
  assert.equal(JSON.stringify(body).includes(notADir), false);
});

test("the owner admin view retains the path and disk detail", async () => {
  const notADir = join(tempDir, "not-a-dir");
  writeFileSync(notADir, "x");
  process.env.SWARM_HOME = notADir;

  const res = await GET(request({ [USER_HEADER]: "local_owner@example.com" }));
  assert.equal(res.status, 503);
  const body = await res.json();

  assert.equal(body.ready, false);
  assert.equal(body.home.reason, "HOME_NOT_WRITABLE");
  assert.equal(body.detail.home.dir, notADir);
  assert.equal(body.detail.home.writable, false);
  assert.equal(typeof body.detail.disk.freeBytes, "number");
  assert.equal(typeof body.detail.disk.freeMb, "number");
  assert.equal(body.detail.vmDriver.kind, "fake");
});

test("the harness bearer is treated as an operator", async () => {
  const notADir = join(tempDir, "not-a-dir");
  writeFileSync(notADir, "x");
  process.env.SWARM_HOME = notADir;

  const res = await GET(request({ [USER_HEADER]: "harness" }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.detail.home.dir, notADir);
});

test("a ready probe returns 200 and no operator detail publicly", async () => {
  process.env.SWARM_HOME = tempDir;

  const res = await GET(request());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ready, true);
  assert.equal(body.home.writable, true);
  assert.equal("detail" in body, false);
  assert.equal(JSON.stringify(body).includes(tempDir), false);
});
