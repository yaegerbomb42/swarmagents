import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { USER_HEADER } from "../../../../../../lib/auth";
import { configureRunsDir } from "../../../../../../lib/telemetry/paths";
import { appendRunEvent, flushRunLogs } from "../../../../../../lib/telemetry/run-log";
import { clearAllUserDrivingForTests, isUserDriving } from "../../../../../../lib/runtime/user-driving";
import { POST } from "./route";

let tmpDir = "";

async function seedRun(runId: string, userId: string): Promise<void> {
  appendRunEvent(
    { seq: 1, runId, ts: Date.now(), type: "run.created", data: { userId, prompt: "test" } },
    tmpDir,
  );
  await flushRunLogs(tmpDir);
}

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pause-input-"));
  configureRunsDir(tmpDir);
  clearAllUserDrivingForTests();
});

test.afterEach(() => {
  clearAllUserDrivingForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(runId: string, body: unknown, user?: string): NextRequest {
  return new NextRequest(`http://localhost/api/runtime/runs/${runId}/pause-input`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(user ? { [USER_HEADER]: user } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("pause-input enforces auth and run ownership", async () => {
  const unauth = await POST(req("run_1", { action: "pause" }), { params: Promise.resolve({ id: "run_1" }) });
  assert.equal(unauth.status, 401);

  await seedRun("run_owner", "alice");
  const other = await POST(req("run_owner", { action: "pause" }, "bob"), {
    params: Promise.resolve({ id: "run_owner" }),
  });
  assert.equal(other.status, 404);
});

test("pause-input pauses on owner input and clears on handback", async () => {
  await seedRun("run_alice", "alice");

  const pauseRes = await POST(req("run_alice", { action: "pause" }, "alice"), {
    params: Promise.resolve({ id: "run_alice" }),
  });
  assert.equal(pauseRes.status, 200);
  const pauseJson = (await pauseRes.json()) as { ok: boolean; driving: boolean };
  assert.equal(pauseJson.ok, true);
  assert.equal(pauseJson.driving, true);
  assert.equal(isUserDriving("run_alice"), true);

  const handbackRes = await POST(req("run_alice", { action: "handback" }, "alice"), {
    params: Promise.resolve({ id: "run_alice" }),
  });
  assert.equal(handbackRes.status, 200);
  const handbackJson = (await handbackRes.json()) as { ok: boolean; driving: boolean; note: string };
  assert.equal(handbackJson.ok, true);
  assert.equal(handbackJson.driving, false);
  assert.match(handbackJson.note, /Call describe_screen before acting/);
  assert.equal(isUserDriving("run_alice"), false);
});
