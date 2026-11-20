import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureStorePaths, getStoragePaths, loadStore, saveStoreAtomic } from "../board/store";
import type { SwarmTask } from "../mcp-types";
import { RuntimeManager, setRuntimeManagerForTesting, type RunSummary } from "../runtime/manager";
import { TelemetryBus } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import { createBoardTask, getBoardDigest, getBoardTask, getRunStatus, listBoardTasks } from "./tools";

let runsDir: string;
let cleanup: () => void;
test.beforeEach(() => {
  const { STORAGE_DIR, DATA_FILE } = getStoragePaths();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-agent-tools-"));
  configureStorePaths(dir, path.join(dir, "swarm_board.json"));
  runsDir = path.join(dir, "runs");
  configureRunsDir(runsDir);
  cleanup = () => {
    setRuntimeManagerForTesting(null);
    configureRunsDir(null);
    configureStorePaths(STORAGE_DIR, DATA_FILE);
    fs.rmSync(dir, { recursive: true, force: true });
  };
});
test.afterEach(() => cleanup());

const TASK = { title: "Update docs", description: "Document the example", constraints: ["Tests only"] };

test("creation defaults omitted difficulty and persists using the existing board schema", async () => {
  const result = await createBoardTask("alice", TASK);
  assert.equal(result.ok, true);
  assert.ok(result.data);
  const { taskId, title } = result.data;
  assert.match(result.summary, new RegExp(taskId));
  const [saved] = loadStore().tasks;
  assert.equal(saved.id, taskId);
  assert.equal(saved.title, title);
  assert.equal(saved.difficulty, "medium");
  assert.equal(saved.status, "open");
  assert.deepEqual(saved.constraints, TASK.constraints);
  assert.equal("runId" in saved, false);
  assert.deepEqual(getBoardTask("alice", taskId).data, saved);
  assert.equal(getBoardTask("alice", "missing").ok, false);
});

test("creation rejects invalid lengths, difficulty and constraints without saving", async () => {
  for (const [patch, field] of [
    [{ title: " " }, "title"],
    [{ title: "x".repeat(201) }, "title"],
    [{ description: "x".repeat(8001) }, "description"],
    [{ difficulty: null }, "difficulty"],
    [{ difficulty: "impossible" }, "difficulty"],
    [{ constraints: [1] }, "constraints"],
    [{ constraints: ["x".repeat(501)] }, "constraints"],
  ] as const) {
    const result = await createBoardTask("alice", { ...TASK, ...patch });
    assert.equal(result.ok, false);
    assert.match(result.summary, new RegExp(field));
  }
  assert.deepEqual(loadStore().tasks, []);
});

test("listing filters by status and shows at most the newest 20 compact task summaries", async () => {
  const store = loadStore();
  store.tasks = Array.from({ length: 24 }, (_, n): SwarmTask => ({
    ...TASK, id: `task_${n}`, difficulty: "easy", minElo: 1200, createdAt: n, updatedAt: n,
    status: n === 23 ? "in_review" : "open",
    ...(n === 23 ? { claimedBy: "worker", prUrl: "https://example.test/pr/23" } : {}),
  }));
  await saveStoreAtomic(store);
  const all = listBoardTasks("alice", {});
  assert.equal(all.ok, true);
  assert.equal(all.data?.length, 20);
  assert.equal(all.data?.[0].id, "task_23");
  assert.match(all.summary, /20 of 24/);
  assert.doesNotMatch(all.summary, /Document the example/);
  const review = listBoardTasks("alice", { status: "in_review" });
  assert.deepEqual(review.data, [{
    id: "task_23", title: TASK.title, status: "in_review", claimedBy: "worker", prUrl: "https://example.test/pr/23",
  }]);
  assert.match(review.summary, /worker.*https:\/\/example.test\/pr\/23/);
  assert.equal(listBoardTasks("alice", { status: "invalid" }).ok, false);
});

test("run status is caller-scoped and includes the terminal reply when persisted", (t) => {
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  const manager = new RuntimeManager({ router: null, bus });
  const run: RunSummary = {
    runId: "run_fixture", userId: "alice", status: "finished", prompt: "Update docs", lastSeq: 3, createdAt: 1, exitCode: 0,
  };
  bus.publish(run.runId, { type: "run.created", data: { userId: "alice", prompt: run.prompt } });
  bus.publish(run.runId, { type: "assistant.text", data: { text: "Docs updated. PR: https://example.test/pr/42" } });
  bus.publish(run.runId, { type: "run.finished", data: { exitCode: 0 } });
  const list = t.mock.method(manager, "list", (userId: string) => userId === "alice" ? [run] : []);
  setRuntimeManagerForTesting(manager);
  const result = getRunStatus("alice", run.runId);
  assert.deepEqual(result.data, { runId: run.runId, status: "finished" });
  assert.match(result.summary, /Exit code: 0/);
  assert.match(result.summary, /Docs updated.*https:\/\/example.test\/pr\/42/);
  assert.deepEqual(getRunStatus("bob", run.runId), { ok: false, summary: "VM run not found." });
  assert.deepEqual(list.mock.calls.map((call) => call.arguments), [["alice"], ["bob"]]);
});


test("digest reports ready, stale, review and completed work without writing the board", async (t) => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const task = (id: string, status: SwarmTask["status"], updatedAt: number): SwarmTask => ({
    ...TASK, id, status, updatedAt, createdAt: updatedAt, difficulty: "easy", minElo: 1200,
  });
  const current = task("task_active", "claimed", now);
  const expired = {
    ...task("task_expired", "claimed", 1), claimedBy: "old-worker", prUrl: "https://example.test/pull/33",
  };
  const store = loadStore();
  store.tasks = [
    current, expired, task("task_blocked", "blocked", now), task("task_open", "open", now),
    task("task_done", "completed", now),
    ...Array.from({ length: 7 }, (_, i) => task(`task_review_${i}`, "in_review", i + 2)).reverse(),
  ];
  await saveStoreAtomic(store);
  const original = fs.readFileSync(getStoragePaths().DATA_FILE, "utf-8");
  const digest = getBoardDigest();
  assert.equal(digest.ok, true);
  assert.match(digest.summary, /Open: 2 · Active claims: 1/);
  assert.match(digest.summary, /Needs review \(7\)\ntask_review_0/);
  assert.match(digest.summary, /and 2 more/);
  assert.match(digest.summary, /Expired claims \(ready to reclaim\) \(1\)\ntask_expired/);
  assert.match(digest.summary, /Blocked \(1\)\ntask_blocked/);
  assert.match(digest.summary, /Git merge not verified\) \(1\)\ntask_done/);
  assert.doesNotMatch(digest.summary, /old-worker|pull\/33|task_review_6/);
  assert.equal(getBoardTask("alice", expired.id).data?.status, "open");
  assert.deepEqual(listBoardTasks("alice", { status: "claimed" }).data?.map(({ id }) => id), [current.id]);
  assert.equal(fs.readFileSync(getStoragePaths().DATA_FILE, "utf-8"), original);
});
