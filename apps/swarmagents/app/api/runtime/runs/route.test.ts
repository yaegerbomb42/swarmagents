import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as listGET } from "./route";
import { GET as replayGET } from "./[id]/route";
import { TelemetryBus, type TelemetryEvent } from "../../../../lib/telemetry/bus";
import { configureRunsDir } from "../../../../lib/telemetry/paths";

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
  bus.publish("run_1", { type: "run.started", sessionId: "sess_1" } as TelemetryEvent);
  bus.publish("run_1", { type: "run.finished", exitCode: 0, sessionId: "sess_1", costUsd: 0.03 } as TelemetryEvent);
  bus.publish("run_2", { type: "run.created", data: { prompt: "second run", userId: "alice" } });
  bus.publish("run_3", { type: "run.created", data: { prompt: "bob run", userId: "bob" } });
}

test("GET /api/runtime/runs lists durable runs with status and cost", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-route-"));
  configureRunsDir(dir);
  try {
    seed(dir);

    const res = await listGET(request("/api/runtime/runs"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { runs: Array<Record<string, unknown>> };
    assert.equal(body.runs.length, 2);
    const first = body.runs.find((run) => run.runId === "run_1");
    assert.equal(first?.status, "finished");
    assert.equal(first?.costUsd, 0.03);
    assert.equal(first?.prompt, "first run");

    assert.equal((await listGET(request("/api/runtime/runs?limit=1"))).status, 200);
    assert.equal(((await (await listGET(request("/api/runtime/runs?limit=1"))).json()) as { runs: unknown[] }).runs.length, 1);
    const sinceBody = (await (await listGET(request(`/api/runtime/runs?since=${Date.now() + 60_000}`))).json()) as {
      runs: unknown[];
    };
    assert.equal(sinceBody.runs.length, 0);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/runs/<id> replays persisted events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-route-"));
  configureRunsDir(dir);
  try {
    seed(dir);

    const res = await replayGET(request("/api/runtime/runs/run_1"), ctx("run_1"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      runId: string;
      summary: { status: string };
      events: Array<{ type: string; seq: number }>;
    };
    assert.equal(body.runId, "run_1");
    assert.equal(body.summary.status, "finished");
    assert.deepEqual(body.events.map((event) => event.type), ["run.created", "run.started", "run.finished"]);
    assert.deepEqual(body.events.map((event) => event.seq), [1, 2, 3]);

    const from = await replayGET(request("/api/runtime/runs/run_1?from=1"), ctx("run_1"));
    const fromBody = (await from.json()) as { events: Array<{ seq: number }> };
    assert.deepEqual(fromBody.events.map((event) => event.seq), [2, 3]);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/runs rejects bad input and unknown runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-route-"));
  configureRunsDir(dir);
  try {
    seed(dir);
    assert.equal((await listGET(request("/api/runtime/runs", null))).status, 401);
    assert.equal((await replayGET(request("/api/runtime/runs/run_1", null), ctx("run_1"))).status, 401);
    assert.equal((await replayGET(request("/api/runtime/runs/bad$id"), ctx("bad$id"))).status, 400);
    assert.equal((await replayGET(request("/api/runtime/runs/run_missing"), ctx("run_missing"))).status, 404);
    // Runs owned by another user are not readable.
    assert.equal((await replayGET(request("/api/runtime/runs/run_3"), ctx("run_3"))).status, 404);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/runs/<id> redacts logged secrets and hides ownerless runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-redact-"));
  configureRunsDir(dir);
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    bus.publish("run_owned", { type: "run.created", data: { prompt: "safe sk-123456789012345678901234", userId: "alice" } });
    bus.publish("run_owned", { type: "tool.result", output: "credential sk-123456789012345678901234" } as TelemetryEvent);
    bus.publish("run_ownerless", { type: "run.created", data: { prompt: "private" } });

    const replay = await replayGET(request("/api/runtime/runs/run_owned"), ctx("run_owned"));
    const body = await replay.json() as { events: Array<{ output?: string }>; summary: { prompt: string } };
    assert.match(body.events[1].output ?? "", /\[REDACTED\]/);
    assert.match(body.summary.prompt, /\[REDACTED\]/);
    assert.equal((await replayGET(request("/api/runtime/runs/run_ownerless"), ctx("run_ownerless"))).status, 404);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/runs paginates with ?limit and ?before and returns nextCursor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-page-"));
  configureRunsDir(dir);
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    for (const r of ["run_a", "run_b", "run_c", "run_d", "run_e"]) {
      bus.publish(r, { type: "run.created", data: { prompt: r, userId: "alice" } });
    }

    const page1 = (await (await listGET(request("/api/runtime/runs?limit=2"))).json()) as {
      runs: Array<{ runId: string }>;
      nextCursor: string | null;
    };
    assert.equal(page1.runs.length, 2);
    assert.ok(page1.nextCursor);

    const page2 = (await (await listGET(request(`/api/runtime/runs?limit=2&before=${page1.nextCursor}`))).json()) as {
      runs: Array<{ runId: string }>;
      nextCursor: string | null;
    };
    assert.equal(page2.runs.length, 2);
    const seen = new Set([...page1.runs, ...page2.runs].map((r) => r.runId));
    assert.equal(seen.size, 4);

    const page3 = (await (await listGET(request(`/api/runtime/runs?limit=2&before=${page2.nextCursor}`))).json()) as {
      runs: Array<{ runId: string }>;
      nextCursor: string | null;
    };
    assert.equal(page3.runs.length, 1);
    assert.equal(page3.nextCursor, null);

    // A numeric before cursor works too.
    const numeric = (await (await listGET(request(`/api/runtime/runs?before=${Date.now() + 60_000}`))).json()) as {
      runs: unknown[];
      nextCursor: string | null;
    };
    assert.equal(numeric.runs.length, 5);
    assert.equal(numeric.nextCursor, null);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/runs rejects invalid pagination params", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-invalid-"));
  configureRunsDir(dir);
  try {
    seed(dir);
    assert.equal((await listGET(request("/api/runtime/runs?limit=abc"))).status, 400);
    assert.equal((await listGET(request("/api/runtime/runs?limit=0"))).status, 400);
    assert.equal((await listGET(request("/api/runtime/runs?limit=-1"))).status, 400);
    assert.equal((await listGET(request("/api/runtime/runs?before=not-a-run"))).status, 400);
    assert.equal((await listGET(request("/api/runtime/runs?before=0"))).status, 400);
    // A run owned by another user is not a valid cursor for this caller.
    assert.equal((await listGET(request("/api/runtime/runs?before=run_3"))).status, 400);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/runtime/runs filters by ?sessionId", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-runs-session-"));
  configureRunsDir(dir);
  try {
    seed(dir);
    const body = (await (await listGET(request("/api/runtime/runs?sessionId=sess_1"))).json()) as {
      runs: Array<{ runId: string }>;
    };
    assert.deepEqual(body.runs.map((r) => r.runId), ["run_1"]);
    const empty = (await (await listGET(request("/api/runtime/runs?sessionId=nope"))).json()) as {
      runs: unknown[];
    };
    assert.equal(empty.runs.length, 0);
    // A runId selects its own sessionless run (run_2 has no sessionId).
    const own = (await (await listGET(request("/api/runtime/runs?sessionId=run_2"))).json()) as {
      runs: Array<{ runId: string }>;
    };
    assert.deepEqual(own.runs.map((r) => r.runId), ["run_2"]);
    assert.equal((await listGET(request("/api/runtime/runs?sessionId="))).status, 400);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
