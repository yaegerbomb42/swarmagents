/**
 * Owner-only access tests for the run-report routes:
 *   GET /api/runtime/runs/<id>/report
 *   GET /api/runtime/runs/<id>/report/shots/<index>
 *   GET /api/runtime/runs/<id>/report/artifacts?path=<rel>
 *
 * Reports are seeded directly on disk (via the run-report store helpers) and
 * the VM file reads go through the fake driver.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as GET_REPORT } from "./route";
import { GET as GET_SHOT } from "./shots/[index]/route";
import { GET as GET_ARTIFACT } from "./artifacts/route";
import { VmManager, setVmManagerForTesting } from "../../../../../../lib/vm/manager";
import { configureRunsDir } from "../../../../../../lib/telemetry/paths";
import { FakeVmDriver } from "../../../../../../lib/vm/fake-driver";
import { assembleReport, writeRunReport, writeShotFile } from "../../../../../../lib/runtime/run-report";
import type { SequencedEvent } from "../../../../../../lib/telemetry/bus";

function request(url: string, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${url}`, { headers });
}

function ctx(id: string, index?: string): { params: Promise<{ id: string; index: string }> } {
  return { params: Promise.resolve({ id, index: index ?? "" }) };
}

function seedEvents(userId: string): SequencedEvent[] {
  return [
    { type: "run.created", data: { prompt: "make two files", userId }, seq: 1, runId: "run_1", ts: 1_000 },
    { type: "run.started", sessionId: "s1", model: "claude-test", provider: "anthropic", seq: 2, runId: "run_1", ts: 2_000 },
    { type: "assistant.text", text: "all done", seq: 3, runId: "run_1", ts: 3_000 },
    { type: "run.finished", exitCode: 0, sessionId: "s1", costUsd: 0.1, durationMs: 5000, numTurns: 2, seq: 4, runId: "run_1", ts: 6_000 },
  ] as unknown as SequencedEvent[];
}

function seedReport(runsDir: string, userId: string, dir: string) {
  const report = assembleReport({
    runId: "run_1",
    userId,
    events: seedEvents(userId),
    createdAt: 1_000,
    finishedAt: 6_000,
    artifacts: [
      { path: `${dir}/a.txt`, rel: "a.txt", size: 5, mtimeMs: 6_000, change: "created" },
      { path: `${dir}/sub/b.txt`, rel: "sub/b.txt", size: 9, mtimeMs: 6_000, change: "modified" },
    ],
    shots: [
      { file: "000.png", mime: "image/png", seq: 0, ts: 1_000, label: "Start", size: 4 },
      { file: "001.png", mime: "image/png", seq: 3, ts: 3_000, label: "End", size: 4 },
    ],
  });
  writeRunReport("run_1", report, runsDir);
  writeShotFile(
    "run_1",
    report.shots[0],
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    runsDir,
  );
  writeShotFile(
    "run_1",
    report.shots[1],
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    runsDir,
  );
}

test.afterEach(() => {
  setVmManagerForTesting(null);
  configureRunsDir(null);
});

test("report routes reject unauthenticated and invalid requests", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-report-route-"));
  configureRunsDir(runsDir);
  try {
    seedReport(runsDir, "alice", "/workspace");
    assert.equal((await GET_REPORT(request("/api/runtime/runs/run_1/report", null), ctx("run_1"))).status, 401);
    assert.equal((await GET_REPORT(request("/api/runtime/runs/bad$id/report"), ctx("bad$id"))).status, 400);
    assert.equal((await GET_SHOT(request("/api/runtime/runs/run_1/report/shots/0", null), ctx("run_1", "0"))).status, 401);
    assert.equal((await GET_SHOT(request("/api/runtime/runs/run_1/report/shots/abc"), ctx("run_1", "abc"))).status, 400);
    assert.equal((await GET_ARTIFACT(request("/api/runtime/runs/run_1/report/artifacts?path=a.txt", null), ctx("run_1"))).status, 401);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("report is owner-only: another user gets 404", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-report-route-"));
  configureRunsDir(runsDir);
  try {
    seedReport(runsDir, "alice", "/workspace");
    assert.equal((await GET_REPORT(request("/api/runtime/runs/run_1/report", "bob"), ctx("run_1"))).status, 404);
    assert.equal((await GET_SHOT(request("/api/runtime/runs/run_1/report/shots/0", "bob"), ctx("run_1", "0"))).status, 404);
    assert.equal((await GET_ARTIFACT(request("/api/runtime/runs/run_1/report/artifacts?path=a.txt", "bob"), ctx("run_1"))).status, 404);
    // Unknown runs are 404 too.
    assert.equal((await GET_REPORT(request("/api/runtime/runs/run_missing/report"), ctx("run_missing"))).status, 404);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("owner reads the full report JSON", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-report-route-"));
  configureRunsDir(runsDir);
  try {
    seedReport(runsDir, "alice", "/workspace");
    const res = await GET_REPORT(request("/api/runtime/runs/run_1/report"), ctx("run_1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.runId, "run_1");
    assert.equal(body.userId, "alice");
    assert.equal(body.meta.artifacts, 2);
    assert.equal(body.meta.shots, 2);
    assert.equal(body.meta.steps, body.steps.length);
    assert.deepEqual(body.meta.providers, ["anthropic"]);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("owner downloads screenshots with correct mime and range handling", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-report-route-"));
  configureRunsDir(runsDir);
  try {
    seedReport(runsDir, "alice", "/workspace");
    const res = await GET_SHOT(request("/api/runtime/runs/run_1/report/shots/1"), ctx("run_1", "1"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47]);
    // Out-of-range index.
    assert.equal((await GET_SHOT(request("/api/runtime/runs/run_1/report/shots/9"), ctx("run_1", "9"))).status, 404);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("owner downloads artifacts from the VM; others get 404", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-report-route-"));
  configureRunsDir(runsDir);
  const driver = new FakeVmDriver();
  driver.writeFile({ userId: "alice", containerName: "c", createdAt: 0 }, "/workspace/a.txt", "hello world");
  driver.writeFile({ userId: "alice", containerName: "c", createdAt: 0 }, "/workspace/sub/b.txt", "payload-123");
  setVmManagerForTesting(new VmManager({ customDriver: driver }));
  try {
    seedReport(runsDir, "alice", "/workspace");
    const res = await GET_ARTIFACT(request("/api/runtime/runs/run_1/report/artifacts?path=a.txt"), ctx("run_1"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    const text = await res.text();
    assert.equal(text, "hello world");

    const nested = await GET_ARTIFACT(request("/api/runtime/runs/run_1/report/artifacts?path=sub%2Fb.txt"), ctx("run_1"));
    assert.equal(nested.status, 200);
    assert.equal(await nested.text(), "payload-123");

    // Another user is refused.
    assert.equal(
      (await GET_ARTIFACT(request("/api/runtime/runs/run_1/report/artifacts?path=a.txt", "bob"), ctx("run_1"))).status,
      404,
    );
    // Paths not listed as artifacts are refused even for the owner.
    assert.equal(
      (await GET_ARTIFACT(request("/api/runtime/runs/run_1/report/artifacts?path=nope.txt"), ctx("run_1"))).status,
      404,
    );
    // Paths outside /workspace are refused.
    assert.equal(
      (await GET_ARTIFACT(request("/api/runtime/runs/run_1/report/artifacts?path=..%2Fetc%2Fpasswd"), ctx("run_1"))).status,
      400,
    );
    // Artifact listed but missing from the VM -> 404.
    const resMissing = await GET_ARTIFACT(request("/api/runtime/runs/run_1/report/artifacts?path=sub%2Fgone.txt"), ctx("run_1"));
    assert.equal(resMissing.status, 404);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("a report with no recorded owner is not public", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-report-route-"));
  configureRunsDir(runsDir);
  try {
    const report = assembleReport({
      runId: "run_1",
      userId: "alice",
      events: seedEvents("alice"),
      createdAt: 1_000,
      finishedAt: 6_000,
      artifacts: [],
      shots: [],
    });
    const { userId: _owner, ...unowned } = report;
    void _owner;
    writeRunReport("run_1", unowned as typeof report, runsDir);
    assert.equal((await GET_REPORT(request("/api/runtime/runs/run_1/report", "bob"), ctx("run_1"))).status, 404);
    assert.equal((await GET_REPORT(request("/api/runtime/runs/run_1/report", "alice"), ctx("run_1"))).status, 404);
    assert.equal((await GET_SHOT(request("/api/runtime/runs/run_1/report/shots/0", "alice"), ctx("run_1", "0"))).status, 404);
    assert.equal((await GET_ARTIFACT(request("/api/runtime/runs/run_1/report/artifacts?path=a.txt", "alice"), ctx("run_1"))).status, 404);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
