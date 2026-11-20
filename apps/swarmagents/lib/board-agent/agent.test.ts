import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureStorePaths, getStoragePaths, loadStore } from "../board/store";
import type { LlmCompletion, LlmForwardOptions } from "../runtime/llm-gateway";
import { runBoardAgent } from "./agent";
import type { BoardAgentConversation, BoardAgentToolCall } from "./types";

const USER = "alice";

let cleanup: () => void;
test.beforeEach(() => {
  const { STORAGE_DIR, DATA_FILE } = getStoragePaths();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-agent-loop-"));
  configureStorePaths(dir, path.join(dir, "swarm_board.json"));
  cleanup = () => {
    configureStorePaths(STORAGE_DIR, DATA_FILE);
    fs.rmSync(dir, { recursive: true, force: true });
  };
});
test.afterEach(() => cleanup());

function conversation(): BoardAgentConversation {
  return { id: "thread-1", userId: USER, title: "Test", createdAt: 1, updatedAt: 1, messages: [] };
}

function tool(tool: BoardAgentToolCall["tool"], args: Record<string, unknown>): string {
  return `\`\`\`json\n${JSON.stringify({ tool, args })}\n\`\`\``;
}

function completion(text: string): LlmCompletion {
  return {
    body: { content: [{ type: "thinking", thinking: "Not part of the reply" }, { type: "text", text }] },
    usage: { inputTokens: 10, outputTokens: 10 }, attempts: [],
  };
}

type ChatBody = { system: string; messages: Array<{ role: string; content: string }> };
function provider(...replies: string[]) {
  const calls: LlmForwardOptions[] = [];
  async function forward(options: LlmForwardOptions): Promise<LlmCompletion> {
    calls.push(options);
    const next = replies.shift();
    if (next === undefined) throw new Error("Unexpected call");
    return completion(next);
  }
  return { forward, calls, body: (i: number) => calls[i].body as ChatBody };
}

const TASK = { title: "Fix docs", description: "Fix the incorrect example." };

test("routes as the owner and uses recent history and the new message for a plain reply", async () => {
  const conv = conversation();
  conv.messages = Array.from({ length: 25 }, (_, i) => ({
    role: i % 2 ? "user" : "agent", content: `history-${i}`, createdAt: 1,
  }));
  const llm = provider("Here's the answer.");
  const result = await runBoardAgent(USER, conv, "Hello", llm);
  assert.deepEqual(result, { reply: "Here's the answer.", taskIds: [], runIds: [] });
  assert.equal(llm.calls[0].owner, USER);
  assert.equal(llm.calls[0].useRoutedModel, true);
  assert.match(llm.body(0).system, /Never invent a task id/);
  assert.equal(llm.body(0).messages.length, 21);
  assert.deepEqual(llm.body(0).messages[0], { role: "user", content: "history-5" });
  assert.deepEqual(llm.body(0).messages.at(-1), { role: "user", content: "Hello" });
  assert.deepEqual(conv.messages.slice(-2).map((message) => message.role), ["user", "agent"]);
  assert.ok(conv.updatedAt > 1);
});

test("creates a real board task, dispatches it, and stores both ids beside the tool result", async () => {
  const conv = conversation();
  const description = `${TASK.description}\n\`\`\`sh\necho example\n\`\`\``;
  const command = tool("create_board_task", { ...TASK, description, dispatch: true });
  const llm = provider(`Starting now.\n${command}`, "The task is on the board and the VM run was accepted.");
  const result = await runBoardAgent(USER, conv, "Fix the example in the docs", {
    ...llm,
    dispatch: (owner, task) => {
      assert.equal(owner, USER);
      assert.equal(task.title, TASK.title);
      assert.equal(task.description, description);
      assert.equal(loadStore().tasks[0].id, task.id);
      return { runId: "run_docs" };
    },
  });
  const [saved] = loadStore().tasks;
  assert.deepEqual(result.taskIds, [saved.id]);
  assert.deepEqual(result.runIds, ["run_docs"]);
  assert.equal(llm.calls.length, 2);
  assert.match(llm.body(1).messages.at(-2)?.content ?? "", /create_board_task/);
  assert.match(llm.body(1).messages.at(-1)?.content ?? "", /Tool result .*\n.*run_docs/);
  assert.deepEqual(conv.messages.map((message) => message.role), ["user", "tool", "agent"]);
  assert.equal(conv.messages[1].taskId, saved.id);
  assert.equal(conv.messages[1].runId, "run_docs");
  assert.equal("runId" in saved, false);
});

test("task-only and list requests do not start a VM", async (t) => {
  const conv = conversation();
  const llm = provider(
    tool("create_board_task", TASK), "Task recorded.",
    tool("list_board_tasks", {}), "There is an open docs task.",
  );
  const dispatch = t.mock.fn(() => ({ runId: "unexpected" }));
  const recorded = await runBoardAgent(USER, conv, "Record a docs task, don't run it", { ...llm, dispatch });
  const listed = await runBoardAgent(USER, conv, "List my tasks", { ...llm, dispatch });
  assert.equal(recorded.taskIds.length, 1);
  assert.deepEqual(recorded.runIds, []);
  assert.deepEqual(listed.taskIds, []);
  assert.deepEqual(listed.runIds, []);
  assert.match(llm.body(3).messages.at(-1)?.content ?? "", /Fix docs \(open\)/);
  assert.equal(dispatch.mock.callCount(), 0);
  assert.equal(loadStore().tasks.length, 1);
});

test("a failed dispatch leaves the board task intact and tells the model why", async () => {
  const conv = conversation();
  const llm = provider(tool("create_board_task", { ...TASK, dispatch: true }), "The task was recorded, but no VM is configured.");
  const result = await runBoardAgent(USER, conv, "Fix the docs", {
    ...llm, dispatch: () => ({ error: "No VM is configured." }),
  });
  assert.deepEqual(result.taskIds, [loadStore().tasks[0].id]);
  assert.deepEqual(result.runIds, []);
  assert.match(result.reply, /no VM is configured/i);
  assert.match(llm.body(1).messages.at(-1)?.content ?? "", /Could not start the VM run: No VM is configured/);
  assert.equal(conv.messages[1].runId, undefined);
});

test("non-tool, malformed, unknown and ambiguous tool JSON is returned verbatim", async () => {
  const valid = tool("create_board_task", TASK);
  for (const text of [
    "I don't know.", " ```json\n{broken!\n``` ",
    '```json\n{"tool":"unknown","args":{}}\n```',
    '```json\n{"tool":"list_board_tasks","args":[]}\n```',
    `${valid}\n${valid}`,
  ]) {
    const llm = provider(text);
    assert.deepEqual(await runBoardAgent(USER, conversation(), "Hello", llm), { reply: text, taskIds: [], runIds: [] });
    assert.equal(llm.calls.length, 1);
  }
  assert.deepEqual(loadStore().tasks, []);
});

test("executes at most three tool calls even if the LLM ignores the final instruction", async () => {
  const conv = conversation();
  const llm = provider(...Array.from({ length: 4 }, (_, i) => tool("create_board_task", { ...TASK, title: `Fix docs ${i}` })));
  const result = await runBoardAgent(USER, conv, "Create tasks for the docs", llm);
  assert.equal(llm.calls.length, 4);
  assert.match(llm.body(3).system, /Tool limit reached/);
  assert.match(result.reply, /reached the tool limit/);
  assert.equal(result.taskIds.length, 3);
  assert.equal(conv.messages.filter((message) => message.role === "tool").length, 3);
  assert.equal(loadStore().tasks.length, 3);
});

test("a provider failure after a tool call keeps the task id and does not return upstream error details", async () => {
  const conv = conversation();
  const llm = provider(tool("create_board_task", TASK));
  const result = await runBoardAgent(USER, conv, "Record a docs task", llm);
  assert.equal(result.providerStatus, 502);
  assert.deepEqual(result.taskIds, [loadStore().tasks[0].id]);
  assert.ok(result.reply.includes(result.taskIds[0]));
  assert.doesNotMatch(result.reply, /Unexpected call/);
});

test("a missing provider returns the actionable BYOK reply without tool calls", async () => {
  const conv = conversation();
  const result = await runBoardAgent(USER, conv, "List my tasks", {
    forward: async () => { throw { status: 503, body: "gateway diagnostic", attempts: [] }; },
  });
  assert.deepEqual(result, {
    reply: "No provider is configured. Add your key in Settings (BYOK) before I can run.",
    taskIds: [], runIds: [], providerStatus: 503,
  });
  assert.deepEqual(conv.messages.map((message) => message.role), ["user", "agent"]);
});


test("the board reply comes from the tool even if the model claims an invented run and PR", async () => {
  const llm = provider(
    tool("create_board_task", { ...TASK, dispatch: true }),
    "I finished task_nonexistent in run_nonexistent and merged https://example.test/pull/42.",
  );
  const result = await runBoardAgent(USER, conversation(), "Fix the docs", {
    ...llm, dispatch: () => ({ error: "The VM queue is full." }),
  });
  const [saved] = loadStore().tasks;
  assert.deepEqual(result.taskIds, [saved.id]);
  assert.deepEqual(result.runIds, []);
  assert.ok(result.reply.includes(saved.id));
  assert.match(result.reply, /Could not start the VM run: The VM queue is full/);
  assert.doesNotMatch(result.reply, /nonexistent|merged|example\.test/);
});

test("no-tool replies do not claim unsupported identifiers or PR links", async () => {
  for (const unverified of ["See task_missing.", "Run run_missing finished.", "See https://example.test/pull/123."]) {
    const result = await runBoardAgent(USER, conversation(), "What happened?", provider(unverified));
    assert.match(result.reply, /couldn't verify/);
    assert.deepEqual(result.taskIds, []);
    assert.deepEqual(result.runIds, []);
  }
});

test("a digest tool request finishes on the board snapshot without a second provider round-trip", async () => {
  const llm = provider(tool("get_board_digest", {}));
  const response = await runBoardAgent(USER, conversation(), "What needs a review?", llm);
  assert.match(response.reply, /Board digest: 0 tasks/);
  assert.match(response.reply, /Needs review \(0\)/);
  assert.equal(response.providerStatus, undefined);
  assert.equal(llm.calls.length, 1);
});
