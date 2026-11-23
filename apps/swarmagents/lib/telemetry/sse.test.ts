/**
 * Replay tests for the SSE stream: after a dropped connection the client
 * reconnects with Last-Event-ID, and the server must resume from that seq —
 * from the in-memory bus buffer when it still holds the events, and from the
 * durable run log when it does not (buffer eviction or a process restart) —
 * without duplicating or skipping anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus, type TelemetryEvent } from "./bus";
import { encodeSse, sseResponse } from "./sse";
import { parseSse } from "../client/sse";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-sse-replay-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Read frames until `untilType` is seen (bounded), then abort the stream. */
async function readUntil(
  stream: ReadableStream<Uint8Array>,
  untilType: string,
  ac: AbortController,
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < 100; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes(`event: ${untilType}\n`)) break;
  }
  ac.abort();
  await reader.read().catch(() => {}); // drain until close
  return parseSse(text).map((m) => (JSON.parse(m.data) as { type: string }).type);
}

/** Read until the server closes the stream (no abort), with a safety bound. */
async function readToEnd(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < 100; i++) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  throw new Error("stream did not close after a terminal event");
}

test("closes the stream after replaying a terminal event", async () => {
  const bus = new TelemetryBus();
  bus.publish("run_done", { type: "run.created", data: { userId: "alice" } });
  bus.publish("run_done", { type: "assistant.text", data: { text: "hi" } });
  bus.publish("run_done", { type: "run.finished", exitCode: 0 } as TelemetryEvent);

  const ac = new AbortController();
  const stream = sseResponse("run_done", 0, ac.signal, { bus, keepAliveMs: 60_000, runsDir: null });
  const text = await readToEnd(stream);
  const types = parseSse(text).map((m) => (JSON.parse(m.data) as { type: string }).type);
  assert.deepEqual(types, ["run.created", "assistant.text", "run.finished"]);
  assert.equal(ac.signal.aborted, false, "the server closed the stream itself");
});

test("closes the stream after a live terminal event", async () => {
  const bus = new TelemetryBus();
  const ac = new AbortController();
  const stream = sseResponse("run_live_done", 0, ac.signal, { bus, keepAliveMs: 60_000, runsDir: null });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  bus.publish("run_live_done", { type: "run.created", data: { userId: "alice" } });
  bus.publish("run_live_done", { type: "run.error", data: { message: "boom" } });

  let text = "";
  for (let i = 0; i < 20; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const types = parseSse(text).map((m) => (JSON.parse(m.data) as { type: string }).type);
  assert.deepEqual(types, ["run.created", "run.error"]);
  assert.equal(ac.signal.aborted, false);
});

test("replays buffered bus events after the last seen id", async () => {
  const bus = new TelemetryBus();
  bus.publish("run_replay", { type: "one" });
  bus.publish("run_replay", { type: "two" });
  bus.publish("run_replay", { type: "three" });

  const ac = new AbortController();
  const stream = sseResponse("run_replay", 1, ac.signal, { bus, keepAliveMs: 60_000, runsDir: null });
  const types = await readUntil(stream, "three", ac);
  assert.deepEqual(types, ["two", "three"]);
});

test("replays from the durable run log when the bus buffer is empty", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // A previous process persisted these; this "fresh" bus holds nothing.
    const oldProcess = new TelemetryBus({ persist: true, runsDir: () => dir });
    oldProcess.publish("run_log", { type: "one" });
    oldProcess.publish("run_log", { type: "two" });
    oldProcess.publish("run_log", { type: "three" });

    const fresh = new TelemetryBus();
    assert.equal(fresh.latestSeq("run_log"), 0);

    const ac = new AbortController();
    const stream = sseResponse("run_log", 1, ac.signal, { bus: fresh, keepAliveMs: 60_000, runsDir: dir });
    const types = await readUntil(stream, "three", ac);
    assert.deepEqual(types, ["two", "three"]);
  } finally {
    cleanup();
  }
});

test("does not duplicate events present in both the log and the bus buffer", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    bus.publish("run_both", { type: "one" });
    bus.publish("run_both", { type: "two" });
    bus.publish("run_both", { type: "three" });

    const ac = new AbortController();
    const stream = sseResponse("run_both", 1, ac.signal, { bus, keepAliveMs: 60_000, runsDir: dir });
    const types = await readUntil(stream, "three", ac);
    assert.deepEqual(types, ["two", "three"]);
  } finally {
    cleanup();
  }
});

test("live events after a log replay are streamed once, in order", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir });
    bus.publish("run_live", { type: "one" });
    bus.publish("run_live", { type: "two" });

    const ac = new AbortController();
    const stream = sseResponse("run_live", 2, ac.signal, { bus, keepAliveMs: 60_000, runsDir: dir });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    bus.publish("run_live", { type: "three" });
    const { value } = await reader.read();
    const types = parseSse(decoder.decode(value)).map((m) => (JSON.parse(m.data) as { type: string }).type);
    assert.deepEqual(types, ["three"]);
    ac.abort();
    await reader.read().catch(() => {});
  } finally {
    cleanup();
  }
});

test("replays across rotated log segments", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const bus = new TelemetryBus({ persist: true, runsDir: () => dir, maxLogBytes: 1024 });
    for (let i = 1; i <= 20; i++) bus.publish("run_rot", { type: `e${i}`, data: "x".repeat(80) });
    // The buffer only holds the last 1000 by default; with 20 events the bus
    // buffer still has everything, so replay must come from every rotated
    // segment plus the active file.
    assert.equal(bus.latestSeq("run_rot"), 20);

    const ac = new AbortController();
    const stream = sseResponse("run_rot", 5, ac.signal, { bus, keepAliveMs: 60_000, runsDir: dir });
    const types = await readUntil(stream, "e20", ac);
    assert.deepEqual(types, Array.from({ length: 15 }, (_, i) => `e${i + 6}`));
  } finally {
    cleanup();
  }
});

/** Publish events to a persisting bus, then evict the run from memory. */
function seedAndEvict(dir: string, runId: string, types: string[]): TelemetryBus {
  const bus = new TelemetryBus({ persist: true, runsDir: () => dir, idleMs: 0 });
  for (const type of types) bus.publish(runId, { type });
  assert.equal(bus.evictIdleRuns(Date.now()), 1, "run should be evicted from the bus");
  // The bounded fast path remembers the last seq after eviction so a reconnect
  // can resume from where the durable log left off instead of restarting at 1.
  assert.equal(bus.latestSeq(runId), types.length, "lastSeq survives eviction");
  return bus;
}

test("initial connect replays an evicted terminal run and closes the stream", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // The reported bug: a queued run is cancelled, the bus evicts it after
    // 60 s idle, and a fresh connect then hung on keep-alives forever.
    const bus = seedAndEvict(dir, "run_evict_done", ["run.created", "run.queued", "run.cancelled"]);

    const ac = new AbortController();
    const stream = sseResponse("run_evict_done", 0, ac.signal, { bus, keepAliveMs: 60_000, runsDir: dir });
    const text = await readToEnd(stream);
    const types = parseSse(text).map((m) => (JSON.parse(m.data) as { type: string }).type);
    assert.deepEqual(types, ["run.created", "run.queued", "run.cancelled"]);
    assert.equal(ac.signal.aborted, false, "the server closed the stream itself");
  } finally {
    cleanup();
  }
});

test("initial connect replays an evicted running run and keeps streaming live events", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const bus = seedAndEvict(dir, "run_evict_live", ["run.created", "run.queued"]);

    const ac = new AbortController();
    const stream = sseResponse("run_evict_live", 0, ac.signal, { bus, keepAliveMs: 60_000, runsDir: dir });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 20; i++) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: run.queued\n")) break;
    }
    bus.publish("run_evict_live", { type: "assistant.text", data: { text: "hi" } });
    for (let i = 0; i < 20; i++) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: assistant.text\n")) break;
    }
    ac.abort();
    await reader.read().catch(() => {});

    const types = parseSse(text).map((m) => (JSON.parse(m.data) as { type: string }).type);
    assert.deepEqual(types, ["run.created", "run.queued", "assistant.text"]);
  } finally {
    cleanup();
  }
});

test("resumes an evicted run from the durable log without duplicates", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const bus = seedAndEvict(dir, "run_evict_resume", ["one", "two", "three"]);

    const ac = new AbortController();
    const stream = sseResponse("run_evict_resume", 1, ac.signal, { bus, keepAliveMs: 60_000, runsDir: dir });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 20; i++) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: three\n")) break;
    }
    bus.publish("run_evict_resume", { type: "four" });
    for (let i = 0; i < 20; i++) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: four\n")) break;
    }
    ac.abort();
    await reader.read().catch(() => {});

    const types = parseSse(text).map((m) => (JSON.parse(m.data) as { type: string }).type);
    assert.deepEqual(types, ["two", "three", "four"]);
  } finally {
    cleanup();
  }
});

test("capped initial replay announces a run.snapshot before the newest tail", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const total = 2100; // 100 older events beyond the 2000-event replay cap
    const writer = new TelemetryBus({ persist: true, runsDir: () => dir });
    for (let i = 1; i <= total; i++) writer.publish("run_capped", { type: `e${i}` });
    const fresh = new TelemetryBus();

    const ac = new AbortController();
    const stream = sseResponse("run_capped", 0, ac.signal, { bus: fresh, keepAliveMs: 60_000, runsDir: dir });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 3000; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: e2100\n")) break;
    }
    ac.abort();
    await reader.read().catch(() => {});

    const frames = parseSse(text);
    const parsed = frames.map((m) => JSON.parse(m.data) as { type: string; data?: unknown });
    assert.equal(parsed[0].type, "run.snapshot");
    assert.deepEqual(parsed[0].data, {
      truncated: true,
      firstEventId: total - 2000 + 1,
      lastEventId: total,
    });
    assert.deepEqual(
      parsed.slice(1).map((e) => e.type),
      Array.from({ length: 2000 }, (_, i) => `e${total - 2000 + 1 + i}`),
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// b14: an abort must never close the stream silently — either the run's
// terminal event is re-sent (if it finished) or an explicit stream.error is
// emitted. These guard against the "SSE stream ended before run.finished"
// empty-close flake seen under full-suite load.
// ---------------------------------------------------------------------------

function parseTypes(events: { type: string }[]): string[] {
  return events.map((e) => e.type);
}

test("b14: abort at setup on a running run emits stream.error, never a silent close", async () => {
  const bus = new TelemetryBus();
  bus.publish("run_abort_setup", { type: "run.created" });

  const ac = new AbortController();
  ac.abort(); // signal is already aborted when the stream starts
  const stream = sseResponse("run_abort_setup", 0, ac.signal, { bus, keepAliveMs: 60_000, runsDir: null });
  const text = await readToEnd(stream);
  const types = parseTypes(parseSse(text).map((m) => JSON.parse(m.data) as { type: string }));
  assert.ok(types.includes("stream.error"), `expected stream.error, got ${JSON.stringify(types)}`);
});

test("b14: abort mid-stream is a client disconnect — closes quietly, no stream.error", async () => {
  const bus = new TelemetryBus();
  const ac = new AbortController();
  const stream = sseResponse("run_abort_live", 0, ac.signal, { bus, keepAliveMs: 60_000, runsDir: null });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  bus.publish("run_abort_live", { type: "run.created" });

  await reader.read(); // the client receives data first, then disconnects
  ac.abort();

  let text = "";
  for (let i = 0; i < 20; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const types = parseTypes(parseSse(text).map((m) => JSON.parse(m.data) as { type: string }));
  assert.ok(!types.includes("stream.error"), `no stream.error on a real disconnect, got ${JSON.stringify(types)}`);
  assert.equal(bus.subscriberCount("run_abort_live"), 0, "disconnect releases the subscription");
});

test("b14: abort at setup on a finished run replays the terminal event cleanly", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const bus = seedAndEvict(dir, "run_abort_done", ["run.created", "run.finished"]);

    const ac = new AbortController();
    ac.abort();
    const stream = sseResponse("run_abort_done", 0, ac.signal, { bus, keepAliveMs: 60_000, runsDir: dir });
    const text = await readToEnd(stream);
    const types = parseTypes(parseSse(text).map((m) => JSON.parse(m.data) as { type: string }));
    assert.equal(types[types.length - 1], "run.finished", `expected clean terminal close, got ${JSON.stringify(types)}`);
    assert.ok(!types.includes("stream.error"), `no stream.error expected after terminal replay, got ${JSON.stringify(types)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SSE hygiene: no 0 ms keep-alive timer, no synthetic Last-Event-ID clobbering,
// no abort-listener retention, and no dropped legacy duplicate-seq events.
// ---------------------------------------------------------------------------

test("keepAliveMs: 0 does not create a keep-alive timer", async () => {
  const bus = new TelemetryBus();
  bus.publish("run_no_keepalive", { type: "run.finished", exitCode: 0 } as TelemetryEvent);
  const original = globalThis.setInterval;
  let created = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    created++;
    return original(...args);
  }) as typeof setInterval;
  let stream: ReadableStream<Uint8Array> | undefined;
  try {
    const ac = new AbortController();
    stream = sseResponse("run_no_keepalive", 0, ac.signal, { bus, keepAliveMs: 0, runsDir: null });
  } finally {
    globalThis.setInterval = original;
  }
  assert.ok(stream);
  const text = await readToEnd(stream);
  assert.equal(created, 0, "no timer should be created when keepAliveMs is 0");
  assert.ok(!text.includes("keep-alive"), `unexpected keep-alive frames: ${text}`);
});

test("encodeSse omits the id line on synthetic frames", () => {
  const error = encodeSse({ seq: -1, runId: "r", ts: 1, type: "stream.error", data: { message: "x" } });
  assert.ok(error.includes("event: stream.error"));
  assert.ok(!/^id:/m.test(error), `stream.error must not set Last-Event-ID: ${error}`);
  const snapshot = encodeSse({ seq: 0, runId: "r", ts: 1, type: "run.snapshot", data: {} });
  assert.ok(snapshot.includes("event: run.snapshot"));
  assert.ok(!/^id:/m.test(snapshot), `run.snapshot must not set Last-Event-ID: ${snapshot}`);
  const real = encodeSse({ seq: 7, runId: "r", ts: 1, type: "one", data: {} });
  assert.ok(real.startsWith("id: 7\n"), `real events must keep their id: ${real}`);
});

/** Minimal AbortSignal stand-in that records listener attach/detach calls. */
class CountingSignal {
  aborted = false;
  added = 0;
  removed = 0;
  private readonly listeners = new Set<() => void>();

  addEventListener(type: string, fn: () => void): void {
    if (type === "abort") {
      this.added++;
      this.listeners.add(fn);
    }
  }
  removeEventListener(type: string, fn: () => void): void {
    if (type === "abort") {
      this.removed++;
      this.listeners.delete(fn);
    }
  }
  fire(): void {
    this.aborted = true;
    for (const fn of [...this.listeners]) fn();
  }
}

test("abort listeners are detached when the stream closes", async () => {
  const bus = new TelemetryBus();
  bus.publish("run_detach_terminal", { type: "run.finished", exitCode: 0 } as TelemetryEvent);
  const signal = new CountingSignal();
  const stream = sseResponse("run_detach_terminal", 0, signal as unknown as AbortSignal, {
    bus,
    keepAliveMs: 60_000,
    runsDir: null,
  });
  await readToEnd(stream);
  assert.equal(signal.added, 1);
  assert.equal(signal.removed, 1, "terminal close must detach the abort listener");
});

test("abort listeners are detached on a mid-stream abort", async () => {
  const bus = new TelemetryBus();
  const signal = new CountingSignal();
  const stream = sseResponse("run_detach_abort", 0, signal as unknown as AbortSignal, {
    bus,
    keepAliveMs: 60_000,
    runsDir: null,
  });
  const reader = stream.getReader();
  bus.publish("run_detach_abort", { type: "run.created" });
  await reader.read(); // client receives data before disconnecting
  signal.fire();
  for (let i = 0; i < 10; i++) {
    const { done } = await reader.read();
    if (done) break;
  }
  assert.equal(signal.added, 1);
  assert.equal(signal.removed, 1, "abort close must detach the abort listener");
  assert.equal(bus.subscriberCount("run_detach_abort"), 0);
});

test("legacy log events sharing a seq number are all replayed", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const runId = "run_dup_seq";
    const lines = [
      { seq: 1, runId, ts: 1000, type: "first", data: {} },
      { seq: 1, runId, ts: 2000, type: "second", data: {} },
      { seq: 2, runId, ts: 3000, type: "third", data: {} },
    ];
    fs.writeFileSync(path.join(dir, `${runId}.jsonl`), `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const ac = new AbortController();
    const stream = sseResponse(runId, 0, ac.signal, { bus: new TelemetryBus(), keepAliveMs: 60_000, runsDir: dir });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 100; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: third\n")) break;
    }
    ac.abort();
    await reader.read().catch(() => {});

    const types = parseSse(text).map((m) => (JSON.parse(m.data) as { type: string }).type);
    assert.deepEqual(types, ["first", "second", "third"], "duplicate seq events must not be dropped");
  } finally {
    cleanup();
  }
  })
test("encodeSse sanitizes CRLF in event type and seq to prevent SSE injection", () => {
  const dirtyEvent = {
    seq: ("1\nevent: injected\ndata: fake" as unknown) as number,
    runId: "run_inject",
    ts: Date.now(),
    type: "normal\r\nevent: malicious\r\ndata: pwned",
    data: { hello: "world" },
  };
  const encoded = encodeSse(dirtyEvent);
  assert.ok(!encoded.includes("\nevent: injected\n"), "must not contain injected event via seq");
  assert.ok(!encoded.includes("\nevent: malicious\n"), "must not contain injected event via type");
  // The dirty seq is not a positive number, so the synthetic-frame rule also
  // applies: no id line at all, therefore no injected Last-Event-ID is possible.
  assert.ok(!/^id:/m.test(encoded), `a non-numeric seq must not produce an id line: ${encoded}`);
});


test("run.paused does not close the SSE stream as terminal", async () => {
  const bus = new TelemetryBus();
  const ac = new AbortController();
  const stream = sseResponse("run_paused_stream", 0, ac.signal, { bus, keepAliveMs: 60_000, runsDir: null });
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  bus.publish("run_paused_stream", { type: "run.created", data: { userId: "alice" } });
  bus.publish("run_paused_stream", { type: "run.paused", data: { reason: "budget" } });
  bus.publish("run_paused_stream", { type: "run.resumed", data: {} });

  let text = "";
  for (let i = 0; i < 20; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes("event: run.resumed\n")) break;
  }
  const types = parseSse(text).map((m) => (JSON.parse(m.data) as { type: string }).type);
  assert.deepEqual(types, ["run.created", "run.paused", "run.resumed"]);
  assert.equal(ac.signal.aborted, false, "stream remained open across run.paused and received run.resumed");
  ac.abort();
  await reader.cancel().catch(() => {});
});
