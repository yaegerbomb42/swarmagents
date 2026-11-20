import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus, type TelemetryEvent } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import { listRuns, listThreads } from "./run-store";

function seed(dir: string): void {
  const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
  // Project A: two runs in one thread.
  bus.publish("run_a1", { type: "run.created", data: { prompt: "project a first", userId: "alice", projectId: "prj_a" } });
  bus.publish("run_a1", { type: "run.started", sessionId: "sess_a" } as unknown as TelemetryEvent);
  bus.publish("run_a2", { type: "run.created", data: { prompt: "project a second", userId: "alice", projectId: "prj_a" } });
  bus.publish("run_a2", { type: "run.started", sessionId: "sess_a" } as unknown as TelemetryEvent);
  // Project B: one thread.
  bus.publish("run_b1", { type: "run.created", data: { prompt: "project b", userId: "alice", projectId: "prj_b" } });
  bus.publish("run_b1", { type: "run.started", sessionId: "sess_b" } as unknown as TelemetryEvent);
  // Loose thread: no project.
  bus.publish("run_loose", { type: "run.created", data: { prompt: "loose", userId: "alice" } });
  bus.publish("run_loose", { type: "run.started", sessionId: "sess_loose" } as unknown as TelemetryEvent);
  // Another account's project must never appear.
  bus.publish("run_bob", { type: "run.created", data: { prompt: "bob", userId: "bob", projectId: "prj_a" } });
}

test("run store: filters runs and threads by project, per account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-project-threads-"));
  configureRunsDir(dir);
  try {
    seed(dir);

    const aRuns = listRuns({ userId: "alice", projectId: "prj_a" });
    assert.deepEqual(aRuns.map((run) => run.runId).sort(), ["run_a1", "run_a2"]);
    assert.equal(aRuns.every((run) => run.projectId === "prj_a"), true);

    const threads = listThreads({ userId: "alice", projectId: "prj_a" });
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, "sess_a");
    assert.equal(threads[0].runCount, 2);

    const bThreads = listThreads({ userId: "alice", projectId: "prj_b" });
    assert.deepEqual(bThreads.map((thread) => thread.id), ["sess_b"]);

    // Bob's run carries the same project id but is not alice's.
    assert.equal(listThreads({ userId: "alice", projectId: "prj_b" }).some((thread) => thread.id === "sess_loose"), false);
    assert.deepEqual(listRuns({ userId: "bob", projectId: "prj_a" }).map((run) => run.runId), ["run_bob"]);

    // No filter keeps the global thread list.
    assert.equal(listThreads({ userId: "alice" }).length, 3);
  } finally {
    configureRunsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
