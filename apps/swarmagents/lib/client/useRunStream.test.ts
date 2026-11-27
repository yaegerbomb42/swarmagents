import test from "node:test";
import assert from "node:assert/strict";
import {
  backfillTruncatedItems,
  getRunStreamBadge,
  isTerminalRunEvent,
  parseRunLogNdjson,
  shouldResetStreamCursor,
  snapshotTruncation,
  clearSseCursor,
  readSseCursor,
  writeSseCursor,
  type RunStreamItem,
} from "./useRunStream.js";

function item(kind: string): RunStreamItem {
  return { seq: 1, kind, data: {}, parsed: { data: "{}" }, ts: Date.now() };
}

test("maps connecting state", () => {
  assert.deepEqual(
    getRunStreamBadge({ status: "connecting", items: [], reconnectAttempt: 0 }),
    { label: "connecting", tone: "connecting" },
  );
});

test("maps connected state to live", () => {
  assert.deepEqual(
    getRunStreamBadge({ status: "connected", items: [item("assistant.text")], reconnectAttempt: 0 }),
    { label: "live", tone: "live" },
  );
});

test("maps reconnecting state with attempt number", () => {
  assert.deepEqual(
    getRunStreamBadge({ status: "reconnecting", items: [], reconnectAttempt: 3 }),
    { label: "reconnecting (attempt 3)", tone: "reconnecting" },
  );
  assert.deepEqual(
    getRunStreamBadge({ status: "reconnecting", items: [], reconnectAttempt: 0 }),
    { label: "reconnecting (attempt 1)", tone: "reconnecting" },
  );
});

test("maps terminal run events to ended", () => {
  assert.deepEqual(
    getRunStreamBadge({ status: "connected", items: [item("run.finished")], reconnectAttempt: 0 }),
    { label: "ended", tone: "ended" },
  );
  assert.deepEqual(
    getRunStreamBadge({ status: "reconnecting", items: [item("run.cancelled")], reconnectAttempt: 2 }),
    { label: "ended", tone: "ended" },
  );
});

test("terminal run events end the stream and must not be reconnected", () => {
  for (const kind of ["run.finished", "run.error", "run.cancelled"]) {
    assert.equal(isTerminalRunEvent(kind), true, `${kind} is terminal`);
  }
  for (const kind of ["run.started", "usage", "assistant.text", "approval.required", "run.created"]) {
    assert.equal(isTerminalRunEvent(kind), false, `${kind} is not terminal`);
  }
});

test("maps run.error to error", () => {
  assert.deepEqual(
    getRunStreamBadge({ status: "connected", items: [item("run.error")], reconnectAttempt: 0, error: "boom" }),
    { label: "error", tone: "error" },
  );
});

test("switching runs starts a fresh stream instead of resuming the previous cursor", () => {
  // Same run: a StrictMode remount keeps the cursor and resumes via Last-Event-ID.
  assert.equal(shouldResetStreamCursor("run_a", "run_a"), false);
  assert.equal(shouldResetStreamCursor(undefined, undefined), false);
  // A different run must not inherit the previous run's buffered events or
  // sequence number, or its early events are filtered out as already seen.
  assert.equal(shouldResetStreamCursor("run_a", "run_b"), true);
  assert.equal(shouldResetStreamCursor("run_a", undefined), true);
  assert.equal(shouldResetStreamCursor(undefined, "run_b"), true);
});

test("SSE cursor persists per run in sessionStorage across reloads", () => {
  const store = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>).sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  try {
    assert.equal(readSseCursor("run_a"), undefined);
    writeSseCursor("run_a", "42");
    assert.equal(readSseCursor("run_a"), "42");
    // Another run keeps its own cursor: no cross-run contamination.
    writeSseCursor("run_b", "7");
    assert.equal(readSseCursor("run_a"), "42");
    assert.equal(readSseCursor("run_b"), "7");
    clearSseCursor("run_a");
    assert.equal(readSseCursor("run_a"), undefined);
    assert.equal(readSseCursor("run_b"), "7");
  } finally {
    delete (globalThis as unknown as Record<string, unknown>).sessionStorage;
  }
});

test("SSE cursor helpers tolerate missing or blocked storage", () => {
  delete (globalThis as unknown as Record<string, unknown>).sessionStorage;
  assert.equal(readSseCursor("run_a"), undefined);
  writeSseCursor("run_a", "42"); // must not throw
  clearSseCursor("run_a"); // must not throw
  assert.equal(readSseCursor("run_a"), undefined);
});

test("snapshotTruncation: reads the first event id from a truncated snapshot", () => {
  const snapshot = (data: unknown): RunStreamItem => ({
    seq: 1,
    kind: "run.snapshot",
    data,
    parsed: { data: "{}" },
    ts: Date.now(),
  });
  assert.equal(snapshotTruncation([snapshot({ truncated: true, firstEventId: 1500, lastEventId: 3499 })]), 1500);
  assert.equal(snapshotTruncation([snapshot({ truncated: false, firstEventId: 1 })]), null);
  assert.equal(snapshotTruncation([snapshot({ truncated: true })]), null);
  assert.equal(snapshotTruncation([item("assistant.text")]), null);
  assert.equal(snapshotTruncation([]), null);
});

test("parseRunLogNdjson: parses persisted events, skips bad lines", () => {
  const text = [
    JSON.stringify({ seq: 1, runId: "r", ts: 100, type: "run.created", data: { a: 1 } }),
    "not json",
    JSON.stringify({ seq: 2, runId: "r", ts: 101, type: "assistant.text", data: "hi" }),
    JSON.stringify({ runId: "r", type: "no-seq" }),
    "",
    JSON.stringify({ seq: 3, runId: "r", ts: 102, type: 42, data: null }),
  ].join("\n");
  const items = parseRunLogNdjson(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "run.created");
  assert.equal(items[0].seq, 1);
  assert.deepEqual(items[0].data, { a: 1 });
  assert.equal(items[1].kind, "assistant.text");
  assert.equal(items[1].parsed.id, "2");
});

test("backfillTruncatedItems: prepends the omitted head and drops the snapshot", () => {
  const snapshot: RunStreamItem = {
    seq: 1,
    kind: "run.snapshot",
    data: { truncated: true, firstEventId: 3, lastEventId: 4 },
    parsed: { data: "{}" },
    ts: 1,
  };
  const tail: RunStreamItem[] = [
    { seq: 2, kind: "assistant.text", data: "c", parsed: { data: "{}" }, ts: 3 },
    { seq: 3, kind: "assistant.text", data: "d", parsed: { data: "{}" }, ts: 4 },
  ];
  const logged: RunStreamItem[] = [
    { seq: 1, kind: "run.created", data: {}, parsed: { data: "{}", id: "1" }, ts: 1 },
    { seq: 2, kind: "assistant.text", data: "b", parsed: { data: "{}", id: "2" }, ts: 2 },
    { seq: 3, kind: "assistant.text", data: "c", parsed: { data: "{}", id: "3" }, ts: 3 },
  ];
  const merged = backfillTruncatedItems([snapshot, ...tail], logged);
  assert.ok(merged);
  assert.equal(merged.complete, true);
  assert.deepEqual(
    merged.items.map((item) => item.kind),
    ["run.created", "assistant.text", "assistant.text", "assistant.text"],
  );
  // Backfilled seqs sort before the replayed tail and stay unique.
  const seqs = merged.items.map((item) => item.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

test("backfillTruncatedItems: no-ops without a truncated snapshot or past the cap", () => {
  const tail: RunStreamItem[] = [{ seq: 2, kind: "assistant.text", data: "c", parsed: { data: "{}" }, ts: 3 }];
  assert.equal(backfillTruncatedItems(tail, tail), null);
  const snapshot: RunStreamItem = {
    seq: 1,
    kind: "run.snapshot",
    data: { truncated: true, firstEventId: 2, lastEventId: 2 },
    parsed: { data: "{}" },
    ts: 1,
  };
  const logged: RunStreamItem[] = [
    { seq: 1, kind: "run.created", data: {}, parsed: { data: "{}", id: "1" }, ts: 1 },
  ];
  // A maxItems of 1 cannot hold the backfilled head plus the tail.
  assert.equal(backfillTruncatedItems([snapshot, ...tail], logged, 1), null);
  // Exactly at the cap, it fits and the snapshot is dropped.
  const merged = backfillTruncatedItems([snapshot, ...tail], logged, 2);
  assert.ok(merged);
  assert.equal(merged.items.length, 2);
  assert.ok(!merged.items.some((item) => item.kind === "run.snapshot"));
});
