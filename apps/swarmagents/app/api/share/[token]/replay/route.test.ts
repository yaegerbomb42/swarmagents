/**
 * Public, token-gated access tests for GET /api/share/<token>/replay (core-32).
 *
 * The token is the only credential; the route must serve exactly the showcased
 * run's frames to a signed-out guest and 404 everything else — no showcase, a
 * revoked/unknown token, a report that no longer belongs to the share's
 * owner, or a missing replay file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { configureRunsDir } from "../../../../../lib/telemetry/paths";
import {
  configureProjectStoreDir,
  createProject,
  createShareLink,
  revokeShareLink,
  setShareShowcase,
} from "../../../../../lib/projects/store";
import { assembleReport, writeRunReport } from "../../../../../lib/runtime/run-report";
import { DESKTOP_REPLAY_FILE } from "../../../../../lib/runtime/run-report-types";
import type { SequencedEvent } from "../../../../../lib/telemetry/bus";

const FRAMES = Buffer.from([0, 0, 0, 0, 1, 0, 0, 0]);

function request(token: string): NextRequest {
  return new NextRequest(`http://localhost/api/share/${token}/replay`);
}

function ctx(token: string): { params: Promise<{ token: string }> } {
  return { params: Promise.resolve({ token }) };
}

function seedRun(runsDir: string, runId: string, userId: string, withReplay: boolean): void {
  const report = assembleReport({
    runId,
    userId,
    events: [{ type: "run.finished", seq: 1, runId, ts: 2 }] as unknown as SequencedEvent[],
    createdAt: 1,
    finishedAt: 2,
    artifacts: [],
    shots: [],
    prompt: "Build a landing page",
    replay: withReplay
      ? { file: DESKTOP_REPLAY_FILE, mime: "application/octet-stream", size: FRAMES.length, width: 1600, height: 900 }
      : undefined,
  });
  writeRunReport(runId, report, runsDir);
  if (withReplay) {
    const dir = path.join(runsDir, "reports", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, DESKTOP_REPLAY_FILE), FRAMES);
  }
}

test("the showcase replay is public to the token, with no user header and no owner identity", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "share-replay-"));
  configureRunsDir(runsDir);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "share-replay-store-"));
  configureProjectStoreDir(dataDir);
  try {
    seedRun(runsDir, "run_1", "alice", true);
    const project = createProject("alice", { name: "Public" });
    const share = createShareLink("alice", project.id);
    setShareShowcase("alice", project.id, "run_1");

    const res = await GET(request(share.token), ctx(share.token));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), FRAMES);
  } finally {
    configureProjectStoreDir("");
    configureRunsDir(null);
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("anything that is not a live showcase is a clean 404", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "share-replay-404-"));
  configureRunsDir(runsDir);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "share-replay-store-"));
  configureProjectStoreDir(dataDir);
  try {
    seedRun(runsDir, "run_1", "alice", true);
    const project = createProject("alice", { name: "Guards" });
    const share = createShareLink("alice", project.id);

    // No showcase attached yet.
    assert.equal((await GET(request(share.token), ctx(share.token))).status, 404);

    setShareShowcase("alice", project.id, "run_1");

    // Unknown/malformed tokens never resolve.
    assert.equal((await GET(request("f".repeat(48)), ctx("f".repeat(48)))).status, 404);
    assert.equal((await GET(request("../etc/passwd"), ctx("../etc/passwd"))).status, 404);

    // Revocation stops the bytes immediately.
    revokeShareLink("alice", project.id);
    assert.equal((await GET(request(share.token), ctx(share.token))).status, 404);
  } finally {
    configureProjectStoreDir("");
    configureRunsDir(null);
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a showcased report that no longer belongs to the share owner stops serving", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "share-replay-own-"));
  configureRunsDir(runsDir);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "share-replay-store-"));
  configureProjectStoreDir(dataDir);
  try {
    seedRun(runsDir, "run_1", "alice", true);
    const project = createProject("alice", { name: "Owned" });
    const share = createShareLink("alice", project.id);
    setShareShowcase("alice", project.id, "run_1");
    assert.equal((await GET(request(share.token), ctx(share.token))).status, 200);

    // The report on disk is re-owned (store drift / copied data): the route
    // re-verifies ownership per request instead of trusting the snapshot.
    seedRun(runsDir, "run_1", "bob", true);
    assert.equal((await GET(request(share.token), ctx(share.token))).status, 404);

    // The replay file disappearing is also a clean 404.
    seedRun(runsDir, "run_1", "alice", true);
    fs.rmSync(path.join(runsDir, "reports", "run_1", DESKTOP_REPLAY_FILE));
    assert.equal((await GET(request(share.token), ctx(share.token))).status, 404);
  } finally {
    configureProjectStoreDir("");
    configureRunsDir(null);
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
