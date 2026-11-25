import test from "node:test";
import assert from "node:assert/strict";
import { getRunStreamBadge, isTerminalRunEvent, shouldResetStreamCursor, clearSseCursor, readSseCursor, writeSseCursor, type RunStreamItem } from "./useRunStream.js";

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
