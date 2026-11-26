import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { USER_HEADER } from "../../../lib/auth";
import { configureStorePaths } from "../../../lib/board/store";
import { configureProviderStorePaths, saveProvider } from "../../../lib/providers/store";

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

function liveness(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/health", { headers });
}

test("providersConfigured reflects a signed-in BYOK NVIDIA provider on liveness", async () => {
  const KEY = "nvapi-fake-user-key-0123456789";
  const USER = "local_alice@example.com";
  process.env.SWARM_HOME = tempDir;
  configureStorePaths(tempDir, join(tempDir, "swarm_board.json"));
  configureProviderStorePaths(join(tempDir, "providers.json"));

  const empty = await GET(liveness({ [USER_HEADER]: USER }));
  assert.equal(empty.status, 200);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.providersScope, "user");
  assert.equal(emptyBody.providersConfigured, 0);

  saveProvider(USER, { id: "nvidia-nim", apiKey: KEY });
  const res = await GET(liveness({ [USER_HEADER]: USER }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providersScope, "user");
  assert.equal(body.providersConfigured, 1);
  const raw = JSON.stringify(body);
  assert.equal(raw.includes(KEY), false);
  assert.equal(raw.includes("nvidia-nim"), false);
  assert.equal(raw.includes("NVIDIA"), false);

  configureProviderStorePaths("");
});

test("anonymous liveness counts host-env providers without leaking names", async () => {
  const prev = process.env.SWARM_KEYS_NVIDIA_NIM;
  try {
    delete process.env.SWARM_KEYS_NVIDIA_NIM;
    let res = await GET(liveness());
    let body = await res.json();
    assert.equal(body.providersScope, "host-env");
    const baseline = body.providersConfigured;

    process.env.SWARM_KEYS_NVIDIA_NIM = "nvapi-host-only";
    res = await GET(liveness());
    body = await res.json();
    assert.equal(body.providersConfigured, baseline + 1);
    assert.equal(JSON.stringify(body).includes("nvapi-host-only"), false);
    assert.equal(JSON.stringify(body).includes("nvidia"), false);
  } finally {
    if (prev === undefined) delete process.env.SWARM_KEYS_NVIDIA_NIM;
    else process.env.SWARM_KEYS_NVIDIA_NIM = prev;
  }
});


test("the public probe answers signed out with 200/503 JSON, never 401", async () => {
  // Live, this route sat behind a stale auth layer and returned 401 to the
  // deploy healthcheck. Both probe forms must be reachable with no session
  // cookie and no USER_HEADER: liveness returns 200 JSON, readiness returns
  // 200 or 503 JSON — anything in the 401 family is a regression.
  process.env.SWARM_HOME = tempDir;

  const live = await GET(liveness());
  assert.equal(live.status, 200);
  const liveBody = await live.json();
  assert.equal(typeof liveBody, "object");
  assert.equal(liveBody.error, undefined);
  assert.equal(liveBody.ok, true);
  assert.equal(liveBody.providersScope, "host-env");
  assert.equal(typeof liveBody.version, "string");
  assert.equal(JSON.stringify(liveBody).includes("Sign in required"), false);

  const ready = await GET(request());
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.equal(readyBody.ready, true);
  assert.equal(readyBody.error, undefined);
  assert.equal(JSON.stringify(readyBody).includes("Sign in required"), false);
});

test("an anonymous failing readiness probe still gets JSON 503, not 401", async () => {
  // The degradation signal must survive a broken environment: an unauthenticated
  // monitor still receives the redacted per-check payload with status 503.
  const notADir = join(tempDir, "not-a-dir");
  writeFileSync(notADir, "x");
  process.env.SWARM_HOME = notADir;

  const res = await GET(request());
  assert.equal(res.status, 503);
  assert.notEqual(res.status, 401);
  const body = await res.json();
  assert.equal(body.ready, false);
  assert.equal(body.error, undefined);
});
