import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PLAN_STEPS,
  applyPlanToolCall,
  createPlanTracker,
  formatPlanSummary,
  isPlanToolName,
  latestPlanFromEvents,
  parsePlanSteps,
  planProgress,
} from "./run-plan";

// One assistant line copied from a Claude Code 2.x `--output-format
// stream-json` run (ids shortened).
const CLAUDE_CODE_TODOWRITE_LINE =
  '{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"toolu_01","name":"TodoWrite","input":{"todos":[{"content":"Find the cheapest flight on Google Flights","status":"completed","activeForm":"Finding the cheapest flight on Google Flights"},{"content":"Compare baggage fees","status":"in_progress","activeForm":"Comparing baggage fees"},{"content":"Write the summary table","status":"pending","activeForm":"Writing the summary table"}]}}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"sess_1"}';

test("TodoWrite from a real Claude Code stream-json line folds into a plan", () => {
  const line = JSON.parse(CLAUDE_CODE_TODOWRITE_LINE);
  const block = line.message.content[0];
  const plan = applyPlanToolCall([], block.name, block.input);
  assert.ok(plan);
  assert.deepEqual(
    plan.map((s) => [s.id, s.status]),
    [
      ["1", "completed"],
      ["2", "in_progress"],
      ["3", "pending"],
    ],
  );
  assert.equal(plan[1].activeForm, "Comparing baggage fees");
  const progress = planProgress(plan);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
  assert.equal(progress.current?.content, "Compare baggage fees");
});

test("TodoWrite replaces the whole list; a JSON-string input (bridged providers) works too", () => {
  const first = applyPlanToolCall([], "TodoWrite", { todos: [{ content: "a", status: "pending" }] });
  const second = applyPlanToolCall(first ?? [], "TodoWrite", JSON.stringify({ todos: [{ content: "b", status: "done" }] }));
  assert.deepEqual(second, [{ id: "1", content: "b", status: "completed" }]);
});

test("TaskCreate / TaskUpdate build the plan incrementally (newer CLIs)", () => {
  let plan = applyPlanToolCall([], "TaskCreate", { subject: "Open the repo", activeForm: "Opening the repo" }) ?? [];
  plan = applyPlanToolCall(plan, "TaskCreate", { subject: "Run the tests" }) ?? plan;
  plan = applyPlanToolCall(plan, "TaskCreate", { subject: "Throwaway" }) ?? plan;
  assert.deepEqual(plan.map((s) => s.id), ["1", "2", "3"]);
  plan = applyPlanToolCall(plan, "TaskUpdate", { taskId: "1", status: "completed" }) ?? plan;
  plan = applyPlanToolCall(plan, "TaskUpdate", { taskId: 2, status: "in_progress", activeForm: "Running the tests" }) ?? plan;
  plan = applyPlanToolCall(plan, "TaskUpdate", { taskId: "3", status: "deleted" }) ?? plan;
  assert.deepEqual(
    plan.map((s) => [s.id, s.status]),
    [
      ["1", "completed"],
      ["2", "in_progress"],
    ],
  );
  // An update to an unknown task changes nothing.
  assert.equal(applyPlanToolCall(plan, "TaskUpdate", { taskId: "99", status: "completed" }), null);
});

test("TaskCreate numbering keeps counting past a deleted task (as the CLI does)", () => {
  const tracker = createPlanTracker();
  tracker.onToolUse("TaskCreate", { subject: "a" });
  tracker.onToolUse("TaskCreate", { subject: "b" });
  tracker.onToolUse("TaskCreate", { subject: "c" });
  tracker.onToolUse("TaskUpdate", { taskId: "3", status: "deleted" });
  const plan = tracker.onToolUse("TaskCreate", { subject: "d" });
  assert.deepEqual(plan?.map((s) => s.id), ["1", "2", "4"]);
  // TaskUpdate on the CLI's id 4 lands on "d".
  const updated = tracker.onToolUse("TaskUpdate", { taskId: "4", status: "completed" });
  assert.equal(updated?.[2].status, "completed");
  // Replaying the raw calls (older runs) gives the same answer.
  const replay = latestPlanFromEvents(
    [
      ["TaskCreate", { subject: "a" }],
      ["TaskCreate", { subject: "b" }],
      ["TaskCreate", { subject: "c" }],
      ["TaskUpdate", { taskId: "3", status: "deleted" }],
      ["TaskCreate", { subject: "d" }],
    ].map(([name, input]) => ({ kind: "tool.call", data: { name, input } })),
  );
  assert.deepEqual(replay?.map((s) => s.id), ["1", "2", "4"]);
});

test("non-plan tools and malformed inputs leave the plan alone", () => {
  assert.equal(applyPlanToolCall([], "Bash", { command: "ls" }), null);
  assert.equal(applyPlanToolCall([], "TodoWrite", { todos: "nope" }), null);
  assert.equal(applyPlanToolCall([], "TodoWrite", "{not json"), null);
  assert.equal(isPlanToolName("mcp__claude__TodoWrite"), true);
  assert.equal(isPlanToolName("TodoRead"), false);
});

test("caps step count and step length so a runaway model cannot flood the UI", () => {
  const todos = Array.from({ length: 80 }, (_, i) => ({ content: `step ${i} ${"x".repeat(400)}`, status: "pending" }));
  const plan = applyPlanToolCall([], "TodoWrite", { todos }) ?? [];
  assert.equal(plan.length, MAX_PLAN_STEPS);
  assert.ok(plan[0].content.length <= 200);
});

test("tracker reports only real changes (dedupe)", () => {
  const tracker = createPlanTracker();
  const todos = [{ content: "a", status: "pending", activeForm: "Doing a" }];
  assert.ok(tracker.onToolUse("TodoWrite", { todos }));
  assert.equal(tracker.onToolUse("TodoWrite", { todos }), null);
  assert.equal(tracker.onToolUse("Bash", { command: "ls" }), null);
  const changed = tracker.onToolUse("TodoWrite", { todos: [{ ...todos[0], status: "completed" }] });
  assert.equal(changed?.[0].status, "completed");
});

test("latestPlanFromEvents: run.plan wins; raw tool.call is folded for older runs; SSE and run-log shapes", () => {
  // Run-log shape (flat fields), older run without run.plan.
  const legacy = latestPlanFromEvents([
    { type: "tool.call", name: "TodoWrite", input: { todos: [{ content: "a", status: "in_progress" }] } } as never,
    { type: "tool.call", name: "Bash", input: { command: "ls" } } as never,
  ]);
  assert.deepEqual(legacy?.map((s) => s.status), ["in_progress"]);
  // SSE shape: kind + data.
  const live = latestPlanFromEvents([
    { kind: "tool.call", data: { name: "TodoWrite", input: { todos: [{ content: "x", status: "pending" }] } } },
    { kind: "run.plan", data: { steps: [{ id: "1", content: "y", status: "completed" }] } },
  ]);
  assert.deepEqual(live?.map((s) => s.content), ["y"]);
  assert.equal(latestPlanFromEvents([{ kind: "assistant.text", data: { text: "hi" } }]), null);
});

test("parsePlanSteps drops invalid entries from the wire", () => {
  const steps = parsePlanSteps([{ content: "ok", status: "pending" }, { content: "", status: "pending" }, { content: "x", status: "weird" }, 5]);
  assert.deepEqual(steps?.map((s) => s.content), ["ok"]);
  assert.equal(parsePlanSteps("nope"), null);
});

test("formatPlanSummary", () => {
  assert.equal(formatPlanSummary({ done: 7, total: 7 }), "Plan: 7/7 completed");
});
