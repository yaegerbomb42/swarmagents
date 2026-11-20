/**
 * Orphaned-run recovery: if the server restarts mid-run, the persisted run
 * history keeps the run as "running" forever. Constructing a RuntimeManager
 * (which a fresh server process does once) must finalize such runs as
 * errors with reason "server restarted" and append a run.error event to
 * their log.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus, type SequencedEvent, type TelemetryEvent } from "../telemetry/bus";
import { appendRunEvent } from "../telemetry/run-log";
import { getRun, setRecoveryEpochForTesting } from "./run-store";

test("RuntimeManager construction recovers queued runs orphaned by a restart", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-orphaned-queued-"));
  const prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = home;
  const runsDir = path.join(home, "runs");
  try {
    // A run that was queued behind an active one when the server died: the
    // queue is in-memory, so it can never start — it must not stay "queued".
    const before = new TelemetryBus({ persist: true });
    before.publish("run_queued", { type: "run.created", data: { prompt: "queued work", userId: "alice" } });
    before.publish("run_queued", { type: "run.queued", data: { position: 1, userId: "alice" } });

    assert.equal(getRun("run_queued", runsDir)?.summary.status, "queued");

    // The seeded run was written by this process, after the recovery epoch.
    // Shift the epoch forward so it predates the cutover, as if a previous
    // process had written it before this one started.
    setRecoveryEpochForTesting(getRun("run_queued", runsDir)!.summary.createdAt + 1);

    new RuntimeManager({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });

    const orphan = getRun("run_queued", runsDir);
    assert.ok(orphan);
    assert.equal(orphan.summary.status, "error");
    assert.equal(orphan.summary.error, "server restarted");
    assert.equal(orphan.events.length, 3);
    assert.equal(orphan.events[orphan.events.length - 1]?.type, "run.error");

    // Recovery is idempotent: a second construction appends nothing.
    new RuntimeManager({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });
    assert.equal(getRun("run_queued", runsDir)?.events.length, 3);
  } finally {
    setRecoveryEpochForTesting(Date.now());
    if (prevHome === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("runtime construction recovers orphaned runs but not ones live in this process", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-orphaned-live-"));
  const prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = home;
  const runsDir = path.join(home, "runs");
  const liveId = "run_live";
  const orphanId = "run_orphan_live";
  try {
    // A true orphan from a dead process: crafted with a timestamp from before
    // this process started, so it predates the recovery epoch. A live manager
    // cannot own it, so recovery must finalize it.
    const beforeEpoch = Date.now() - 60_000;
    appendRunEvent({ type: "run.created", seq: 1, runId: orphanId, ts: beforeEpoch, data: { prompt: "orphan work", userId: "alice" } } as SequencedEvent, runsDir);
    appendRunEvent(
      { type: "run.started", seq: 2, runId: orphanId, ts: beforeEpoch + 1, sessionId: "sess_2", model: "claude-test" } as SequencedEvent,
      runsDir,
    );

    // A live run owned by a sibling process that shares this runs dir: it is
    // born after this process's recovery epoch, so it is never an orphan.
    const before = new TelemetryBus({ persist: true });
    before.publish(liveId, { type: "run.created", data: { prompt: "live work", userId: "alice" } });
    before.publish(liveId, { type: "run.started", sessionId: "sess_1", model: "claude-test" } as TelemetryEvent);

    assert.equal(getRun(liveId, runsDir)?.summary.status, "running");

    new RuntimeManager({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });

    // The live run is untouched — recovery must not orphan it.
    assert.equal(getRun(liveId, runsDir)?.summary.status, "running");
    assert.equal(getRun(liveId, runsDir)?.events.length, 2);
    // The truly orphaned run is still recovered.
    const orphan = getRun(orphanId, runsDir);
    assert.ok(orphan);
    assert.equal(orphan.summary.status, "error");
    assert.equal(orphan.summary.error, "server restarted");
  } finally {
    setRecoveryEpochForTesting(Date.now());
    if (prevHome === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("RuntimeManager construction recovers orphaned runs after a restart", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-orphaned-"));
  const prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = home;
  const runsDir = path.join(home, "runs");
  try {
    // Simulate the pre-restart process: persist one run stuck mid-flight
    // and one run that already finished.
    const before = new TelemetryBus({ persist: true });
    before.publish("run_orphan", { type: "run.created", data: { prompt: "do work", userId: "alice" } });
    before.publish("run_orphan", { type: "run.started", sessionId: "sess_1", model: "claude-test" } as TelemetryEvent);
    before.publish("run_done", { type: "run.created", data: { prompt: "done work", userId: "alice" } });
    before.publish("run_done", { type: "run.finished", exitCode: 0, sessionId: "sess_2" } as TelemetryEvent);

    assert.equal(getRun("run_orphan", runsDir)?.summary.status, "running");

    // Shift the recovery epoch forward so the seeded runs predate the cutover,
    // as if a previous process had written them before this one started.
    setRecoveryEpochForTesting(getRun("run_orphan", runsDir)!.summary.createdAt + 1);

    // A fresh process constructs its RuntimeManager: the orphan is finalized.
    new RuntimeManager({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });

    const orphan = getRun("run_orphan", runsDir);
    assert.ok(orphan);
    assert.equal(orphan.summary.status, "error");
    assert.equal(orphan.summary.error, "server restarted");
    assert.ok(typeof orphan.summary.finishedAt === "number");
    assert.equal(orphan.events.length, 3);
    const last = orphan.events[orphan.events.length - 1];
    assert.equal(last?.type, "run.error");
    assert.equal((last as { message?: string }).message, "server restarted");
    assert.equal(last?.seq, 3);
    assert.deepEqual(orphan.events.map((event) => event.seq), [1, 2, 3]);

    // The finished run is untouched.
    const done = getRun("run_done", runsDir);
    assert.equal(done?.summary.status, "finished");
    assert.equal(done?.events.length, 2);

    // Recovery is idempotent: a second construction appends nothing.
    new RuntimeManager({ vm: new VmManager({ customDriver: new FakeVmDriver() }) });
    assert.equal(getRun("run_orphan", runsDir)?.events.length, 3);
  } finally {
    setRecoveryEpochForTesting(Date.now());
    if (prevHome === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
