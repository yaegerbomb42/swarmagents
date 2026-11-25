import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTraceTimeline,
  classifyToolKind,
  flattenTraceTimeline,
  summarizeTraceStretch,
  type TimelineStep,
} from "./traceTimeline";
import type { RunStreamItem } from "./useRunStream";

function item(kind: string, data: unknown, ts: number, seq: number): RunStreamItem {
  return { seq, kind, data, parsed: { id: String(seq), event: kind, data: "" }, ts };
}

const T0 = 1_000_000;

function call(id: string, name: string, input: unknown, ts: number, seq: number): RunStreamItem {
  return item("tool.call", { id, name, input }, ts, seq);
}

function result(id: string, output: string, ts: number, seq: number, ok = true): RunStreamItem {
  return item("tool.result", { id, output, ok }, ts, seq);
}

function stepsOf(items: readonly RunStreamItem[]): TimelineStep[] {
  return flattenTraceTimeline(buildTraceTimeline(items));
}

// ---- kind classification ----

test("classifyToolKind covers the eight kinds", () => {
  assert.equal(classifyToolKind("Bash"), "bash");
  assert.equal(classifyToolKind("shell"), "bash");
  assert.equal(classifyToolKind("Write"), "edit");
  assert.equal(classifyToolKind("Edit"), "edit");
  assert.equal(classifyToolKind("MultiEdit"), "edit");
  assert.equal(classifyToolKind("NotebookEdit"), "edit");
  assert.equal(classifyToolKind("str_replace_editor"), "edit");
  assert.equal(classifyToolKind("Read"), "read");
  assert.equal(classifyToolKind("Glob"), "read");
  assert.equal(classifyToolKind("Grep"), "search");
  assert.equal(classifyToolKind("WebSearch"), "search");
  assert.equal(classifyToolKind("WebFetch"), "search");
  assert.equal(classifyToolKind("mcp__playwright__browser_navigate"), "browser");
  assert.equal(classifyToolKind("mcp__playwright-mcp__browser_click"), "browser");
  assert.equal(classifyToolKind("browser_navigate"), "browser");
  assert.equal(classifyToolKind("mcp__computer-mcp__click"), "desktop");
  assert.equal(classifyToolKind("mcp__computer-mcp__type"), "desktop");
  assert.equal(classifyToolKind("click"), "desktop");
  assert.equal(classifyToolKind("mcp__sequential-thinking__sequentialthinking"), "mcp");
  assert.equal(classifyToolKind("some_unknown_tool"), "mcp");
});

// ---- pairing, duration, status ----

test("pairs calls with results by id with duration and ok", () => {
  const steps = stepsOf([
    call("c1", "Bash", { command: "npm test" }, T0, 1),
    result("c1", "2 passed", T0 + 1500, 2),
  ]);
  assert.equal(steps.length, 1);
  const [step] = steps;
  assert.equal(step.kind, "bash");
  assert.equal(step.label, "Running: npm test");
  assert.equal(step.status, "done");
  assert.equal(step.ok, true);
  assert.equal(step.durationMs, 1500);
  assert.equal(step.startedAt, T0);
  assert.equal(step.endedAt, T0 + 1500);
  assert.equal(step.diff?.kind, "stdout");
  assert.equal(step.diff?.body, "2 passed");
  assert.equal(step.diff?.truncated, false);
});

test("an error result marks the step failed", () => {
  const steps = stepsOf([
    call("c1", "Bash", { command: "false" }, T0, 1),
    result("c1", "exit 1", T0 + 50, 2, false),
  ]);
  assert.equal(steps[0].status, "error");
  assert.equal(steps[0].ok, false);
});

test("a call with no result stays running until the run ends", () => {
  const live = stepsOf([call("c1", "Bash", { command: "sleep 60" }, T0, 1)]);
  assert.equal(live[0].status, "running");
  assert.equal(live[0].ok, undefined);
  assert.equal(live[0].durationMs, undefined);

  const finished = stepsOf([
    call("c1", "Bash", { command: "sleep 60" }, T0, 1),
    item("run.finished", { exitCode: 0 }, T0 + 100, 2),
  ]);
  assert.equal(finished[0].status, "done");
  assert.equal(finished[0].ok, true);

  const errored = stepsOf([
    call("c1", "Bash", { command: "sleep 60" }, T0, 1),
    item("run.error", { message: "boom" }, T0 + 100, 2),
  ]);
  assert.equal(errored[0].status, "error");
  assert.equal(errored[0].ok, false);
});

test("a result with no matching call surfaces as a zero-duration step", () => {
  const steps = stepsOf([result("ghost", "late output", T0, 1)]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, "done");
  assert.equal(steps[0].durationMs, 0);
  assert.equal(steps[0].diff?.body, "late output");
});

test("an id-less result closes the most recent running call", () => {
  const steps = stepsOf([
    call("c1", "Bash", { command: "one" }, T0, 1),
    call("c2", "Bash", { command: "two" }, T0 + 10, 2),
    item("tool.result", { output: "two out" }, T0 + 20, 3),
  ]);
  assert.equal(steps[0].status, "running");
  assert.equal(steps[1].status, "done");
  assert.equal(steps[1].diff?.body, "two out");
});

test("a repeated call with the same id refreshes in place", () => {
  const steps = stepsOf([
    call("c1", "Bash", { command: "one" }, T0, 1),
    result("c1", "one out", T0 + 10, 2),
    call("c1", "Bash", { command: "two" }, T0 + 20, 3),
  ]);
  // The replay re-opens the same step rather than duplicating the row.
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, "running");
  assert.equal(steps[0].label, "Running: two");
});

// ---- diff previews ----

test("Write previews new content as added diff lines", () => {
  const steps = stepsOf([
    call("c1", "Write", { file_path: "hello.txt", content: "line one\nline two" }, T0, 1),
    result("c1", "", T0 + 10, 2),
  ]);
  assert.equal(steps[0].kind, "edit");
  assert.equal(steps[0].file, "hello.txt");
  assert.equal(steps[0].diff?.kind, "diff");
  assert.equal(steps[0].diff?.body, "+ line one\n+ line two");
  assert.equal(steps[0].diff?.truncated, false);
});

test("Edit previews removed then added lines", () => {
  const steps = stepsOf([
    call(
      "c1",
      "Edit",
      { file_path: "a.py", old_string: "x = 1", new_string: "x = 2" },
      T0,
      1,
    ),
    result("c1", "", T0 + 10, 2),
  ]);
  assert.equal(steps[0].diff?.body, "- x = 1\n+ x = 2");
});

test("MultiEdit previews one hunk per edit", () => {
  const steps = stepsOf([
    call(
      "c1",
      "MultiEdit",
      {
        file_path: "a.py",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      },
      T0,
      1,
    ),
    result("c1", "", T0 + 10, 2),
  ]);
  assert.equal(
    steps[0].diff?.body,
    "--- edit 1 ---\n- a\n+ b\n--- edit 2 ---\n- c\n+ d",
  );
});

test("long diffs are capped at 40 lines with a truncation note", () => {
  const content = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const steps = stepsOf([
    call("c1", "Write", { file_path: "big.txt", content }, T0, 1),
    result("c1", "", T0 + 10, 2),
  ]);
  const body = steps[0].diff?.body ?? "";
  assert.equal(body.split("\n").length, 41); // 40 lines + the note
  assert.match(body, /20 more lines/);
  assert.equal(steps[0].diff?.truncated, true);
});

test("long stdout is capped at 4000 chars", () => {
  const output = "x".repeat(5000);
  const steps = stepsOf([
    call("c1", "Bash", { command: "cat big" }, T0, 1),
    result("c1", output, T0 + 10, 2),
  ]);
  assert.equal(steps[0].diff?.body.length, 4001); // 4000 chars + ellipsis
  assert.equal(steps[0].diff?.truncated, true);
});

test("an edit with no usable input has no diff, but keeps its label", () => {
  const steps = stepsOf([
    call("c1", "Edit", { file_path: "a.py" }, T0, 1),
    result("c1", "", T0 + 10, 2),
  ]);
  assert.equal(steps[0].diff, undefined);
  assert.equal(steps[0].label, "Editing a.py");
});

test("a result with no output has no diff", () => {
  const steps = stepsOf([
    call("c1", "Bash", { command: "true" }, T0, 1),
    result("c1", "", T0 + 10, 2),
  ]);
  assert.equal(steps[0].diff, undefined);
});

// ---- secret safety ----

test("typed text is never carried in any preview", () => {
  const steps = stepsOf([
    call("c1", "mcp__computer-mcp__type", { text: "hunter2-secret-password" }, T0, 1),
    result("c1", "", T0 + 10, 2),
    call("c2", "mcp__playwright__browser_type", { text: "also-secret" }, T0 + 20, 3),
    result("c2", "", T0 + 30, 4),
  ]);
  for (const step of steps) {
    assert.equal(step.preview.includes("secret"), false, step.preview);
    assert.equal(step.diff?.body.includes("secret") ?? false, false);
  }
  assert.equal(steps[0].kind, "desktop");
  assert.equal(steps[1].kind, "browser");
});

test("no step renders raw JSON: previews are plain strings, never objects", () => {
  const steps = stepsOf([
    call("c1", "mcp__weird__tool", { nested: { deep: [1, 2, 3] }, token: "abc" }, T0, 1),
    result("c1", "{\"ok\":true}", T0 + 10, 2),
  ]);
  assert.equal(typeof steps[0].preview, "string");
  // The call's input (nested object, token) never appears in any preview.
  assert.equal(steps[0].preview.includes("abc"), false);
  assert.equal(steps[0].preview.includes("nested"), false);
  assert.equal(steps[0].diff?.body.includes("abc") ?? false, false);
  // The tool's own stdout text is shown as-is, even when it is JSON text.
  assert.equal(steps[0].diff?.body, "{\"ok\":true}");
});

// ---- thinking ----

test("assistant.thinking becomes a thinking step", () => {
  const steps = stepsOf([
    item("assistant.thinking", { text: "Let me check the tests first, then edit the file." }, T0, 1),
    call("c1", "Read", { file_path: "a.py" }, T0 + 10, 2),
    result("c1", "contents", T0 + 20, 3),
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].kind, "thinking");
  assert.equal(steps[0].label, "Thinking");
  assert.equal(steps[0].status, "done");
  assert.equal(steps[0].preview, "Let me check the tests first, then edit the file.");
  assert.equal(steps[0].toolName, undefined);
  assert.equal(steps[1].kind, "read");
});

test("thinking text is accepted in nested and raw shapes, and capped", () => {
  const long = "word ".repeat(100);
  const steps = stepsOf([
    item("assistant.thinking", { data: { thinking: long } }, T0, 1),
    item("assistant.thinking", "short raw thought", T0 + 10, 2),
    item("assistant.thinking", { text: "   " }, T0 + 20, 3),
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].preview.length, 240);
  assert.equal(steps[1].preview, "short raw thought");
});

test("thinking events do not disturb tool pairing", () => {
  const steps = stepsOf([
    call("c1", "Bash", { command: "one" }, T0, 1),
    item("assistant.thinking", { text: "hmm" }, T0 + 5, 2),
    result("c1", "one out", T0 + 10, 3),
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].status, "done");
  assert.equal(steps[0].diff?.body, "one out");
  assert.equal(steps[1].kind, "thinking");
});

// ---- stretches ----

test("agent prose splits stretches, empty prose does not", () => {
  const stretches = buildTraceTimeline([
    call("c1", "Bash", { command: "one" }, T0, 1),
    result("c1", "o1", T0 + 10, 2),
    item("assistant.text", { text: "Done with that." }, T0 + 20, 3),
    call("c2", "Bash", { command: "two" }, T0 + 30, 4),
    result("c2", "o2", T0 + 40, 5),
    item("assistant.text", { text: "   " }, T0 + 50, 6),
    call("c3", "Bash", { command: "three" }, T0 + 60, 7),
    result("c3", "o3", T0 + 70, 8),
  ]);
  assert.equal(stretches.length, 2);
  assert.equal(stretches[0].steps.length, 1);
  assert.equal(stretches[1].steps.length, 2);
  assert.equal(stretches[1].steps[1].label, "Running: three");
});

test("questions and handoffs end the current stretch", () => {
  const stretches = buildTraceTimeline([
    call("c1", "Bash", { command: "one" }, T0, 1),
    result("c1", "o1", T0 + 10, 2),
    item("question.required", { id: "q1", question: "Proceed?" }, T0 + 20, 3),
    call("c2", "Bash", { command: "two" }, T0 + 30, 4),
    result("c2", "o2", T0 + 40, 5),
  ]);
  assert.equal(stretches.length, 2);
  assert.equal(stretches[0].steps[0].label, "Running: one");
  assert.equal(stretches[1].steps[0].label, "Running: two");
});

test("ask_user and desktop handoff calls are skipped (they render as cards)", () => {
  const steps = stepsOf([
    call("c1", "ask_user", { question: "Which one?" }, T0, 1),
    call("c2", "mcp__x__ask_human_desktop", { reason: "help" }, T0 + 10, 2),
    call("c3", "Bash", { command: "real work" }, T0 + 20, 3),
    result("c3", "done", T0 + 30, 4),
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "Running: real work");
});

test("an empty log yields no stretches", () => {
  assert.deepEqual(buildTraceTimeline([]), []);
  assert.deepEqual(flattenTraceTimeline([]), []);
});

test("historical replay: a finished run's items group identically", () => {
  // The same flat list a replayed run loads from the API.
  const items = [
    item("run.created", { prompt: "fix the bug" }, T0, 1),
    item("assistant.text", { text: "On it." }, T0 + 5, 2),
    call("c1", "Read", { file_path: "bug.py" }, T0 + 10, 3),
    result("c1", "print('bug')", T0 + 20, 4),
    call("c2", "Edit", { file_path: "bug.py", old_string: "bug", new_string: "fix" }, T0 + 30, 5),
    result("c2", "", T0 + 40, 6),
    item("assistant.text", { text: "Fixed." }, T0 + 50, 7),
    item("run.finished", { exitCode: 0 }, T0 + 60, 8),
  ];
  const stretches = buildTraceTimeline(items);
  assert.equal(stretches.length, 1);
  assert.equal(stretches[0].steps.length, 2);
  assert.equal(stretches[0].steps[0].kind, "read");
  assert.equal(stretches[0].steps[1].diff?.body, "- bug\n+ fix");
  assert.equal(stretches[0].steps.every((s) => s.status === "done"), true);
});

// ---- summary ----

test("summarizeTraceStretch counts, sums durations, flags failures", () => {
  const steps = stepsOf([
    call("c1", "Bash", { command: "one" }, T0, 1),
    result("c1", "o1", T0 + 100, 2),
    call("c2", "Bash", { command: "two" }, T0 + 200, 3),
    result("c2", "o2", T0 + 500, 4, false),
    call("c3", "Bash", { command: "three" }, T0 + 600, 5),
  ]);
  const summary = summarizeTraceStretch(steps);
  assert.equal(summary.count, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.running, true);
  assert.equal(summary.durationMs, 400);
  assert.equal(summary.label, "Running: three");
});

test("summarizeTraceStretch of an empty stretch has no duration or label", () => {
  const summary = summarizeTraceStretch([]);
  assert.deepEqual(summary, { count: 0, running: false, failed: 0, label: "" });
});

test("tool.blocked settles the matching running call with the blocked label and reason", () => {
  const steps = stepsOf([
    call("c1", "Bash", { command: "ls /etc" }, T0, 1),
    item("tool.blocked", { name: "Bash", reason: "VM-only policy: outside /workspace" }, T0 + 15, 2),
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, "error");
  assert.equal(steps[0].ok, false);
  assert.match(steps[0].label, /Blocked Bash/);
  assert.match(steps[0].label, /VM-only policy/);
});
