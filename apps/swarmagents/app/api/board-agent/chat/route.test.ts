import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { USER_HEADER } from "@/lib/auth";
import type { BoardAgentConversation } from "@/lib/board-agent/types";
import { configureStorePaths, getStoragePaths, loadStore } from "@/lib/board/store";
import { writeConfiguredProviders } from "@/lib/providers/store";
import { resetLlmRoutingForTests } from "@/lib/runtime/llm-routing";
import { RuntimeManager, setRuntimeManagerForTesting } from "@/lib/runtime/manager";
import { GET, POST } from "./route";

const URL = "http://localhost/api/board-agent/chat";
const ALICE = "local_alice@example.test";
const BOB = "local_bob@example.test";
const RUN_ID = "run_test_board_chat";

type UpstreamRequest = { model: string; messages: Array<{ role: string; content: string }> };
let requests: UpstreamRequest[];
let replies: Array<Response | (() => Promise<Response>)>;
let cleanup: () => void;

test.beforeEach(() => {
  const { STORAGE_DIR, DATA_FILE } = getStoragePaths();
  const oldHome = process.env.SWARM_HOME;
  const oldServerMode = process.env.SWARM_SERVER_MODE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-agent-chat-"));
  process.env.SWARM_HOME = dir;
  process.env.SWARM_SERVER_MODE = "1"; // Host keys are not available to the test callers.
  configureStorePaths(dir, path.join(dir, "swarm_board.json"));
  cleanup = () => {
    if (oldHome === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = oldHome;
    if (oldServerMode === undefined) delete process.env.SWARM_SERVER_MODE;
    else process.env.SWARM_SERVER_MODE = oldServerMode;
    configureStorePaths(STORAGE_DIR, DATA_FILE);
    setRuntimeManagerForTesting(null);
    resetLlmRoutingForTests();
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  requests = [];
  replies = [];
  // Exercise the actual gateway and Anthropic wire shape, but intercept every
  // call in-process. These tests never need a live provider or VM.
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://fake-provider.example.test/v1/messages");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "fake-key-for-board-chat-tests");
    requests.push(JSON.parse(String(init?.body)) as UpstreamRequest);
    const next = replies.shift();
    assert.ok(next, "unexpected provider call");
    return typeof next === "function" ? next() : next;
  });
});
test.afterEach(() => cleanup());

function configureFakeProvider() {
  writeConfiguredProviders(ALICE, [{
    id: "anthropic", kind: "anthropic", baseUrl: "https://fake-provider.example.test",
    models: { balanced: "fake-board-model" }, keys: ["fake-key-for-board-chat-tests"],
  }]);
}

function providerReply(text: string): Response {
  return Response.json({
    type: "message", role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 },
  });
}

function postRaw(raw: string, userId = ALICE): Promise<Response> {
  return POST(new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(userId ? { [USER_HEADER]: userId } : {}) },
    body: raw,
  }));
}

function post(body: unknown, userId = ALICE): Promise<Response> {
  return postRaw(JSON.stringify(body), userId);
}

function get(userId: string, conversationId?: string): Promise<Response> {
  return GET(new Request(conversationId === undefined ? URL : `${URL}?conversationId=${encodeURIComponent(conversationId)}`, {
    headers: userId ? { [USER_HEADER]: userId } : {},
  }));
}

type ChatReply = { conversationId: string; reply: string; taskIds: string[]; runIds: string[] };
async function chatReply(response: Response, status = 200): Promise<ChatReply> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return await response.json() as ChatReply;
}

test("POST and GET require middleware's user header", async () => {
  for (const response of [await postRaw("{malformed", ""), await get("")]) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(requests.length, 0);
});

test("rejects malformed JSON, invalid messages and invalid conversation ids", async () => {
  for (const body of ["{", "[]", "null", "{}", '{"message":12}', '{"message":""}', '{"message":"  "}']) {
    assert.equal((await postRaw(body)).status, 400);
  }
  assert.equal((await post({ message: "a".repeat(4001) })).status, 400);
  assert.equal((await post({ message: "hi", conversationId: 123 })).status, 400);
  assert.equal((await post({ message: "hi", conversationId: " " })).status, 400);
  assert.equal((await get(ALICE, "")).status, 400);
  assert.equal(requests.length, 0);
});

test("caps bodies at 16 KB even for streamed requests without content-length", async () => {
  // More than 16 KB in UTF-8, less than 16k JS characters.
  const response = await post({ message: "OK", padding: "界".repeat(5500) });
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  let cancelled = false;
  let chunks = 4;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks-- > 0) controller.enqueue(new Uint8Array(9000).fill(32));
      else controller.close();
    },
    cancel() { cancelled = true; },
  });
  const init = { method: "POST", body: stream, duplex: "half", headers: { [USER_HEADER]: ALICE } };
  assert.equal((await POST(new Request(URL, init))).status, 413);
  assert.equal(cancelled, true);
  assert.equal(requests.length, 0);
});

test("allows exactly 4000 message characters and the exact byte cap", async () => {
  configureFakeProvider();
  replies.push(providerReply("Got it."));
  const raw = JSON.stringify({ message: "a".repeat(4000) }).padEnd(16 * 1024, " ");
  const body = await chatReply(await postRaw(raw));
  assert.equal(body.reply, "Got it.");
  assert.equal(requests[0].messages.at(-1)?.content.length, 4000);
});

test("creates, continues and lists a private conversation with board task and VM run ids", async (t) => {
  configureFakeProvider();
  const manager = new RuntimeManager({ router: null });
  setRuntimeManagerForTesting(manager);
  const start = t.mock.method(manager, "start", () => ({ accepted: true, runId: RUN_ID, queued: false }));
  const list = t.mock.method(manager, "list", () => [{
    runId: RUN_ID, userId: ALICE, status: "running", prompt: "Fix docs", createdAt: 1, lastSeq: 1,
  }]);
  replies.push(
    providerReply('```json\n{"tool":"create_board_task","args":{"title":"Fix docs","description":"Fix the example","dispatch":true}}\n```'),
    providerReply("Created the docs task and started a VM run."),
    providerReply(`\`\`\`json\n{"tool":"get_run_status","args":{"runId":"${RUN_ID}"}}\n\`\`\``),
    providerReply("The VM is still running."),
  );
  const created = await chatReply(await post({ message: "Fix the docs", userId: BOB }));
  assert.ok(created.conversationId);
  const [taskId] = created.taskIds;
  assert.equal(taskId, loadStore().tasks[0].id);
  assert.deepEqual(created.runIds, [RUN_ID]);
  assert.equal(start.mock.callCount(), 1);
  assert.equal(requests[0].model, "fake-board-model");
  const conversationId = created.conversationId;

  const continued = await chatReply(await post({ message: "What's the status?", conversationId }));
  assert.deepEqual(continued, { conversationId, reply: `VM run ${RUN_ID}: running.`, taskIds: [], runIds: [] });
  assert.deepEqual(list.mock.calls.map((call) => call.arguments), [[ALICE]]);
  assert.ok(requests[2].messages.some(({ content }) => content.includes(RUN_ID)));
  assert.match(requests[3].messages.at(-1)?.content ?? "", new RegExp(`${RUN_ID}: running`));
  assert.equal(start.mock.callCount(), 1);

  const detail = await get(ALICE, conversationId);
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("cache-control"), "no-store");
  const { conversation } = await detail.json() as { conversation: BoardAgentConversation };
  assert.equal(conversation.userId, ALICE);
  assert.equal(conversation.messages.length, 6);
  assert.equal(conversation.messages[1].taskId, taskId);
  assert.equal(conversation.messages[1].runId, RUN_ID);
  const listing = await get(ALICE);
  assert.deepEqual(await listing.json(), {
    conversations: [{ id: conversationId, title: "Fix the docs", updatedAt: conversation.updatedAt, messageCount: 6 }],
  });
  assert.deepEqual(await (await get(BOB)).json(), { conversations: [] });
  assert.equal((await get(BOB, conversationId)).status, 404);
  assert.equal((await post({ message: "Hello", conversationId }, BOB)).status, 404);
  assert.equal(requests.length, 4);
});

test("returns the BYOK reply as 503 when no provider is configured", async () => {
  const response = await chatReply(await post({ message: "List my tasks" }), 503);
  assert.equal(response.reply, "No provider is configured. Add your key in Settings (BYOK) before I can run.");
  assert.deepEqual(response.taskIds, []);
  assert.deepEqual(response.runIds, []);
  assert.equal((await get(ALICE, response.conversationId)).status, 200);
  assert.equal(requests.length, 0);
});

test("returns a clean 502 without exposing upstream error details", async () => {
  configureFakeProvider();
  replies.push(Response.json({ error: { message: "upstream diagnostic" } }, { status: 502 }));
  const response = await chatReply(await post({ message: "List my tasks" }), 502);
  assert.match(response.reply, /provider could not respond/);
  assert.doesNotMatch(response.reply, /upstream diagnostic|fake-key/);
});

test("does not overwrite history with concurrent turns on the same conversation", async () => {
  configureFakeProvider();
  replies.push(providerReply("Start."));
  const { conversationId } = await chatReply(await post({ message: "Hello there" }));
  let enter!: () => void;
  let finish!: (response: Response) => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  replies.push(() => { enter(); return pending; });
  const first = post({ message: "First follow-up", conversationId });
  try {
    assert.equal(await Promise.race([entered.then(() => "pending"), first.then(() => "completed")]), "pending");
    const second = await post({ message: "Second follow-up", conversationId });
    assert.equal(second.status, 409);
  } finally {
    finish(providerReply("Done."));
  }
  await chatReply(await first);
  const detail = await (await get(ALICE, conversationId)).json() as { conversation: BoardAgentConversation };
  assert.deepEqual(detail.conversation.messages.map(({ content }) => content), ["Hello there", "Start.", "First follow-up", "Done."]);
});


test("/digest works without BYOK and saves the grounded reply to the caller's conversation", async () => {
  const { conversationId, reply, taskIds, runIds } = await chatReply(await post({ message: "/digest" }));
  assert.match(reply, /Board digest: 0 tasks/);
  assert.match(reply, /Needs review \(0\)/);
  assert.deepEqual(taskIds, []);
  assert.deepEqual(runIds, []);
  assert.equal(requests.length, 0);
  const { conversation } = await (await get(ALICE, conversationId)).json() as { conversation: BoardAgentConversation };
  assert.equal(conversation.messages.at(-1)?.content, reply);
});

test("aborted requests return 499 status", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const req = new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", [USER_HEADER]: ALICE },
    body: JSON.stringify({ message: "Aborting request" }),
    signal: ctrl.signal,
  });
  const res = await POST(req);
  assert.equal(res.status, 499);
  const body = await res.json() as { error: string };
  assert.equal(body.error, "Request aborted.");
});

test("returns 503 when storage fails, but non-storage throw does not report storage-unavailable", async () => {
  // Test real storage failure returns 503 STORAGE_ERROR
  const origRead = fs.readFileSync;
  mock.method(fs, "readFileSync", () => {
    const err = new Error("EACCES permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  });
  try {
    const res = await post({ message: "Storage error request", conversationId: "conv_test" });
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.match(body.error, /Conversation storage is temporarily unavailable/);
  } finally {
    fs.readFileSync = origRead;
  }
});
