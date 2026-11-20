import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus, type SequencedEvent, type TelemetryEvent } from "./bus";
import { readRunEvents } from "./run-log";
import { encodeSse, sseResponse } from "./sse";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("assigns monotonically increasing seq per run", () => {
  const bus = new TelemetryBus();
  const a = bus.publish("run-1", { type: "start" } satisfies TelemetryEvent);
  const b = bus.publish("run-1", { type: "log", data: "hi" });
  const c = bus.publish("run-2", { type: "start" });
  const d = bus.publish("run-1", { type: "done" });

  assert.deepEqual(
    [a.seq, b.seq, d.seq],
    [1, 2, 3],
  );
  assert.equal(c.seq, 1);
  assert.equal(bus.latestSeq("run-1"), 3);
  assert.equal(a.runId, "run-1");
  assert.equal(typeof a.ts, "number");
});

test("replays buffered events after fromSeq, then streams live", () => {
  const bus = new TelemetryBus();
  for (let i = 1; i <= 5; i++) {
    bus.publish("run-1", { type: "log", data: i });
  }

  const received: SequencedEvent[] = [];
  const unsubscribe = bus.subscribe("run-1", 3, (e) => received.push(e));
  assert.deepEqual(received.map((e) => e.seq), [4, 5]);

  bus.publish("run-1", { type: "log", data: 6 });
  assert.deepEqual(received.map((e) => e.seq), [4, 5, 6]);

  unsubscribe();
  bus.publish("run-1", { type: "log", data: 7 });
  assert.equal(received.length, 3);
  assert.equal(bus.subscriberCount("run-1"), 0);
});

test("subscribe with fromSeq 0 on fresh run streams only live events", () => {
  const bus = new TelemetryBus();
  const received: SequencedEvent[] = [];
  bus.subscribe("run-x", 0, (e) => received.push(e));
  bus.publish("run-x", { type: "start" });
  assert.deepEqual(received.map((e) => e.seq), [1]);
});

test("ring buffer keeps only the last capacity events for replay", () => {
  const bus = new TelemetryBus({ capacity: 3 });
  for (let i = 1; i <= 5; i++) {
    bus.publish("run-1", { type: "log", data: i });
  }

  const received: SequencedEvent[] = [];
  const unsubscribe = bus.subscribe("run-1", 0, (e) => received.push(e));
  assert.deepEqual(received.map((e) => e.seq), [3, 4, 5]);
  unsubscribe();
});

test("evicts idle runs with no subscribers, keeps lastSeq and continues seq", () => {
  const bus = new TelemetryBus({ idleMs: 10 });
  bus.publish("run-1", { type: "start" });
  bus.publish("run-1", { type: "log", data: 2 });
  bus.publish("run-1", { type: "log", data: 3 });
  bus.publish("run-2", { type: "start" });

  const evicted = bus.evictIdleRuns(Date.now() + 50);
  assert.equal(evicted, 2);
  // The bounded fast path survives eviction so a reconnect knows where to resume.
  assert.equal(bus.latestSeq("run-1"), 3);

  const four = bus.publish("run-1", { type: "log", data: 4 });
  const five = bus.publish("run-1", { type: "log", data: 5 });
  assert.equal(four.seq, 4);
  assert.equal(five.seq, 5);
});

test("seq stays strictly increasing across idle eviction", () => {
  const bus = new TelemetryBus({ idleMs: 10 });
  const seqs: number[] = [];
  for (let i = 1; i <= 3; i++) {
    seqs.push(bus.publish("run-1", { type: "log", data: i }).seq);
  }
  assert.equal(bus.evictIdleRuns(Date.now() + 100), 1);
  for (let i = 4; i <= 5; i++) {
    seqs.push(bus.publish("run-1", { type: "log", data: i }).seq);
  }
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
});

test("reconnect with fromSeq after eviction delivers only new events", () => {
  const bus = new TelemetryBus({ idleMs: 10 });
  for (let i = 1; i <= 3; i++) {
    bus.publish("run-1", { type: "log", data: i });
  }
  bus.evictIdleRuns(Date.now() + 100);
  bus.publish("run-1", { type: "log", data: 4 });

  const received: SequencedEvent[] = [];
  const unsubscribe = bus.subscribe("run-1", 3, (e) => received.push(e));
  assert.deepEqual(received.map((e) => e.seq), [4]);

  bus.publish("run-1", { type: "log", data: 5 });
  assert.deepEqual(received.map((e) => e.seq), [4, 5]);
  unsubscribe();
});

test("durable log has no duplicate seqs across eviction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b7-bus-"));
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir, idleMs: 10 });
    for (let i = 1; i <= 3; i++) {
      bus.publish("run-1", { type: "log", data: i });
    }
    bus.evictIdleRuns(Date.now() + 100);
    for (let i = 4; i <= 5; i++) {
      bus.publish("run-1", { type: "log", data: i });
    }
    const events = readRunEvents("run-1", dir);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.equal(new Set(events.map((e) => e.seq)).size, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("eviction skips runs with active subscribers", () => {
  const bus = new TelemetryBus({ idleMs: 10 });
  const unsubscribe = bus.subscribe("run-1", 0, () => {});
  bus.publish("run-1", { type: "start" });

  const evicted = bus.evictIdleRuns(Date.now() + 60_000);
  assert.equal(evicted, 0);
  assert.equal(bus.latestSeq("run-1"), 1);
  unsubscribe();
});

test("encodeSse frames event as id/event/data", () => {
  const event: SequencedEvent = { seq: 7, runId: "run-1", type: "log", data: { msg: "hi\nthere" }, ts: 123 };
  const frame = encodeSse(event);
  const lines = frame.split("\n");
  assert.equal(lines[0], "id: 7");
  assert.equal(lines[1], "event: log");
  assert.equal(lines[2], `data: ${JSON.stringify(event)}`);
  assert.equal(lines[3], "");
  assert.equal(lines[4], "");
  assert.ok(!frame.includes("\n\n\n"));
});

test("sseResponse streams replay, live events and keep-alives, then closes on abort", async () => {
  const bus = new TelemetryBus();
  bus.publish("run-1", { type: "start", data: 0 });

  const ac = new AbortController();
  const stream = sseResponse("run-1", 0, ac.signal, { bus, keepAliveMs: 25 });
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const chunks: string[] = [];
  const done = (async () => {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  })();

  bus.publish("run-1", { type: "log", data: 1 });
  await sleep(120);
  ac.abort();
  await done;

  const text = chunks.join("");
  assert.ok(text.includes("id: 1\n"));
  assert.ok(text.includes("id: 2\n"));
  assert.ok(text.includes(": keep-alive\n\n"));
  assert.ok(text.includes('"type":"start"'));
  assert.ok(text.includes('"type":"log"'));

  const tail = text.slice(text.indexOf("id: 2"));
  assert.ok(tail.includes(": keep-alive"));
});

test("sseResponse unsubscribes on abort", async () => {
  const bus = new TelemetryBus();
  const ac = new AbortController();
  const stream = sseResponse("run-1", 0, ac.signal, { bus, keepAliveMs: 25 });
  const reader = stream.getReader();
  bus.publish("run-1", { type: "log", data: 1 });
  await reader.read();
  assert.equal(bus.subscriberCount("run-1"), 1);
  ac.abort();
  const { done } = await reader.read();
  assert.equal(done, true);
  assert.equal(bus.subscriberCount("run-1"), 0);
});

test("sseResponse honors fromSeq=Last-Event-ID for reconnect replay", async () => {
  const bus = new TelemetryBus();
  for (let i = 1; i <= 4; i++) {
    bus.publish("run-1", { type: "log", data: i });
  }

  const ac = new AbortController();
  const stream = sseResponse("run-1", 3, ac.signal, { bus, keepAliveMs: 60_000 });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const { value } = await reader.read();
  const text = decoder.decode(value);
  assert.ok(text.includes("id: 4\n"));
  assert.ok(!text.includes("id: 3\n"));
  ac.abort();
  await reader.read();
});
