import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus, type SequencedEvent, type TelemetryEvent } from "../telemetry/bus";
import { listRunLogs, readRunEvents } from "../telemetry/run-log";
import {
  clearRunIndexCache,
  readRunSummary,
  runIndexEventReadCount,
  runIndexFile,
  setRunIndexEventReaderForTests,
} from "./run-index";
import { getRun, listRuns } from "./run-store";
import { summarizeRun } from "./run-summary";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-run-index-"));
}

function persistBus(dir: string): TelemetryBus {
  return new TelemetryBus({ persist: true, runsDir: () => dir });
}

/** Write a run log directly, bypassing the index (a pre-index install). */
function writeRunLog(
  dir: string,
  runId: string,
  createdAt: number,
  userId = "alice",
  eventCount = 1,
): void {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "run.created",
      seq: 1,
      runId,
      ts: createdAt,
      data: { prompt: `p:${runId}`, userId, sessionId: `s:${runId}` },
    }),
  );
  for (let seq = 2; seq < eventCount; seq++) {
    lines.push(
      JSON.stringify({
        type: "assistant.text",
        seq,
        runId,
        ts: createdAt + seq,
        text: `event ${seq} of ${runId}`,
      }),
    );
  }
  if (eventCount > 1) {
    lines.push(
      JSON.stringify({
        type: "run.finished",
        seq: eventCount,
        runId,
        ts: createdAt + eventCount,
        exitCode: 0,
        costUsd: 0.01,
      }),
    );
  }
  fs.writeFileSync(path.join(dir, `${runId}.jsonl`), `${lines.join("\n")}\n`);
}

test("index summaries match a full-log fold for every persisted run", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_a", { type: "run.created", data: { prompt: "a", userId: "alice", sessionId: "s1" } });
    bus.publish("run_a", { type: "usage", inputTokens: 10, outputTokens: 4, cachedTokens: 1 } as TelemetryEvent);
    bus.publish("run_a", { type: "run.finished", exitCode: 0, costUsd: 0.1, durationMs: 12 } as TelemetryEvent);
    bus.publish("run_b", { type: "run.created", data: { prompt: "b", userId: "bob", kind: "shell" } });
    bus.publish("run_b", { type: "run.error", message: "boom", exitCode: 1 } as TelemetryEvent);

    for (const info of listRunLogs(dir)) {
      const full = getRun(info.runId, dir);
      assert.ok(full);
      const indexed = readRunSummary(info.runId, dir);
      assert.ok(indexed);
      assert.deepEqual(indexed, full.summary, `${info.runId} index must match the full fold`);
      assert.ok(fs.existsSync(runIndexFile(dir, info.runId)), "sidecar should exist");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns rebuilds a missing or corrupt index from the logs (migration)", () => {
  const dir = tmpDir();
  try {
    writeRunLog(dir, "run_1", 1000, "alice", 3);
    writeRunLog(dir, "run_2", 2000, "alice", 3);
    writeRunLog(dir, "run_3", 3000, "bob", 2);

    // No sidecars exist yet: the first list migrates them from the logs.
    assert.equal(fs.existsSync(runIndexFile(dir, "run_1")), false);
    clearRunIndexCache();
    let runs = listRuns({ runsDir: dir });
    assert.deepEqual(runs.map((r) => r.runId), ["run_3", "run_2", "run_1"]);
    for (const runId of ["run_1", "run_2", "run_3"]) {
      assert.ok(fs.existsSync(runIndexFile(dir, runId)), `${runId} sidecar rebuilt`);
    }

    // A deleted sidecar is rebuilt on the next listing.
    fs.unlinkSync(runIndexFile(dir, "run_2"));
    clearRunIndexCache();
    runs = listRuns({ runsDir: dir });
    assert.equal(runs.find((r) => r.runId === "run_2")?.lastSeq, 3);
    assert.ok(fs.existsSync(runIndexFile(dir, "run_2")));

    // So is a corrupt one.
    fs.writeFileSync(runIndexFile(dir, "run_1"), "{ this is not json", "utf8");
    clearRunIndexCache();
    runs = listRuns({ runsDir: dir });
    assert.equal(runs.find((r) => r.runId === "run_1")?.prompt, "p:run_1");
    const repaired = JSON.parse(fs.readFileSync(runIndexFile(dir, "run_1"), "utf8")) as {
      summary: { runId: string };
    };
    assert.equal(repaired.summary.runId, "run_1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a sidecar older than its log is rebuilt instead of served stale (crash recovery)", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_crash", { type: "run.created", data: { prompt: "crash", userId: "alice" } });
    // Simulate a crash between the log append and the index write: the run
    // finished in the log, but the sidecar still says "running".
    const finished = { type: "run.finished", seq: 2, runId: "run_crash", ts: Date.now(), exitCode: 0, costUsd: 1 };
    fs.appendFileSync(path.join(dir, "run_crash.jsonl"), `${JSON.stringify(finished)}\n`);

    // With a warm cache: the log stamp changed, so the cached summary is stale.
    assert.equal(listRuns({ runsDir: dir })[0]?.status, "finished");
    // With a cold process (empty cache): the sidecar's stored log stamp still
    // no longer matches, so it is rebuilt and healed on read.
    clearRunIndexCache();
    assert.equal(listRuns({ runsDir: dir })[0]?.status, "finished");
    assert.equal(readRunSummary("run_crash", dir)?.status, "finished");
    // The healed sidecar now matches the log and is trusted on the next read
    // without rebuilding.
    setRunIndexEventReaderForTests(() => {
      throw new Error("a fresh index must not read event segments");
    });
    assert.equal(readRunSummary("run_crash", dir)?.costUsd, 1);
    assert.equal(runIndexEventReadCount(), 0);
  } finally {
    setRunIndexEventReaderForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns filters, sorts, limits and paginates on the index", () => {
  const dir = tmpDir();
  try {
    // Same creation time for two runs exercises the runId tie-break.
    writeRunLog(dir, "run_a", 5000, "alice");
    writeRunLog(dir, "run_z", 5000, "alice");
    writeRunLog(dir, "run_old", 1000, "alice");
    writeRunLog(dir, "run_bob", 9000, "bob");

    assert.deepEqual(
      listRuns({ runsDir: dir }).map((r) => r.runId),
      ["run_bob", "run_z", "run_a", "run_old"],
    );
    assert.deepEqual(
      listRuns({ runsDir: dir, userId: "alice" }).map((r) => r.runId),
      ["run_z", "run_a", "run_old"],
    );
    assert.equal(listRuns({ runsDir: dir, limit: 2 }).length, 2);
    assert.deepEqual(
      listRuns({ runsDir: dir, userId: "alice", limit: 1 }).map((r) => r.runId),
      ["run_z"],
    );
    // Keyset pagination: strictly before the runId boundary.
    assert.deepEqual(
      listRuns({ runsDir: dir, userId: "alice", before: "run_a" }).map((r) => r.runId),
      ["run_old"],
    );
    assert.deepEqual(
      listRuns({ runsDir: dir, before: 5000 }).map((r) => r.runId),
      ["run_old"],
    );
    assert.deepEqual(listRuns({ runsDir: dir, userId: "nobody" }), []);

    // Every indexed summary still equals the full-log fold.
    for (const info of listRunLogs(dir)) {
      const full = getRun(info.runId, dir);
      const indexed = readRunSummary(info.runId, dir);
      assert.ok(full && indexed);
      assert.deepEqual(indexed, full.summary);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appending events updates the sidecar incrementally after the first rebuild", () => {
  const dir = tmpDir();
  try {
    setRunIndexEventReaderForTests(null); // reset the process-global read counter
    const bus = persistBus(dir);
    bus.publish("run_inc", { type: "run.created", data: { prompt: "inc", userId: "alice" } });
    // The first event could not use an existing sidecar, so it rebuilt once.
    assert.equal(runIndexEventReadCount(), 1);

    setRunIndexEventReaderForTests(null); // reset the counter
    bus.publish("run_inc", { type: "usage", inputTokens: 3, outputTokens: 2 } as TelemetryEvent);
    bus.publish("run_inc", { type: "usage", inputTokens: 4, outputTokens: 5 } as TelemetryEvent);
    bus.publish("run_inc", { type: "run.finished", exitCode: 0, costUsd: 0.2 } as TelemetryEvent);
    assert.equal(runIndexEventReadCount(), 0, "the append fast path must not read the log");

    const summary = readRunSummary("run_inc", dir);
    assert.equal(summary?.tokensIn, 7);
    assert.equal(summary?.tokensOut, 7);
    assert.equal(summary?.status, "finished");
    assert.equal(summary?.costUsd, 0.2);
    assert.deepEqual(summary, getRun("run_inc", dir)?.summary);
  } finally {
    setRunIndexEventReaderForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("benchmark: listRuns over 100 x 400-event runs is < 10ms and reads no event segments", () => {
  const dir = tmpDir();
  try {
    const RUNS = 100;
    const EVENTS = 400;
    const pad = "x".repeat(180);
    for (let i = 0; i < RUNS; i++) {
      const runId = `run_bench_${i}`;
      const userId = i % 2 === 0 ? "alice" : "bob";
      const base = 1_700_000_000_000 + i * 1000;
      const lines: string[] = [];
      lines.push(
        JSON.stringify({
          type: "run.created",
          seq: 1,
          runId,
          ts: base,
          data: { prompt: `bench ${i}`, userId, sessionId: `sess_${i}` },
        }),
      );
      for (let seq = 2; seq < EVENTS; seq++) {
        lines.push(JSON.stringify({ type: "assistant.text", seq, runId, ts: base + seq, text: pad }));
      }
      lines.push(
        JSON.stringify({
          type: "run.finished",
          seq: EVENTS,
          runId,
          ts: base + EVENTS,
          exitCode: 0,
          costUsd: 0.02,
        }),
      );
      fs.writeFileSync(path.join(dir, `${runId}.jsonl`), `${lines.join("\n")}\n`);
    }

    // First list migrates every pre-index log; later lists hit the index.
    clearRunIndexCache();
    assert.equal(listRuns({ runsDir: dir, limit: 20 }).length, 20);

    // Spy on full-log reads: no listing below may rebuild.
    let segmentReads = 0;
    setRunIndexEventReaderForTests((runId, runsDir) => {
      segmentReads += 1;
      return readRunEvents(runId, runsDir);
    });

    // Warm the process-local cache once, then take the median of five runs.
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const runs = listRuns({ runsDir: dir, limit: 20 });
      timings.push(performance.now() - start);
      assert.equal(runs.length, 20);
    }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];
    assert.ok(median < 10, `listRuns(limit=20) took ${median.toFixed(2)}ms (want < 10ms)`);

    // A user with no runs is filtered out on the index alone: zero event reads.
    const before = segmentReads;
    const none = listRuns({ runsDir: dir, userId: "nobody", limit: 5 });
    assert.deepEqual(none, []);
    assert.equal(segmentReads, before, "filtering by userId must not read event segments");
    assert.equal(runIndexEventReadCount(), 0, "no run should need an index rebuild");

    // Every run's indexed summary still agrees with a full-fold reference.
    const sample = readRunSummary("run_bench_42", dir);
    assert.equal(sample?.userId, "alice");
    assert.equal(sample?.lastSeq, EVENTS);
    assert.deepEqual(sample, getRun("run_bench_42", dir)?.summary);
  } finally {
    setRunIndexEventReaderForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeRun remains the canonical fold for an event list", () => {
  const events: SequencedEvent[] = [
    {
      type: "run.created",
      seq: 1,
      runId: "run_ref",
      ts: 1000,
      data: { prompt: "ref", userId: "alice", sessionId: "s1", projectId: "p1" },
    },
    { type: "run.started", seq: 2, runId: "run_ref", ts: 1100, provider: "radium", model: "m1" },
    { type: "usage", seq: 3, runId: "run_ref", ts: 1200, inputTokens: 2, outputTokens: 3 },
    {
      type: "run.finished",
      seq: 4,
      runId: "run_ref",
      ts: 1300,
      exitCode: 0,
      costUsd: 0.3,
      durationMs: 300,
      numTurns: 1,
    },
  ] as SequencedEvent[];
  const summary = summarizeRun("run_ref", events);
  assert.equal(summary.prompt, "ref");
  assert.equal(summary.userId, "alice");
  assert.equal(summary.projectId, "p1");
  assert.equal(summary.provider, "radium");
  assert.equal(summary.tokensIn, 2);
  assert.equal(summary.tokensOut, 3);
  assert.equal(summary.status, "finished");
  assert.equal(summary.lastSeq, 4);
});
