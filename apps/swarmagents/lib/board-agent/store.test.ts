import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConversation, listConversations, loadConversations, saveConversation } from "./store";
import type { BoardAgentConversation } from "./types";

let home: string;
let cleanup: () => void;
test.beforeEach(() => {
  const previous = process.env.SWARM_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "board-agent-store-"));
  process.env.SWARM_HOME = home;
  cleanup = () => {
    if (previous === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  };
});
test.afterEach(() => cleanup());

function conversation(userId = "alice", id = "thread-1"): BoardAgentConversation {
  return {
    id, userId, title: "Fix docs", createdAt: 1, updatedAt: 2,
    messages: [{ role: "tool", createdAt: 2, content: "Dispatched", taskId: "task_1", runId: "run_1" }],
  };
}

test("round-trips conversations and updates just one in a private per-user file", () => {
  const first = conversation();
  const second = { ...conversation("alice", "thread-2"), updatedAt: 3 };
  saveConversation("alice", first);
  saveConversation("alice", second);
  assert.deepEqual(listConversations("alice"), [second, first]);

  first.messages.push({ role: "agent", content: "Queued", createdAt: 4 });
  first.updatedAt = 4;
  saveConversation("alice", first);
  assert.deepEqual(listConversations("alice"), [first, second]);
  assert.deepEqual(getConversation("alice", first.id), first);
  assert.equal(getConversation("bob", first.id), undefined);

  const dir = path.join(home, "board-agent");
  assert.deepEqual(fs.readdirSync(dir), ["conversations-alice.json"]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "conversations-alice.json")).mode & 0o777, 0o600);
});

test("recovers from corrupt JSON and ignores invalid or other owners' saved records", () => {
  const dir = path.join(home, "board-agent");
  fs.mkdirSync(dir);
  const file = path.join(dir, "conversations-alice.json");
  fs.writeFileSync(file, '[{"id":');
  assert.deepEqual(loadConversations("alice"), []);
  saveConversation("alice", conversation());
  assert.deepEqual(loadConversations("alice"), [conversation()]);
  fs.writeFileSync(file, JSON.stringify([null, conversation("bob"), { ...conversation(), messages: [null] }]));
  assert.deepEqual(loadConversations("alice"), []);
});

test("does not let a user id escape the store directory or change conversation ownership", () => {
  const userId = "../../outside";
  const conv = conversation(userId);
  assert.throws(() => saveConversation("alice", conv), /owner/);
  saveConversation(userId, conv);
  assert.deepEqual(fs.readdirSync(home), ["board-agent"]);
  assert.deepEqual(loadConversations(userId), [conv]);
  assert.deepEqual(loadConversations("outside"), []);
});

test("an I/O failure isn't treated as corrupt JSON", () => {
  fs.mkdirSync(path.join(home, "board-agent", "conversations-alice.json"), { recursive: true });
  assert.throws(() => saveConversation("alice", conversation()), { code: "EISDIR" });
});
