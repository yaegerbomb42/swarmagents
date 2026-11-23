import test from "node:test";
import assert from "node:assert/strict";
import { describeFailure, MAX_TOASTS, toastReducer } from "./toasts.js";

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

test("describeFailure does not treat a missing file as a missing model", () => {
  const f = describeFailure(new Error("File foo.ts not found"));
  assert.equal(f.message, "Provider error");
  assert.match(f.detail!, /foo\.ts/);
});

test("describeFailure does not treat token counts as HTTP 5xx", () => {
  const f = describeFailure(new Error("exceeded 512 tokens"));
  assert.equal(f.message, "Provider error");
  assert.match(f.detail!, /512 tokens/);
});

test("describeFailure detects AbortError across realms", () => {
  const crossRealm = { name: "AbortError", message: "aborted" };
  const f = describeFailure(crossRealm);
  assert.equal(f.message, "Run stopped");
});

test("describeFailure maps TimeoutError", () => {
  const f = describeFailure({ name: "TimeoutError", message: "timed out" });
  assert.equal(f.message, "Timed out");
});

test("add with an existing id replaces instead of duplicating", () => {
  const before = [t("1", { message: "old" })];
  const next = toastReducer(before, { type: "add", toast: t("1", { message: "new" }) });
  assert.equal(next.length, 1);
  assert.equal(next[0].message, "new");
});

test("add caps the active toast queue", () => {
  let state: ReturnType<typeof toastReducer> = [];
  for (let i = 0; i < MAX_TOASTS + 4; i++) {
    state = toastReducer(state, { type: "add", toast: t(String(i)) });
  }
  assert.equal(state.length, MAX_TOASTS);
  assert.equal(state[0].id, "4");
  assert.equal(state[MAX_TOASTS - 1].id, String(MAX_TOASTS + 3));
});

test("describeFailure scrubs an sk- key from the fallback detail", () => {
  const key = "sk-abcdefghij1234567890xyz";
  const f = describeFailure(new Error(`provider exploded using ${key} please help`));
  assert.equal(f.message, "Provider error");
  assert.ok(!(f.detail ?? "").includes(key), "raw key must not appear in the detail");
  assert.match(f.detail!, /\[REDACTED\]/);
});

test("describeFailure scrubs a Bearer token from the fallback detail", () => {
  const token = "abcdefghij1234567890";
  const f = describeFailure(new Error(`call failed: Authorization: Bearer ${token}`));
  assert.equal(f.message, "Provider error");
  assert.ok(!(f.detail ?? "").includes(token), "raw token must not appear in the detail");
  assert.match(f.detail!, /Bearer \[REDACTED\]/);
});

test("describeFailure scrubs GitHub and Gemini token shapes from the fallback detail", () => {
  const gh = "ghp_abcdefghij1234567890";
  const gemini = `AIzaSy${"A".repeat(33)}`; // AIza + 35 base64url chars
  const f = describeFailure(new Error(`tokens leaked: ${gh} and ${gemini}`));
  assert.equal(f.message, "Provider error");
  assert.ok(!(f.detail ?? "").includes(gh));
  assert.ok(!(f.detail ?? "").includes(gemini));
  assert.match(f.detail!, /\[REDACTED\]/);
});

test("describeFailure scrubs secrets repeatedly without skipping matches", () => {
  const key = "sk-abcdefghij1234567890xyz";
  // Call twice with the same secret: a stateful global-regex scan would skip
  // the match on the second call.
  for (let i = 0; i < 2; i++) {
    const f = describeFailure(new Error(`attempt ${i} using ${key}`));
    assert.ok(!(f.detail ?? "").includes(key));
    assert.match(f.detail!, /\[REDACTED\]/);
  }
});

test("describeFailure leaves a secret-free fallback detail untouched", () => {
  const f = describeFailure(new Error("weird provider glitch, please retry"));
  assert.equal(f.message, "Provider error");
  assert.equal(f.detail, "weird provider glitch, please retry");
});
