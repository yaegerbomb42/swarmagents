import test from "node:test";
import assert from "node:assert/strict";
import { describeFailure, toastReducer } from "./toasts.js";

const t = (id: string, over: Partial<Parameters<typeof toastReducer>[0][number]> = {}) => ({
  id,
  tone: "error" as const,
  message: "provider failed",
  ...over,
});

test("add appends to an empty list", () => {
  const next = toastReducer([], { type: "add", toast: t("1") });
  assert.equal(next.length, 1);
  assert.equal(next[0].id, "1");
});

test("add is immutable: returns a new array and leaves the old untouched", () => {
  const before = [t("1")];
  const next = toastReducer(before, { type: "add", toast: t("2") });
  assert.notEqual(next, before);
  assert.equal(before.length, 1);
  assert.equal(next.length, 2);
});

test("dismiss removes the matching toast", () => {
  const before = [t("1"), t("2"), t("3")];
  const next = toastReducer(before, { type: "dismiss", id: "2" });
  assert.deepEqual(
    next.map((x) => x.id),
    ["1", "3"]
  );
});

test("dismiss with an unknown id leaves the list unchanged", () => {
  const before = [t("1")];
  const next = toastReducer(before, { type: "dismiss", id: "nope" });
  assert.equal(next.length, 1);
  assert.equal(next[0].id, "1");
});

test("dismiss is immutable: does not mutate the original list", () => {
  const before = [t("1"), t("2")];
  toastReducer(before, { type: "dismiss", id: "1" });
  assert.equal(before.length, 2);
});

test("add then dismiss round-trips to empty", () => {
  let state = toastReducer([], { type: "add", toast: t("a") });
  state = toastReducer(state, { type: "add", toast: t("b") });
  state = toastReducer(state, { type: "dismiss", id: "a" });
  state = toastReducer(state, { type: "dismiss", id: "b" });
  assert.equal(state.length, 0);
});

test("dismiss removes every toast with the matching id", () => {
  const before = [t("x"), t("x")];
  const next = toastReducer(before, { type: "dismiss", id: "x" });
  assert.equal(next.length, 0);
});

test("describeFailure maps a fetch network error", () => {
  const f = describeFailure(new Error("Failed to fetch"));
  assert.equal(f.message, "Network error");
  assert.match(f.detail!, /reach the provider/);
});

test("describeFailure maps a 401 to an invalid-key hint", () => {
  const f = describeFailure(new Error("401 Unauthorized"));
  assert.equal(f.message, "Invalid API key");
  assert.match(f.detail!, /API key/);
});

test("describeFailure maps a 403 to an access-denied hint", () => {
  const f = describeFailure(new Error("403 Forbidden"));
  assert.equal(f.message, "Access denied");
});

test("describeFailure maps a 429 to a rate-limit hint", () => {
  const f = describeFailure(new Error("429 Too Many Requests"));
  assert.equal(f.message, "Rate limited");
});

test("describeFailure maps a 402 to a quota hint", () => {
  const f = describeFailure(new Error("402 Payment Required"));
  assert.equal(f.message, "No credit");
});

test("describeFailure maps a 404 model error", () => {
  const f = describeFailure(new Error("Model claude-sonnet not found"));
  assert.equal(f.message, "Model not found");
});

test("describeFailure maps a 5xx server error", () => {
  const f = describeFailure(new Error("500 Internal Server Error"));
  assert.equal(f.message, "Server error");
});

test("describeFailure maps an abort to 'Run stopped'", () => {
  const f = describeFailure(new DOMException("aborted", "AbortError"));
  assert.equal(f.message, "Run stopped");
});

test("describeFailure falls back for unknown thrown values", () => {
  const f = describeFailure(undefined);
  assert.equal(f.message, "Provider error");
  assert.equal(f.detail, "request failed");
});

test("describeFailure truncates very long provider messages", () => {
  const long = "x".repeat(500);
  const f = describeFailure(new Error(long));
  assert.ok((f.detail ?? "").length <= 221);
});
