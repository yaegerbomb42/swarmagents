import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { TelemetryBus, type TelemetryEvent } from "../../../../../../lib/telemetry/bus";
import { configureRunsDir } from "../../../../../../lib/telemetry/paths";

function request(url: string, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${url}`, { headers });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function seed(dir: string): void {
  const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
  bus.publish("run_1", { type: "run.created", data: { prompt: "first run", userId: "alice" } });
  bus.publish("run_1", {
    type: "run.error",
    message: "anthropic api key sk-ant-abcdefghijklmnop was rejected",
  } as TelemetryEvent);
  bus.publish("run_2", { type: "run.created", data: { prompt: "bob run", userId: "bob" } });
}

test("GET /api/runtime/runs/<id>/log streams persisted events as ndjson", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-log-"));
  configureRunsDir(dir);
  try {
    seed(dir);

    const res = await GET(request("/api/runtime/runs/run_1/log"), ctx("run_1"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-ndjson");
    const disposition = res.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /run_1\.ndjson/);

    const text = await res.text();
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 2);
    const events = lines.map((line) => JSON.parse(line) as { type: string; seq: number });
    assert.deepEqual(events.map((event) => event.type), ["run.created", "run.error"]);
    assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/runs/<id>/log redacts secrets from the export", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-log-"));
  configureRunsDir(dir);
  try {
    seed(dir);

    const res = await GET(request("/api/runtime/runs/run_1/log"), ctx("run_1"));
    const text = await res.text();
    assert.ok(!text.includes("sk-ant-abcdefghijklmnop"));
    assert.ok(text.includes("[REDACTED]"));
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/runs/<id>/log rejects bad input and other users' runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-log-"));
  configureRunsDir(dir);
  try {
    seed(dir);
    assert.equal((await GET(request("/api/runtime/runs/run_1/log", null), ctx("run_1"))).status, 401);
    assert.equal((await GET(request("/api/runtime/runs/bad$id/log"), ctx("bad$id"))).status, 400);
    assert.equal((await GET(request("/api/runtime/runs/run_missing/log"), ctx("run_missing"))).status, 404);
    // Another user's run is indistinguishable from a missing run.
    assert.equal((await GET(request("/api/runtime/runs/run_2/log"), ctx("run_2"))).status, 404);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
