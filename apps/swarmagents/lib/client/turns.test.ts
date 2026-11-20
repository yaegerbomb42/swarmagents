import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationEntry } from "./conversation";
import {
  buildTurnBlocks,
  closeOpenPrompts,
  countWaitingOnUser,
  currentActivity,
  formatStepDuration,
  summarizeSteps,
  titleFromPrompt,
  withOpenPrompts,
  type StepEntry,
} from "./turns";

const user = (ts: number, text: string): ConversationEntry => ({ kind: "user", key: `user:${ts}`, ts, text, attachments: [] });
const agent = (ts: number, text: string): ConversationEntry => ({ kind: "agent", key: `agent:${ts}`, ts, text });
const tool = (ts: number, label: string, status: "running" | "done" | "error" = "done"): ConversationEntry => ({
  kind: "tool",
  key: `tool:${ts}`,
  ts,
  id: `call_${ts}`,
  name: "Bash",
  label,
  status,
  input: {},
});
const status = (key: string, ts: number, text: string, tone: "done" | "error" | "info" = "info"): ConversationEntry => ({
  kind: "status",
  key,
  ts,
  text,
  tone,
});
const question = (ts: number, id: string, state: "pending" | "answered" = "pending"): ConversationEntry => ({
  kind: "question",
  key: `question:${id}`,
  ts,
  id,
  question: "Which branch?",
  options: ["main", "dev"],
  allowFreeText: true,
  status: state,
});

test("a turn folds consecutive tool calls into one steps block between the agent's messages", () => {
  const blocks = buildTurnBlocks([
    user(1, "Build it"),
    agent(2, "On it."),
    tool(3, "Reading package.json"),
    tool(4, "Running npm test"),
    status("vm:5", 5, "VM ready"),
    agent(6, "Tests pass."),
    tool(7, "Writing README.md"),
  ]);

  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["agent", "steps", "agent", "steps"],
  );
  const first = blocks[1];
  assert.equal(first.kind === "steps" && first.steps.length, 3);
  const last = blocks[3];
  assert.equal(last.kind === "steps" && last.steps.length, 1);
});

test("the prompt, the outcome and the approval line are not repeated inside the turn", () => {
  const blocks = buildTurnBlocks([
    user(1, "Build it"),
    status("approval:a1", 2, "Waiting for approval · Bash"),
    status("finished:run_1", 3, "Finished", "done"),
    status("error:run_1", 4, "Failed", "error"),
    status("cancelled:run_1", 5, "Stopped"),
  ]);
  assert.deepEqual(blocks, []);
});

test("questions and handoffs break the steps and keep their place", () => {
  const blocks = buildTurnBlocks([tool(1, "Reading"), question(2, "q1"), tool(3, "Writing")]);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["steps", "question", "steps"],
  );
  assert.equal(new Set(blocks.map((block) => block.key)).size, 3, "block keys are unique");
});

test("a collapsed steps block names the running step, else the last one", () => {
  const done = [tool(1, "Reading a.ts"), tool(2, "Writing b.ts")] as StepEntry[];
  assert.deepEqual(summarizeSteps(done), { count: 2, running: false, failed: 0, label: "Writing b.ts" });

  const live = [tool(1, "Running npm test", "running"), status("vm:2", 2, "VM ready")] as StepEntry[];
  assert.deepEqual(summarizeSteps(live), { count: 2, running: true, failed: 0, label: "Running npm test" });

  const failed = [tool(1, "Running npm test", "error"), status("blocked:2", 2, "Blocked rm -rf", "error")] as StepEntry[];
  assert.equal(summarizeSteps(failed).failed, 2);
  assert.deepEqual(summarizeSteps([]), { count: 0, running: false, failed: 0, label: "" });
});

test("the run indicator says what the agent is doing right now", () => {
  assert.equal(currentActivity([]), undefined);
  assert.equal(currentActivity([tool(1, "Running npm test", "running"), agent(2, "Let me check.")]), "Running npm test");
  assert.equal(currentActivity([tool(1, "Reading a.ts")]), "Reading a.ts");
  assert.equal(currentActivity([status("vm:1", 1, "Starting the computer")]), "Starting the computer");
  assert.equal(currentActivity([question(1, "q1")]), "Waiting for your answer");
  assert.equal(currentActivity([tool(1, "Reading a.ts"), agent(2, "Done.")]), undefined, "prose is its own activity");
  assert.equal(currentActivity([status("finished:run_1", 1, "Finished", "done")]), undefined);
});

test("questions the server still holds open are added once and answered in place", () => {
  const open = {
    questions: [{ id: "q1", question: "Which branch?", options: ["main"], allowFreeText: false, createdAt: 5 }],
    handoffs: [{ id: "h1", reason: "login", description: "Sign in to GitHub", createdAt: 7 }],
    answers: {},
    handedBack: {},
  };

  const merged = withOpenPrompts([agent(1, "Hi"), agent(9, "Later")], open);
  assert.deepEqual(
    merged.map((entry) => `${entry.kind}@${entry.ts}`),
    ["agent@1", "question@5", "handoff@7", "agent@9"],
  );
  assert.equal(countWaitingOnUser(merged), 2);

  // Already in the stream: not duplicated.
  const streamed = withOpenPrompts([question(5, "q1")], { ...open, handoffs: [] });
  assert.equal(streamed.filter((entry) => entry.kind === "question").length, 1);

  // Answering here flips the card before the stream confirms it.
  const answered = withOpenPrompts(merged, { ...open, answers: { q1: "main" }, handedBack: { h1: true } });
  assert.equal(countWaitingOnUser(answered), 0);
  const q = answered.find((entry) => entry.kind === "question");
  assert.equal(q?.kind === "question" && q.answer, "main");
});

test("a run that ended leaves nothing waiting on the user", () => {
  const live = withOpenPrompts([agent(1, "One decision first."), question(2, "q1"), question(3, "q2", "answered")], {
    questions: [],
    handoffs: [{ id: "h1", reason: "login", description: "Sign in to GitHub", createdAt: 4 }],
    answers: {},
    handedBack: {},
  });
  assert.equal(countWaitingOnUser(live), 2);

  const ended = closeOpenPrompts(live);
  assert.equal(countWaitingOnUser(ended), 0);
  assert.deepEqual(
    ended.map((entry) => (entry.kind === "question" || entry.kind === "handoff" ? entry.status : entry.kind)),
    ["agent", "cancelled", "answered", "cancelled"],
    "what was answered stays answered; what was open is closed, not answerable",
  );
  assert.equal(countWaitingOnUser(live), 2, "the live entries are not changed");
});

test("step durations and thread titles are short", () => {
  assert.equal(formatStepDuration(640), "640 ms");
  assert.equal(formatStepDuration(1240), "1.2 s");
  assert.equal(titleFromPrompt("\n\n  Fix the login redirect  \nDetails follow"), "Fix the login redirect");
  assert.equal(titleFromPrompt(undefined), "");
  const clipped = titleFromPrompt("x".repeat(80));
  assert.equal(clipped.length, 60);
  assert.ok(clipped.endsWith("…"));
});
