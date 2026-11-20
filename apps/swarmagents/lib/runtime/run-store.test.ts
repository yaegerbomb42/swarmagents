import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus, type SequencedEvent, type TelemetryEvent } from "../telemetry/bus";
import { readRunEvents } from "../telemetry/run-log";
import { assembleReport, writeRunReport } from "./run-report";
import { getRun, listRuns, listThreads, summarizeRun, threadTitle } from "./run-store";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-run-store-"));
}

function persistBus(dir: string, maxLogBytes = 5 * 1024 * 1024): TelemetryBus {
  return new TelemetryBus({ persist: true, runsDir: () => dir, maxLogBytes });
}

test("persists events to JSONL and replays them (survives a restart)", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_A", { type: "run.created", data: { prompt: "build it", sessionId: "s1", userId: "alice" } });
    bus.publish("run_A", { type: "run.started", sessionId: "s1", model: "claude-test" } as TelemetryEvent);
    bus.publish("run_A", { type: "assistant.text", text: "working on it" } as TelemetryEvent);
    bus.publish("run_A", { type: "assistant.text", text: "all done" } as TelemetryEvent);
    bus.publish("run_A", {
      type: "run.finished",
      exitCode: 0,
      sessionId: "s1",
      costUsd: 0.25,
      durationMs: 10,
      numTurns: 2,
    } as TelemetryEvent);

    assert.ok(fs.existsSync(path.join(dir, "run_A.jsonl")));

    // A fresh bus/process reads history from disk rather than memory.
    const replayed = getRun("run_A", dir);
    assert.ok(replayed);
    assert.deepEqual(replayed.events.map((e) => e.type), [
      "run.created",
      "run.started",
      "assistant.text",
      "assistant.text",
      "run.finished",
    ]);
    assert.deepEqual(replayed.events.map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.equal(replayed.summary.status, "finished");
    assert.equal(replayed.summary.finalText, "all done");
    assert.equal(replayed.summary.costUsd, 0.25);
    assert.equal(replayed.summary.prompt, "build it");
    assert.equal(replayed.summary.userId, "alice");
    assert.equal(replayed.summary.sessionId, "s1");
    assert.equal(replayed.summary.durationMs, 10);
    assert.equal(replayed.summary.numTurns, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeRun folds usage token deltas into the summary", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_tok", { type: "run.created", data: { prompt: "count tokens", userId: "alice" } });
    bus.publish("run_tok", { type: "usage", inputTokens: 100, outputTokens: 50, cachedTokens: 10 } as TelemetryEvent);
    bus.publish("run_tok", { type: "usage", inputTokens: 25, outputTokens: 75, cachedTokens: 0 } as TelemetryEvent);
    bus.publish("run_tok", { type: "run.finished", exitCode: 0, costUsd: 0.01 } as TelemetryEvent);

    const replayed = getRun("run_tok", dir);
    assert.ok(replayed);
    assert.equal(replayed.summary.tokensIn, 125);
    assert.equal(replayed.summary.tokensOut, 125);
    assert.equal(replayed.summary.tokensCached, 10);
    assert.equal(replayed.summary.tokensReported, true);
    assert.equal(replayed.summary.costUsd, 0.01);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lists recent runs with status and cost, newest first, filtered by user", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_old", { type: "run.created", data: { prompt: "old", userId: "alice" } });
    bus.publish("run_old", { type: "run.finished", exitCode: 0, sessionId: "s1", costUsd: 0.5 } as TelemetryEvent);
    bus.publish("run_new", { type: "run.created", data: { prompt: "new", userId: "alice" } });
    bus.publish("run_new", { type: "run.error", message: "boom", exitCode: 1 } as TelemetryEvent);
    bus.publish("run_bob", { type: "run.created", data: { prompt: "bob", userId: "bob" } });

    const all = listRuns({ runsDir: dir });
    assert.equal(all.length, 3);
    const alice = listRuns({ runsDir: dir, userId: "alice" });
    assert.deepEqual(alice.map((r) => r.runId).sort(), ["run_new", "run_old"]);
    const old = alice.find((r) => r.runId === "run_old");
    const next = alice.find((r) => r.runId === "run_new");
    assert.equal(old?.status, "finished");
    assert.equal(old?.costUsd, 0.5);
    // No usage events in run_old's log: tokens are not reported.
    assert.equal(old?.tokensReported, false);
    assert.equal(next?.status, "error");
    assert.equal(next?.error, "boom");

    assert.equal(listRuns({ runsDir: dir, limit: 1 }).length, 1);
    assert.equal(listRuns({ runsDir: dir, since: Date.now() + 60_000 }).length, 0);
    assert.equal(listRuns({ runsDir: null }).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rotates the run log at maxLogBytes without losing events", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir, 1200);
    for (let i = 0; i < 30; i++) {
      bus.publish("run_rot", { type: "log", data: `event number ${i} with padding to force rotation` });
    }

    const files = fs.readdirSync(dir).filter((name) => name.startsWith("run_rot.jsonl"));
    assert.ok(files.some((name) => /^run_rot\.jsonl\.\d+$/.test(name)), "expected a rotated segment");
    for (const name of files) {
      assert.ok(fs.statSync(path.join(dir, name)).size <= 1600, `${name} should stay near the threshold`);
    }

    const events = readRunEvents("run_rot", dir);
    assert.equal(events.length, 30);
    assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 30 }, (_, i) => i + 1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeRun marks cancellation and ignores unknown run ids", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_cancel", { type: "run.created", data: { prompt: "stop me", userId: "alice" } });
    bus.publish("run_cancel", { type: "run.cancelled", reason: "superseded" } as TelemetryEvent);

    const run = getRun("run_cancel", dir);
    assert.equal(run?.summary.status, "cancelled");
    assert.equal(run?.summary.cancelledReason, "superseded");

    bus.publish("../escape", { type: "log" });
    assert.equal(fs.existsSync(path.join(dir, "..escape.jsonl")), false);
    assert.equal(getRun("../escape", dir), null);

    assert.deepEqual(summarizeRun("run_X", []).status, "running");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeRun reports queued runs as queued until run.started, and carries provider/model from any event", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_q", { type: "run.created", data: { prompt: "queued work", userId: "alice", model: "clarke-1.0" } });
    bus.publish("run_q", { type: "run.queued", data: { position: 1, userId: "alice" } });

    // Queued, not running — and the model requested at creation is already known.
    let run = getRun("run_q", dir);
    assert.equal(run?.summary.status, "queued");
    assert.equal(run?.summary.model, "clarke-1.0");

    // run.started names the provider but no model: status flips to running,
    // the provider lands, and the requested model survives.
    bus.publish("run_q", { type: "run.started", sessionId: "s1", provider: "radium" } as TelemetryEvent);
    run = getRun("run_q", dir);
    assert.equal(run?.summary.status, "running");
    assert.equal(run?.summary.provider, "radium");
    assert.equal(run?.summary.model, "clarke-1.0");

    // A later llm event fills a model gap: a run whose run.started carried
    // no model at all still reports the model from its usage events.
    bus.publish("run_m", { type: "run.created", data: { prompt: "gap", userId: "alice" } });
    bus.publish("run_m", { type: "run.started", sessionId: "s2", provider: "mercury" } as TelemetryEvent);
    bus.publish("run_m", { type: "usage", inputTokens: 10, outputTokens: 5, model: "clarke-1.0" } as TelemetryEvent);
    const gap = getRun("run_m", dir);
    assert.equal(gap?.summary.status, "running");
    assert.equal(gap?.summary.provider, "mercury");
    assert.equal(gap?.summary.model, "clarke-1.0");

    // Failover carries the next attempt's provider/model; finishing keeps them.
    bus.publish("run_q", { type: "run.failover", data: { provider: "groq", model: "llama", message: "429" } } as TelemetryEvent);
    bus.publish("run_q", { type: "run.finished", exitCode: 0, sessionId: "s1", costUsd: 0.01 } as TelemetryEvent);
    run = getRun("run_q", dir);
    assert.equal(run?.summary.status, "finished");
    assert.equal(run?.summary.provider, "groq");
    assert.equal(run?.summary.model, "llama");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a minimal run-created log with an explicit createdAt timestamp. */
function writeRunLog(dir: string, runId: string, createdAt: number, userId = "alice"): void {
  const line = JSON.stringify({
    type: "run.created",
    seq: 1,
    runId,
    ts: createdAt,
    data: { prompt: `p:${runId}`, userId },
  });
  fs.writeFileSync(path.join(dir, `${runId}.jsonl`), `${line}\n`);
}

test("listRuns supports a numeric before cursor (strictly older)", () => {
  const dir = tmpDir();
  try {
    writeRunLog(dir, "r1", 1000);
    writeRunLog(dir, "r2", 2000);
    writeRunLog(dir, "r3", 3000);
    assert.deepEqual(listRuns({ runsDir: dir, before: 2500 }).map((r) => r.runId), ["r2", "r1"]);
    assert.equal(listRuns({ runsDir: dir, before: 1000 }).length, 0);
    assert.equal(listRuns({ runsDir: dir, before: 4000 }).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns supports a runId before cursor and keeps a stable total order on ties", () => {
  const dir = tmpDir();
  try {
    writeRunLog(dir, "r1", 1000);
    writeRunLog(dir, "r2", 2000);
    writeRunLog(dir, "r3", 3000);
    assert.deepEqual(listRuns({ runsDir: dir, before: "r2" }).map((r) => r.runId), ["r1"]);
    assert.deepEqual(listRuns({ runsDir: dir, before: "r3" }).map((r) => r.runId), ["r2", "r1"]);
    // Two runs share a creation time; runId desc breaks the tie.
    writeRunLog(dir, "run_z", 5000);
    writeRunLog(dir, "run_a", 5000);
    assert.deepEqual(
      listRuns({ runsDir: dir }).map((r) => r.runId),
      ["run_z", "run_a", "r3", "r2", "r1"],
    );
    // Cursor at the shared boundary: strictly before (5000, "run_a") → run_z excluded.
    assert.deepEqual(
      listRuns({ runsDir: dir, before: "run_a" }).map((r) => r.runId),
      ["r3", "r2", "r1"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns filters by sessionId, and a runId selects a sessionless run", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_A", { type: "run.created", data: { prompt: "a", sessionId: "s1", userId: "alice" } });
    bus.publish("run_A", { type: "run.started", sessionId: "s1" } as TelemetryEvent);
    bus.publish("run_B", { type: "run.created", data: { prompt: "b", sessionId: "s2", userId: "alice" } });
    bus.publish("run_B", { type: "run.started", sessionId: "s2" } as TelemetryEvent);
    bus.publish("run_C", { type: "run.created", data: { prompt: "c", userId: "alice" } });

    assert.deepEqual(listRuns({ userId: "alice", sessionId: "s1", runsDir: dir }).map((r) => r.runId), ["run_A"]);
    assert.deepEqual(listRuns({ userId: "alice", sessionId: "s2", runsDir: dir }).map((r) => r.runId), ["run_B"]);
    // A sessionless run is addressable by its own runId.
    assert.deepEqual(listRuns({ userId: "alice", sessionId: "run_C", runsDir: dir }).map((r) => r.runId), ["run_C"]);
    assert.deepEqual(listRuns({ userId: "alice", sessionId: "nope", runsDir: dir }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns attaches the report meta when a report exists", () => {
  const dir = tmpDir();
  try {
    writeRunLog(dir, "run_rep", 1000);
    const report = assembleReport({
      runId: "run_rep",
      userId: "alice",
      events: [
        { type: "run.created", data: { prompt: "p", userId: "alice" }, seq: 1, runId: "run_rep", ts: 1000 },
        { type: "run.finished", exitCode: 0, sessionId: "s1", seq: 2, runId: "run_rep", ts: 2000 } as SequencedEvent,
      ],
      createdAt: 1000,
      finishedAt: 2000,
      artifacts: [],
      shots: [],
    });
    writeRunReport("run_rep", report, dir);

    const runs = listRuns({ runsDir: dir });
    const entry = runs.find((r) => r.runId === "run_rep");
    assert.ok(entry?.report);
    assert.equal(entry?.report?.steps, report.steps.length);
    assert.equal(entry?.report?.status, "finished");
    // Runs without a report simply lack the meta.
    const plain = runs.find((r) => r.runId === "r1");
    assert.equal(plain?.report, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeRun marks terminal execs as shell kind, agent runs as agent", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_shell", { type: "run.created", data: { prompt: "ls /workspace", userId: "alice", kind: "shell" } });
    bus.publish("run_shell", { type: "run.finished", exitCode: 0 } as TelemetryEvent);
    bus.publish("run_agent", { type: "run.created", data: { prompt: "build it", userId: "alice" } });
    bus.publish("run_agent", { type: "run.finished", exitCode: 0 } as TelemetryEvent);

    const shell = getRun("run_shell", dir);
    assert.ok(shell);
    assert.equal(shell.summary.kind, "shell");
    assert.equal(shell.summary.prompt, "ls /workspace");

    const agent = getRun("run_agent", dir);
    assert.ok(agent);
    assert.equal(agent.summary.kind, "agent");

    // The durable kind survives a restart the same way the prompt does.
    const listed = listRuns({ runsDir: dir, userId: "alice" });
    assert.equal(listed.find((r) => r.runId === "run_shell")?.kind, "shell");
    assert.equal(listed.find((r) => r.runId === "run_agent")?.kind, "agent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listThreads groups runs by session with title, time and run count", () => {
  const dir = tmpDir();
  try {
    const bus = persistBus(dir);
    bus.publish("run_A", { type: "run.created", data: { prompt: "  build   the thing ", sessionId: "s1", userId: "alice" } });
    bus.publish("run_A", { type: "run.started", sessionId: "s1" } as TelemetryEvent);
    bus.publish("run_B", { type: "run.created", data: { prompt: "follow up", sessionId: "s1", userId: "alice" } });
    bus.publish("run_B", { type: "run.started", sessionId: "s1" } as TelemetryEvent);
    bus.publish("run_C", { type: "run.created", data: { prompt: "other thread", sessionId: "s2", userId: "alice" } });
    bus.publish("run_C", { type: "run.started", sessionId: "s2" } as TelemetryEvent);
    bus.publish("run_D", { type: "run.created", data: { prompt: "", userId: "alice" } });
    bus.publish("run_E", { type: "run.created", data: { prompt: "bob", sessionId: "s9", userId: "bob" } });

    const threads = listThreads({ userId: "alice", runsDir: dir });
    assert.equal(threads.length, 3);
    const byId = new Map(threads.map((t) => [t.id, t]));
    assert.equal(byId.get("s1")?.runCount, 2);
    assert.equal(byId.get("s1")?.title, "build the thing");
    assert.equal(byId.get("s2")?.runCount, 1);
    assert.equal(byId.get("s2")?.title, "other thread");
    // Sessionless run: own thread, untitled prompt falls back.
    assert.equal(byId.get("run_D")?.runCount, 1);
    assert.equal(byId.get("run_D")?.title, "Untitled thread");
    assert.ok(!byId.has("s9"));
    // Newest activity first (non-increasing updatedAt).
    for (let i = 1; i < threads.length; i++) {
      assert.ok(threads[i - 1].updatedAt >= threads[i].updatedAt);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("threadTitle truncates long prompts and falls back for empty ones", () => {
  assert.equal(threadTitle(""), "Untitled thread");
  assert.equal(threadTitle("   "), "Untitled thread");
  assert.equal(threadTitle("short"), "short");
  const long = "x".repeat(100);
  assert.equal(threadTitle(long).length, 60);
  assert.ok(threadTitle(long).endsWith("…"));
});
