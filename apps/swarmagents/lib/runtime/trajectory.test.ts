import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "../../app/api/runtime/runs/[id]/trajectory/route";
import { TelemetryBus, type SequencedEvent } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import { assembleReport, writeRunReport } from "./run-report";
import {
  attachRunTrajectory,
  MAX_TRAJECTORY_BYTES,
  readRunTrajectory,
  trajectoryCaptureEnabled,
  trajectoryFile,
  TRAJECTORY_CAPTURE_ENV,
} from "./trajectory";

function makeReport(runId: string, userId: string): ReturnType<typeof assembleReport> {
  const events: SequencedEvent[] = [
    { type: "run.created", data: { prompt: "hello", userId }, seq: 1, runId, ts: 1_000 },
    { type: "run.finished", data: { exitCode: 0 }, seq: 2, runId, ts: 2_000 },
  ];
  return assembleReport({ runId, userId, events, createdAt: 1_000, finishedAt: 2_000, artifacts: [], shots: [] });
}

function request(url: string, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${url}`, { headers });
}

test.afterEach(() => configureRunsDir(null));

test("trajectory capture is disabled by default and writes nothing", () => {
  const previous = process.env[TRAJECTORY_CAPTURE_ENV];
  delete process.env[TRAJECTORY_CAPTURE_ENV];
  assert.equal(trajectoryCaptureEnabled(), false);
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-trajectory-off-"));
  try {
    const bus = new TelemetryBus();
    attachRunTrajectory("run_off", "alice", bus, { runsDir });
    bus.publish("run_off", { type: "run.created", data: { userId: "alice" } });
    assert.equal(fs.existsSync(trajectoryFile(runsDir, "run_off")), false);
  } finally {
    if (previous === undefined) delete process.env[TRAJECTORY_CAPTURE_ENV];
    else process.env[TRAJECTORY_CAPTURE_ENV] = previous;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("opted-in capture stores ordered events and the final report in one JSONL file", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-trajectory-on-"));
  const bus = new TelemetryBus();
  configureRunsDir(runsDir);
  try {
    attachRunTrajectory("run_trajectory", "alice", bus, { enabled: true, runsDir });
    bus.publish("run_trajectory", { type: "run.created", data: { prompt: "hello", userId: "alice" } });
    bus.publish("run_trajectory", { type: "assistant.text", data: { text: "done" } });
    bus.publish("run_trajectory", { type: "run.finished", data: { exitCode: 0 } });
    writeRunReport("run_trajectory", makeReport("run_trajectory", "alice"), runsDir);

    let record = readRunTrajectory("run_trajectory", runsDir);
    for (let attempt = 0; attempt < 30 && !record?.contents.includes('"kind":"report"'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      record = readRunTrajectory("run_trajectory", runsDir);
    }
    assert.ok(record);
    const rows = record.contents.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; event?: SequencedEvent; report?: { runId: string } });
    assert.deepEqual(rows.filter((row) => row.kind === "event").map((row) => row.event?.seq), [1, 2, 3]);
    assert.equal(rows.at(-1)?.kind, "report");
    assert.equal(rows.at(-1)?.report?.runId, "run_trajectory");
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("capture drops oldest events with a marker and remains within the five MB cap", () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-trajectory-cap-"));
  try {
    const bus = new TelemetryBus();
    attachRunTrajectory("run_large", "alice", bus, { enabled: true, runsDir });
    bus.publish("run_large", { type: "large.event", data: { payload: "x".repeat(MAX_TRAJECTORY_BYTES + 1) } });
    const record = readRunTrajectory("run_large", runsDir);
    assert.ok(record);
    assert.ok(Buffer.byteLength(record.contents, "utf8") <= MAX_TRAJECTORY_BYTES);
    const rows = record.contents.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; droppedCount?: number; throughSeq?: number });
    assert.ok(rows.some((row) => row.kind === "truncated" && row.droppedCount === 1 && row.throughSeq === 1));
    assert.equal(rows.some((row) => row.kind === "event"), false);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("a final report is retained after oversized events are dropped", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-trajectory-report-cap-"));
  const bus = new TelemetryBus();
  try {
    attachRunTrajectory("run_report_cap", "alice", bus, { enabled: true, runsDir });
    bus.publish("run_report_cap", { type: "large.event", data: { payload: "x".repeat(MAX_TRAJECTORY_BYTES + 1) } });
    bus.publish("run_report_cap", { type: "run.finished", data: { exitCode: 0 } });
    writeRunReport("run_report_cap", makeReport("run_report_cap", "alice"), runsDir);

    let record = readRunTrajectory("run_report_cap", runsDir);
    for (let attempt = 0; attempt < 30 && !record?.contents.includes('"kind":"report"'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      record = readRunTrajectory("run_report_cap", runsDir);
    }
    assert.ok(record);
    assert.ok(Buffer.byteLength(record.contents, "utf8") <= MAX_TRAJECTORY_BYTES);
    const rows = record.contents.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; event?: SequencedEvent; droppedCount?: number; report?: { runId: string } });
    assert.ok(rows.some((row) => row.kind === "truncated" && row.droppedCount === 1));
    assert.deepEqual(rows.filter((row) => row.kind === "event").map((row) => row.event?.type), ["run.finished"]);
    assert.equal(rows.at(-1)?.report?.runId, "run_report_cap");
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("trajectory download is owner-only", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-trajectory-route-"));
  configureRunsDir(runsDir);
  try {
    const bus = new TelemetryBus();
    attachRunTrajectory("run_route", "alice", bus, { enabled: true, runsDir });
    bus.publish("run_route", { type: "run.created", data: { userId: "alice" } });
    const ctx = { params: Promise.resolve({ id: "run_route" }) };
    const owner = await GET(request("/api/runtime/runs/run_route/trajectory", "alice"), ctx);
    assert.equal(owner.status, 200);
    assert.match(owner.headers.get("content-disposition") ?? "", /run_route\.jsonl/);
    assert.match(await owner.text(), /"userId":"alice"/);
    assert.equal((await GET(request("/api/runtime/runs/run_route/trajectory", "bob"), ctx)).status, 404);
    assert.equal((await GET(request("/api/runtime/runs/run_route/trajectory", null), ctx)).status, 401);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
