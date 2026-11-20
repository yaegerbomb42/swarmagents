import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { TelemetryBus, type TelemetryEvent } from "../../../../lib/telemetry/bus";
import { configureRunsDir } from "../../../../lib/telemetry/paths";

function request(url: string, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${url}`, { headers });
}

function seed(dir: string): void {
  const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
  // Thread sess_1: two runs.
  bus.publish("run_1", { type: "run.created", data: { prompt: "first thread prompt", userId: "alice" } });
  bus.publish("run_1", { type: "run.started", sessionId: "sess_1" } as TelemetryEvent);
  bus.publish("run_1", { type: "run.finished", exitCode: 0, sessionId: "sess_1" } as TelemetryEvent);
  bus.publish("run_2", { type: "run.created", data: { prompt: "second run same thread", userId: "alice" } });
  bus.publish("run_2", { type: "run.started", sessionId: "sess_1" } as TelemetryEvent);
  bus.publish("run_2", { type: "run.finished", exitCode: 0, sessionId: "sess_1" } as TelemetryEvent);
  // Thread sess_2: one run.
  bus.publish("run_3", { type: "run.created", data: { prompt: "another thread entirely", userId: "alice" } });
  bus.publish("run_3", { type: "run.started", sessionId: "sess_2" } as TelemetryEvent);
  bus.publish("run_3", { type: "run.finished", exitCode: 0, sessionId: "sess_2" } as TelemetryEvent);
  // Sessionless run: its own one-run thread, keyed by runId.
  bus.publish("run_4", { type: "run.created", data: { prompt: "never started", userId: "alice" } });
  // Another user's thread: never visible to alice.
  bus.publish("run_5", { type: "run.created", data: { prompt: "bob run", userId: "bob" } });
  bus.publish("run_5", { type: "run.started", sessionId: "sess_bob" } as TelemetryEvent);
}

test("GET /api/runtime/threads groups runs by session with title and run count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-threads-route-"));
  configureRunsDir(dir);
  try {
    seed(dir);

    const res = await GET(request("/api/runtime/threads"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      threads: Array<{ id: string; title: string; createdAt: number; updatedAt: number; runCount: number }>;
    };
    assert.equal(body.threads.length, 3);

    const byId = new Map(body.threads.map((t) => [t.id, t]));
    const first = byId.get("sess_1");
    assert.ok(first);
    assert.equal(first.runCount, 2);
    assert.equal(first.title, "first thread prompt");
    assert.ok(first.updatedAt >= first.createdAt);

    const second = byId.get("sess_2");
    assert.ok(second);
    assert.equal(second.runCount, 1);
    assert.equal(second.title, "another thread entirely");

    // Sessionless run is its own thread, keyed by runId.
    const lonely = byId.get("run_4");
    assert.ok(lonely);
    assert.equal(lonely.runCount, 1);
    assert.equal(lonely.title, "never started");

    assert.ok(!byId.has("sess_bob"));
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/threads requires sign-in and validates limit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-threads-route-"));
  configureRunsDir(dir);
  try {
    seed(dir);
    assert.equal((await GET(request("/api/runtime/threads", null))).status, 401);
    assert.equal((await GET(request("/api/runtime/threads?limit=abc"))).status, 400);
    assert.equal((await GET(request("/api/runtime/threads?limit=0"))).status, 400);
    const limited = (await (await GET(request("/api/runtime/threads?limit=1"))).json()) as {
      threads: unknown[];
    };
    assert.equal(limited.threads.length, 1);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
