/**
 * ask_user questions API tests.
 *
 * GET returns only the caller's pending questions (so a reload can restore
 * the card); POST answers one and resolves the paused run. Questions are
 * scoped to their owner and can only be answered once while pending.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { QuestionStore, setQuestionStoreForTesting } from "../../../../lib/harness/questions";

let clock = 1_000;
const store = new QuestionStore({ persist: false, ttlMs: 60_000, now: () => (clock += 1) });
setQuestionStoreForTesting(store);

after(() => {
  store.clear();
  setQuestionStoreForTesting(null);
});

interface TestInit {
  method?: string;
  body?: string;
}

function request(url: string, init: TestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers();
  if (user !== null) headers.set("x-swarm-user", user);
  if (init.body) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body ? { body: init.body } : {}),
    headers,
  });
}

function question(overrides: Partial<{ id: string; runId: string; userId: string; question: string }> = {}) {
  return store.create({
    id: overrides.id ?? "q_route",
    runId: overrides.runId ?? "run_1",
    userId: overrides.userId ?? "alice",
    question: overrides.question ?? "Which port?",
    options: ["3000", "8080"],
  });
}

test("questions API: unauthenticated requests are rejected", async () => {
  assert.equal((await GET(request("/api/runtime/questions", {}, null))).status, 401);
  assert.equal(
    (await POST(request("/api/runtime/questions", { method: "POST", body: "{}" }, null))).status,
    401,
  );
});

test("questions API: GET lists only the caller's pending questions, newest first", async () => {
  store.clear();
  question({ id: "q_a", runId: "run_1", userId: "alice", question: "First?" });
  question({ id: "q_b", runId: "run_1", userId: "alice", question: "Second?" });
  question({ id: "q_other", runId: "run_2", userId: "bob", question: "Bob's?" });

  const res = await GET(request("/api/runtime/questions?runId=run_1"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { questions: Array<{ id: string; runId: string; question: string; options: string[] }> };
  assert.deepEqual(body.questions.map((q) => q.id), ["q_b", "q_a"]);
  assert.equal(body.questions[0].question, "Second?");
  assert.deepEqual(body.questions[0].options, ["3000", "8080"]);
  // No user ids leak to the client.
  assert.equal(Object.keys(body.questions[0]).includes("userId"), false);
});

test("questions API: GET for another user never returns the question", async () => {
  store.clear();
  question({ id: "q_private", userId: "alice" });
  const res = await GET(request("/api/runtime/questions", {}, "bob"));
  const body = (await res.json()) as { questions: unknown[] };
  assert.deepEqual(body.questions, []);
});

test("questions API: POST answers the question and resumes the waiter", async () => {
  store.clear();
  const q = question({ id: "q_answer" });
  const waiter = store.waitFor(q.id);

  const res = await POST(
    request("/api/runtime/questions", { method: "POST", body: JSON.stringify({ id: q.id, answer: "  8080  " }) }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; status: string };
  assert.equal(body.ok, true);
  assert.equal(body.status, "answered");
  assert.deepEqual(await waiter, { status: "answered", answer: "8080" });
  assert.equal(store.get(q.id)?.answer, "8080");
});

test("questions API: validates the body and bounds the answer", async () => {
  const bad = [
    "{not json",
    JSON.stringify([]),
    JSON.stringify({ answer: "x" }),
    JSON.stringify({ id: "q_x", answer: "   " }),
    JSON.stringify({ id: "q_x", answer: 42 }),
  ];
  for (const body of bad) {
    const res = await POST(request("/api/runtime/questions", { method: "POST", body }));
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx for ${body}, got ${res.status}`);
  }

  store.clear();
  const q = question({ id: "q_long" });
  const res = await POST(
    request("/api/runtime/questions", { method: "POST", body: JSON.stringify({ id: q.id, answer: "x".repeat(4001) }) }),
  );
  assert.equal(res.status, 400);
  assert.equal(store.get(q.id)?.status, "pending");
});

test("questions API: another user cannot answer, and a second answer is a conflict", async () => {
  store.clear();
  const q = question({ id: "q_owned", userId: "alice" });
  const foreign = await POST(
    request("/api/runtime/questions", { method: "POST", body: JSON.stringify({ id: q.id, answer: "x" }) }, "bob"),
  );
  assert.equal(foreign.status, 404);
  assert.equal(store.get(q.id)?.status, "pending");

  const first = await POST(
    request("/api/runtime/questions", { method: "POST", body: JSON.stringify({ id: q.id, answer: "yes" }) }),
  );
  assert.equal(first.status, 200);

  const second = await POST(
    request("/api/runtime/questions", { method: "POST", body: JSON.stringify({ id: q.id, answer: "no" }) }),
  );
  assert.equal(second.status, 409);
  assert.equal(store.get(q.id)?.answer, "yes");
});

test("questions API: the body size cap is enforced", async () => {
  const res = await POST(
    request("/api/runtime/questions", {
      method: "POST",
      body: JSON.stringify({ id: "q_x", answer: "x".repeat(40 * 1024) }),
    }),
  );
  assert.equal(res.status, 413);
});
