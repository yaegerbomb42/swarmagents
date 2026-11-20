/**
 * Ownership tests for the telemetry SSE route. A signed-in caller may only
 * stream a run they own; ownership is checked against the live RuntimeManager
 * state and the durable run store.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "./[runId]/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../lib/runtime/manager";
import { TelemetryBus, telemetryBus, type TelemetryEvent } from "../../../../lib/telemetry/bus";
import { configureRunsDir } from "../../../../lib/telemetry/paths";
import { VmManager } from "../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../lib/vm/fake-driver";
import { parseSse } from "../../../../lib/client/sse";

function request(runId: string, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost/api/runtime/stream/${runId}`, { headers });
}

function ctx(runId: string): { params: Promise<{ runId: string }> } {
  return { params: Promise.resolve({ runId }) };
}

function seed(dir: string, runId: string, userId: string): void {
  configureRunsDir(dir);
  const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
  bus.publish(runId, { type: "run.created", data: { prompt: "hello", userId } });
  bus.publish(runId, { type: "run.finished", exitCode: 0 } as TelemetryEvent);
}

async function withRunsDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-stream-route-"));
  try {
    await fn(dir);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
  configureRunsDir(null);
});

test("streams a run to its owner", async () => {
  await withRunsDir(async (dir) => {
    seed(dir, "run_owner", "alice");
    const res = await GET(request("run_owner"), ctx("run_owner"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    await res.body?.cancel();
  });
});

test("returns 404 when the run belongs to another user", async () => {
  await withRunsDir(async (dir) => {
    seed(dir, "run_bob", "bob");

    const res = await GET(request("run_bob", "alice"), ctx("run_bob"));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Run not found." });

    // Unknown runs are indistinguishable from another user's run.
    assert.equal((await GET(request("run_missing", "alice"), ctx("run_missing"))).status, 404);
    // The owner can still read it.
    const owner = await GET(request("run_bob", "bob"), ctx("run_bob"));
    assert.equal(owner.status, 200);
    await owner.body?.cancel();
  });
});

test("returns 401 when x-swarm-user is missing", async () => {
  await withRunsDir(async (dir) => {
    seed(dir, "run_owner", "alice");
    const res = await GET(request("run_owner", null), ctx("run_owner"));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Sign in required." });
  });
});

test("allows a live run owned in the RuntimeManager before it is persisted", async () => {
  configureRunsDir(null);
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });
  setRuntimeManagerForTesting(manager);
  const { runId } = manager.start("alice", { prompt: "live run" });
  try {
    const res = await GET(request(runId, "alice"), ctx(runId));
    assert.equal(res.status, 200);
    await res.body?.cancel();

    assert.equal((await GET(request(runId, "bob"), ctx(runId))).status, 404);
  } finally {
    manager.cancel("alice");
  }
});

test("honours Last-Event-ID by replaying events after that id", async () => {
  await withRunsDir(async (dir) => {
    // The route streams from the process-wide bus, which persists to runsDir.
    configureRunsDir(dir);
    telemetryBus.publish("run_resume", { type: "run.created", data: { userId: "alice" } } as TelemetryEvent);
    telemetryBus.publish("run_resume", { type: "one" });
    telemetryBus.publish("run_resume", { type: "two" });

    const headers = new Headers({ "x-swarm-user": "alice", "last-event-id": "1" });
    const req = new NextRequest("http://localhost/api/runtime/stream/run_resume", { headers });
    const res = await GET(req, ctx("run_resume"));
    assert.equal(res.status, 200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 5; i++) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: two\n")) break;
    }
    await reader.cancel();

    const frames = parseSse(text);
    const types = frames.map((f) => (JSON.parse(f.data) as { type: string }).type);
    assert.deepEqual(types, ["one", "two"]);
    assert.deepEqual(frames.map((f) => f.id), ["2", "3"]);
  });
});

test("keeps the fresh-stream behaviour when no Last-Event-ID is sent", async () => {
  await withRunsDir(async (dir) => {
    configureRunsDir(dir);
    telemetryBus.publish("run_noid", { type: "run.created", data: { userId: "alice" } } as TelemetryEvent);
    telemetryBus.publish("run_noid", { type: "one" });

    const res = await GET(request("run_noid"), ctx("run_noid"));
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 5; i++) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: one\n")) break;
    }
    await reader.cancel();

    const types = parseSse(text).map((f) => (JSON.parse(f.data) as { type: string }).type);
    assert.deepEqual(types, ["run.created", "one"]);
  });
});

test("fresh connect to an evicted cancelled run replays the log and closes", async () => {
  await withRunsDir(async (dir) => {
    // Repro of the reported bug: the run was cancelled while queued, the
    // in-memory bus evicted it after 60 s idle, and a fresh GET then hung
    // on keep-alives. The process-wide bus holds nothing for this run —
    // only the durable log does — so the stream must replay from the log
    // and close on the terminal event.
    configureRunsDir(dir);
    const writer = new TelemetryBus({ persist: true, runsDir: () => dir });
    writer.publish("run_evicted", { type: "run.created", data: { userId: "alice" } } as TelemetryEvent);
    writer.publish("run_evicted", { type: "run.queued", data: {} } as TelemetryEvent);
    writer.publish("run_evicted", { type: "run.cancelled", data: {} } as TelemetryEvent);
    assert.equal(telemetryBus.latestSeq("run_evicted"), 0, "bus holds nothing for this run");

    const res = await GET(request("run_evicted"), ctx("run_evicted"));
    assert.equal(res.status, 200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      const result = await reader.read();
      done = result.done;
      if (result.value) text += decoder.decode(result.value, { stream: true });
    }
    assert.equal(done, true, "the server closed the stream after the terminal event");

    const types = parseSse(text).map((f) => (JSON.parse(f.data) as { type: string }).type);
    assert.deepEqual(types, ["run.created", "run.queued", "run.cancelled"]);
  });
});
