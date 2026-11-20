/**
 * QuestionStore tests (lib/harness/questions.ts).
 *
 * A pending question must survive a page reload (persisted to disk), resolve
 * exactly once, expire when unanswered, and be cancelable when its run ends.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QuestionStore } from "./questions";

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-questions-")), "questions.json");
}

test("questions: create is pending, listed newest first, and scoped by user/run", () => {
  let now = 1_000;
  const store = new QuestionStore({ persist: false, ttlMs: 60_000, now: () => (now += 1) });
  const older = store.create({ id: "q_old", runId: "run_a", userId: "u1", question: "Old?" });
  const newer = store.create({ id: "q_new", runId: "run_a", userId: "u1", question: "New?", options: ["yes"] });
  const other = store.create({ id: "q_other", runId: "run_b", userId: "u2", question: "Other?" });

  assert.equal(older.status, "pending");
  assert.deepEqual(store.listPending().map((q) => q.id), ["q_other", "q_new", "q_old"]);
  assert.deepEqual(store.listPending({ userId: "u1" }).map((q) => q.id), ["q_new", "q_old"]);
  assert.deepEqual(store.listPending({ userId: "u1", runId: "run_a" }).map((q) => q.id), ["q_new", "q_old"]);
  assert.deepEqual(store.listPending({ runId: "run_b" }).map((q) => q.id), ["q_other"]);
  assert.ok(newer.createdAt >= older.createdAt);
  assert.equal(other.status, "pending");
  store.clear();
});

test("questions: the first answer wins and resolves the waiter", async () => {
  const store = new QuestionStore({ persist: false, ttlMs: 60_000 });
  const question = store.create({ runId: "run", userId: "u", question: "Go?" });
  const wait = store.waitFor(question.id);
  const answered = store.answer(question.id, "yes");
  assert.equal(answered?.status, "answered");
  assert.equal(answered?.answer, "yes");
  assert.deepEqual(await wait, { status: "answered", answer: "yes" });

  // A second answer must not overwrite the first.
  store.answer(question.id, "no");
  assert.equal(store.get(question.id)?.answer, "yes");
  assert.equal(store.listPending().length, 0);
  store.clear();
});

test("questions: answering a missing or already-resolved question is harmless", async () => {
  const store = new QuestionStore({ persist: false, ttlMs: 60_000 });
  assert.equal(store.answer("q_missing", "x"), undefined);

  const question = store.create({ runId: "run", userId: "u", question: "Go?" });
  store.answer(question.id, "yes");
  const after = store.answer(question.id, "again");
  assert.equal(after?.answer, "yes");
  store.clear();
});

test("questions: cancelPendingForRun resolves waiters as cancelled and leaves other runs", async () => {
  const store = new QuestionStore({ persist: false, ttlMs: 60_000 });
  const a = store.create({ id: "q_a", runId: "run_a", userId: "u", question: "A?" });
  const b = store.create({ id: "q_b", runId: "run_b", userId: "u", question: "B?" });
  const waitA = store.waitFor(a.id);

  store.cancelPendingForRun("run_a");
  assert.deepEqual(await waitA, { status: "cancelled" });
  assert.equal(store.get(a.id)?.status, "cancelled");
  assert.equal(store.get(b.id)?.status, "pending");
  assert.deepEqual(store.listPending().map((q) => q.id), [b.id]);
  store.clear();
});

test("questions: an unanswered question expires and resolves once", async () => {
  const store = new QuestionStore({ persist: false, ttlMs: 10 });
  const question = store.create({ runId: "run", userId: "u", question: "Quick?" });
  // The store's expiry timer is unref'd, so hold the loop open long enough
  // for it to fire before asserting.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const outcome = await store.waitFor(question.id);
  assert.deepEqual(outcome, { status: "expired" });
  assert.equal(store.get(question.id)?.status, "expired");
  assert.equal(store.listPending().length, 0);
  // A late answer must not resurrect it.
  store.answer(question.id, "late");
  assert.equal(store.get(question.id)?.status, "expired");
  store.clear();
});

test("questions: persists across instances so a reload still shows the card", () => {
  const filePath = tempFile();
  const first = new QuestionStore({ filePath, ttlMs: 60_000 });
  const question = first.create({
    id: "q_persist",
    runId: "run_1",
    userId: "alice",
    question: "Keep going?",
    options: ["Yes", "No"],
    allowFreeText: false,
  });
  first.answer(question.id, "Yes");

  const second = new QuestionStore({ filePath, ttlMs: 60_000 });
  const loaded = second.get("q_persist");
  assert.ok(loaded);
  assert.equal(loaded.question, "Keep going?");
  assert.deepEqual(loaded.options, ["Yes", "No"]);
  assert.equal(loaded.allowFreeText, false);
  assert.equal(loaded.status, "answered");
  assert.equal(loaded.answer, "Yes");
  // Answered questions are not pending after a reload.
  assert.equal(second.listPending().length, 0);
  second.clear();
});

test("questions: only pending questions are restored as pending after reload", () => {
  const filePath = tempFile();
  const first = new QuestionStore({ filePath, ttlMs: 60_000 });
  first.create({ id: "q_pending", runId: "run", userId: "bob", question: "Still there?" });
  const second = new QuestionStore({ filePath, ttlMs: 60_000 });
  assert.deepEqual(second.listPending().map((q) => q.id), ["q_pending"]);
  // The reloaded question must still be answerable.
  assert.equal(second.answer("q_pending", "yes")?.status, "answered");
  second.clear();
});

test("questions: a question whose TTL elapsed while the server was down loads expired", () => {
  const filePath = tempFile();
  let now = 1_000_000;
  const first = new QuestionStore({ filePath, ttlMs: 5_000, now: () => now });
  first.create({ id: "q_stale", runId: "run", userId: "u", question: "Old?" });
  now += 10_000;
  const second = new QuestionStore({ filePath, ttlMs: 5_000, now: () => now });
  assert.equal(second.get("q_stale")?.status, "expired");
  assert.equal(second.listPending().length, 0);
  second.clear();
});

test("questions: a corrupt persisted file never crashes the store", () => {
  const filePath = tempFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{not json");
  const store = new QuestionStore({ filePath, ttlMs: 60_000 });
  // Best-effort: it starts empty and still works.
  const question = store.create({ runId: "run", userId: "u", question: "Still works?" });
  assert.equal(store.get(question.id)?.status, "pending");
  store.clear();
});
