/**
 * Conversation reducer tests (lib/client/conversation.ts).
 *
 * The minimal main page's log is a pure mapping from run-stream events to
 * user/agent/tool/question/status rows. These tests cover readable tool
 * labels, result pairing, upload-manifest stripping and question lifecycle.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { RunStreamItem } from "./useRunStream";
import {
  buildConversation,
  describeToolCall,
  isAskUserToolName,
  isDesktopHandoffToolName,
  shortToolName,
  splitUploadedFiles,
} from "./conversation";

let seq = 0;
function item(kind: string, data: unknown, ts = 1_000 + seq): RunStreamItem {
  seq += 1;
  return { seq, kind, data, parsed: { event: kind, data: "" }, ts };
}

test("conversation: readable one-line narration for the common tools", () => {
  assert.equal(describeToolCall("Bash", { command: "mkdir -p game" }), "Running: mkdir -p game");
  assert.equal(describeToolCall("Write", { file_path: "game/index.html" }), "Writing game/index.html");
  assert.equal(describeToolCall("Edit", { file_path: "src/App.tsx" }), "Editing src/App.tsx");
  assert.equal(describeToolCall("Read", { file_path: "/workspace/app.ts" }), "Reading /workspace/app.ts");
  assert.equal(describeToolCall("Glob", { pattern: "**/*.ts" }), "Finding **/*.ts");
  assert.equal(describeToolCall("Grep", { pattern: "apiKey" }), 'Searching for "apiKey"');
  assert.equal(describeToolCall("WebSearch", { query: "vite setup" }), 'Searching the web for "vite setup"');
  assert.equal(describeToolCall("browser_navigate", { url: "http://localhost:5173" }), "Opening http://localhost:5173 in the browser");
  assert.equal(describeToolCall("mcp__computer-mcp__click", { target: "Start" }), "Clicking Start");
  assert.equal(describeToolCall("mcp__weird__do_thing", {}), "Calling tool: do_thing");
  assert.equal(describeToolCall("Bash", {}), "Running a shell command");
});

test("conversation: long commands are truncated in the one-line label", () => {
  const label = describeToolCall("Bash", { command: "x".repeat(500) });
  assert.ok(label.length < 140);
  assert.ok(label.endsWith("…"));
});

test("conversation: tool name helpers strip the MCP wrapper", () => {
  assert.equal(shortToolName("mcp__computer-mcp__click"), "click");
  assert.equal(shortToolName("Bash"), "Bash");
  assert.equal(isAskUserToolName("mcp__ask__ask_user"), true);
  assert.equal(isAskUserToolName("ask_user"), true);
  assert.equal(isAskUserToolName("Bash"), false);
  assert.equal(isDesktopHandoffToolName("mcp__desktop-handoff__ask_human_desktop"), true);
  assert.equal(isDesktopHandoffToolName("ask_human_desktop"), true);
  assert.equal(isDesktopHandoffToolName("ask_user"), false);
});

test("conversation: the upload manifest becomes attachment chips", () => {
  const prompt =
    "build me a game\n\nUploaded files (in /workspace/uploads/):\n" +
    "- /workspace/uploads/design.png (2048 bytes)\n" +
    "- /workspace/uploads/clip.mp4 (12604 bytes)\n" +
    "- /workspace/uploads/notes.txt (0 bytes)";
  assert.deepEqual(splitUploadedFiles(prompt), {
    text: "build me a game",
    attachments: ["design.png", "clip.mp4", "notes.txt"],
  });
  assert.deepEqual(splitUploadedFiles("plain prompt"), { text: "plain prompt", attachments: [] });
});

test("conversation: upload manifests written before sizes still become chips", () => {
  // Older runs appended paths without a size suffix; the conversation must
  // still render them as chips.
  const prompt =
    "build me a game\n\nUploaded files (in /workspace/uploads/):\n" +
    "- /workspace/uploads/design.png\n- /workspace/uploads/clip.mp4";
  assert.deepEqual(splitUploadedFiles(prompt), {
    text: "build me a game",
    attachments: ["design.png", "clip.mp4"],
  });
});

test("conversation: user ask, agent message, tool call and paired result", () => {
  const entries = buildConversation([
    item("run.created", { prompt: "build me a game" }),
    item("assistant.text", "Creating a game now…"),
    item("tool.call", { id: "t1", name: "Bash", input: { command: "mkdir game" } }, 1_000),
    item("tool.result", { id: "t1", ok: true, output: "" }, 1_500),
    item("tool.call", { id: "t2", name: "Write", input: { file_path: "game/index.html" } }),
    item("tool.result", { id: "t2", ok: false, output: "disk full", truncated: true }, 1_700),
  ]);

  assert.deepEqual(entries.map((e) => e.kind), ["user", "agent", "tool", "tool"]);
  assert.equal(entries[0].kind === "user" && entries[0].text, "build me a game");
  assert.equal(entries[1].kind === "agent" && entries[1].text, "Creating a game now…");

  const first = entries[2];
  assert.ok(first.kind === "tool");
  assert.equal(first.label, "Running: mkdir game");
  assert.equal(first.status, "done");
  assert.equal(first.output, "");
  assert.equal(first.durationMs, 500);

  const second = entries[3];
  assert.ok(second.kind === "tool");
  assert.equal(second.status, "error");
  assert.equal(second.output, "disk full");
  assert.equal(second.truncated, true);
});

test("conversation: an unpaired tool call stays running", () => {
  const entries = buildConversation([
    item("tool.call", { id: "t1", name: "Bash", input: { command: "sleep 100" } }),
  ]);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].kind === "tool");
  assert.equal(entries[0].status, "running");
});

test("conversation: a tool call whose result never arrives settles when the run ends", () => {
  // The live bug: a Bash step kept showing "Running" after the run finished
  // because its tool.result never paired by id. A finished run has no tool
  // still running.
  const finished = buildConversation([
    item("tool.call", { id: "t1", name: "Bash", input: { command: "python3 /workspace/fib.py" } }),
    item("run.finished", { exitCode: 0, costUsd: 0.01, durationMs: 3800 }),
  ]);
  assert.equal(finished.length, 2);
  assert.ok(finished[0].kind === "tool");
  assert.equal(finished[0].label, "Running: python3 /workspace/fib.py");
  assert.equal(finished[0].status, "done", "a finished run settles the step to done");

  const errored = buildConversation([
    item("tool.call", { id: "t1", name: "Bash", input: { command: "python3 /workspace/fib.py" } }),
    item("run.error", { message: "claude exited with code 1" }),
  ]);
  assert.ok(errored[0].kind === "tool");
  assert.equal(errored[0].status, "error", "an errored run settles the step to error");

  const cancelled = buildConversation([
    item("tool.call", { id: "t1", name: "Bash", input: { command: "python3 /workspace/fib.py" } }),
    item("run.cancelled", {}),
  ]);
  assert.ok(cancelled[0].kind === "tool");
  assert.equal(cancelled[0].status, "error", "a cancelled run settles the step to error");
});

test("conversation: ask_user renders as a question card, not a raw tool row", () => {
  const entries = buildConversation([
    item("tool.call", { id: "t_ask", name: "mcp__ask__ask_user", input: { question: "Which engine?" } }),
    item("question.required", {
      question: { id: "q_1", question: "Which engine?", options: ["Godot", "Three.js"], allowFreeText: true },
    }),
    item("question.resolved", { id: "q_1", status: "answered", answer: "Godot" }),
  ]);

  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry.kind === "question");
  assert.equal(entry.id, "q_1");
  assert.equal(entry.question, "Which engine?");
  assert.deepEqual(entry.options, ["Godot", "Three.js"]);
  assert.equal(entry.allowFreeText, true);
  assert.equal(entry.status, "answered");
  assert.equal(entry.answer, "Godot");
});

test("conversation: cancelled and expired questions update the card", () => {
  const cancelled = buildConversation([
    item("question.required", { id: "q_a", question: "A?", allowFreeText: false }),
    item("question.resolved", { id: "q_a", status: "cancelled" }),
  ]);
  assert.equal(cancelled.length, 1);
  assert.ok(cancelled[0].kind === "question");
  assert.equal(cancelled[0].status, "cancelled");
  assert.deepEqual(cancelled[0].options, []);
  assert.equal(cancelled[0].allowFreeText, false);

  const expired = buildConversation([
    item("question.required", { id: "q_b", question: "B?" }),
    item("question.resolved", { id: "q_b", status: "expired" }),
  ]);
  assert.ok(expired[0].kind === "question");
  assert.equal(expired[0].status, "expired");
});

test("conversation: ask_human_desktop renders as a handoff card, not a raw tool row", () => {
  const entries = buildConversation([
    item("tool.call", { id: "t_h", name: "mcp__desktop-handoff__ask_human_desktop", input: { reason: "CAPTCHA" } }),
    item("handoff.required", {
      handoff: { id: "h_1", reason: "CAPTCHA", description: "solve the reCAPTCHA" },
    }),
    item("handoff.resolved", { id: "h_1", status: "answered" }),
  ]);

  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry.kind === "handoff");
  assert.equal(entry.id, "h_1");
  assert.equal(entry.reason, "CAPTCHA");
  assert.equal(entry.description, "solve the reCAPTCHA");
  assert.equal(entry.status, "answered");
});

test("conversation: cancelled handoffs update the card", () => {
  const entries = buildConversation([
    item("handoff.required", { handoff: { id: "h_a", reason: "2FA" } }),
    item("handoff.resolved", { id: "h_a", status: "cancelled" }),
  ]);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].kind === "handoff");
  assert.equal(entries[0].status, "cancelled");
});

test("conversation: a handoff resolution without the required card is a status line", () => {
  const entries = buildConversation([item("handoff.resolved", { id: "h_x", status: "answered" })]);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].kind === "status");
  assert.equal(entries[0].text, "Desktop handed back");
});

test("conversation: tool.blocked and run terminal states become status lines", () => {
  const entries = buildConversation([
    item("tool.blocked", { name: "Bash", reason: "VM-only policy: host path" }),
    item("run.error", { message: "Halted by harness risk policy" }),
    item("run.cancelled", {}),
    item("run.finished", { exitCode: 0, costUsd: 0.012, durationMs: 2300 }),
  ]);
  assert.deepEqual(entries.map((e) => e.kind), ["status", "status", "status", "status"]);
  const statuses = entries.filter(
    (e): e is Extract<(typeof entries)[number], { kind: "status" }> => e.kind === "status",
  );
  const [blocked, error, cancelled, finished] = statuses;
  assert.match(blocked.text, /Blocked Bash/);
  assert.equal(blocked.tone, "error");
  assert.equal(error.tone, "error");
  assert.equal(cancelled.text, "Run stopped");
  assert.equal(finished.tone, "done");
  assert.match(finished.text, /Done/);
  assert.match(finished.text, /\$0\.012/);
});

test("conversation: auto-approve runs produce no approval cards", () => {
  const entries = buildConversation([
    item("tool.call", { id: "t1", name: "Write", input: { file_path: "index.html" } }),
    item("tool.result", { id: "t1", ok: true }),
  ]);
  assert.equal(entries.filter((e) => e.kind === "status").length, 0);
  assert.equal(entries.filter((e) => e.kind === "tool").length, 1);
});

test("conversation: builds are idempotent for a repeated prefix", () => {
  const items = [
    item("run.created", { prompt: "hi" }),
    item("tool.call", { id: "t1", name: "Bash", input: { command: "ls" } }),
  ];
  const a = buildConversation(items);
  const b = buildConversation(items);
  assert.deepEqual(a, b);
});

test("conversation: handles the real SSE wire shape (payload nested under data)", () => {
  // The SSE body is the whole sequenced event: {type, data: payload, seq,...}.
  const wire = (kind: string, payload: unknown) => item(kind, { type: kind, data: payload, seq: 1, runId: "r", ts: 1 });
  const entries = buildConversation([
    wire("run.created", { prompt: "build me a game" }),
    wire("assistant.text", { text: "Creating a game now…" }),
    wire("tool.call", { id: "t1", name: "Write", input: { file_path: "game/index.html" } }),
    wire("tool.result", { id: "t1", ok: true, output: "ok" }),
    wire("run.finished", { exitCode: 0, costUsd: 0.01, durationMs: 1200 }),
  ]);
  assert.deepEqual(entries.map((e) => e.kind), ["user", "agent", "tool", "status"]);
  assert.equal(entries[0].kind === "user" && entries[0].text, "build me a game");
  assert.equal(entries[1].kind === "agent" && entries[1].text, "Creating a game now…");
  assert.ok(entries[2].kind === "tool");
  assert.equal(entries[2].label, "Writing game/index.html");
  assert.equal(entries[2].status, "done");
});
