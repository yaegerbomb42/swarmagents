/**
 * Owner-only access tests for GET /api/runtime/runs/<id>/report/replay.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { configureRunsDir } from "../../../../../../../lib/telemetry/paths";
import { assembleReport, writeRunReport } from "../../../../../../../lib/runtime/run-report";
import { DESKTOP_REPLAY_FILE } from "../../../../../../../lib/runtime/run-report-types";
import type { SequencedEvent } from "../../../../../../../lib/telemetry/bus";

const FRAMES = Buffer.from([0, 0, 0, 0, 1, 0, 0, 0]);

function request(user: string | null): NextRequest {
  const headers = new Headers();
  if (user) headers.set("x-swarm-user", user);
  return new NextRequest("http://localhost/api/runtime/runs/run_1/report/replay", { headers });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function seed(runsDir: string, userId: string, withReplay: boolean): void {
  const report = assembleReport({
    runId: "run_1",
    userId,
    events: [{ type: "run.finished", seq: 1, runId: "run_1", ts: 2 }] as unknown as SequencedEvent[],
    createdAt: 1,
    finishedAt: 2,
    artifacts: [],
    shots: [],
    replay: withReplay
      ? { file: DESKTOP_REPLAY_FILE, mime: "application/octet-stream", size: FRAMES.length, width: 1600, height: 900 }
      : undefined,
  });
  writeRunReport("run_1", report, runsDir);
  if (withReplay) {
    const dir = path.join(runsDir, "reports", "run_1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, DESKTOP_REPLAY_FILE), FRAMES);
  }
}

test.afterEach(() => {
  configureRunsDir(null);
});

test("replay route guards auth, run id and ownership", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-route-"));
  configureRunsDir(runsDir);
  try {
    seed(runsDir, "alice", true);
    assert.equal((await GET(request(null), ctx("run_1"))).status, 401);
    assert.equal((await GET(request("alice"), ctx("bad$id"))).status, 400);
    assert.equal((await GET(request("bob"), ctx("run_1"))).status, 404);
    assert.equal((await GET(request("alice"), ctx("run_missing"))).status, 404);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("the owner gets the recorded frames with no decoding on the server", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-route-owner-"));
  configureRunsDir(runsDir);
  try {
    seed(runsDir, "alice", true);
    const res = await GET(request("alice"), ctx("run_1"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.match(res.headers.get("cache-control") ?? "", /private/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), FRAMES);

    seed(runsDir, "alice", false);
    assert.equal((await GET(request("alice"), ctx("run_1"))).status, 404, "no replay is a clean 404");
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
