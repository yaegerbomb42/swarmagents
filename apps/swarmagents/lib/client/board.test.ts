/**
 * The board client, tested against the real SwarmBoard route handlers (no
 * mocks): every call below goes through GET/POST in
 * app/api/mcp/swarm-board/route.ts and a board file in a temp directory.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../../app/api/mcp/swarm-board/route";
import { configureStorePaths } from "../board/store";
import type { SwarmTask } from "../mcp-types";
import {
  BOARD_ENDPOINT,
  TASK_TITLE_MAX,
  agentNameForUser,
  askBoard,
  buildTaskPrompt,
  claimBoardTask,
  createBoardTask,
  displayTaskTitle,
  extractBranchAndPr,
  fetchBoard,
  groupBoardTasks,
  isSafeHttpUrl,
  linkTaskRun,
  normalizeTaskTitle,
  parseBoardSnapshot,
  prLabel,
  submitBoardTask,
  taskFromMessage,
  taskLinkForRun,
  type TaskRunLinks,
} from "./board";

/** A fetch that hands each request to the real route handlers. */
const routeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  assert.equal(url, BOARD_ENDPOINT, "the client only talks to the board route");
  const method = init?.method ?? "GET";
  const req = new NextRequest(`http://localhost${url}`, {
    method,
    headers: new Headers(init?.headers),
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
  });
  return method === "POST" ? POST(req) : GET(req);
}) as typeof fetch;

function useTempBoard(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-client-"));
  configureStorePaths(dir, path.join(dir, "swarm_board.json"));
}

function task(overrides: Partial<SwarmTask>): SwarmTask {
  return {
    id: "task_1",
    title: "A task",
    description: "A task",
    difficulty: "medium",
    minElo: 1400,
    constraints: [],
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("an empty board loads with zero counts", async () => {
  useTempBoard();
  const board = await fetchBoard({ fetchImpl: routeFetch });
  assert.equal(board.ok, true);
  if (!board.ok) return;
  assert.deepEqual(board.value.tasks, []);
  assert.equal(board.value.counts.open, 0);
  assert.equal(board.value.writable, true);
});

test("a task goes from request to claimed to in review through the real board", async () => {
  useTempBoard();
  const agentName = agentNameForUser({ id: "u_1", email: "alice@example.com" });

  // Create: the first line is the title, the whole message the description.
  const draft = taskFromMessage("Fix the login redirect\nUsers land on a blank page after sign in.");
  assert.ok(draft);
  const created = await createBoardTask(draft!, routeFetch);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.title, "Fix the login redirect");
  assert.equal(created.value.description, "Fix the login redirect\nUsers land on a blank page after sign in.");
  assert.equal(created.value.status, "open");

  let board = await fetchBoard({ fetchImpl: routeFetch });
  assert.equal(board.ok && board.value.tasks.length, 1);
  assert.equal(board.ok && board.value.counts.open, 1);

  // Claim: the board records who took it.
  const claimed = await claimBoardTask({ taskId: created.value.id, agentName }, routeFetch);
  assert.equal(claimed.ok, true);
  if (!claimed.ok) return;
  assert.equal(claimed.value.status, "claimed");
  assert.equal(claimed.value.claimedBy, "alice@example.com (VM)");

  // Submit: branch, summary and PR land on the task, which moves to review.
  const submitted = await submitBoardTask(
    {
      taskId: created.value.id,
      agentName,
      gitBranch: " fix/login-redirect ",
      summary: "Redirect now goes to the dashboard. Verified with the login e2e test.",
      prUrl: "https://github.com/acme/app/pull/128",
    },
    routeFetch,
  );
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  assert.equal(submitted.value.status, "in_review");
  assert.equal(submitted.value.gitBranch, "fix/login-redirect");
  assert.equal(submitted.value.prUrl, "https://github.com/acme/app/pull/128");
  assert.match(submitted.value.resultSummary ?? "", /Redirect now goes to the dashboard/);

  board = await fetchBoard({ fetchImpl: routeFetch });
  assert.equal(board.ok, true);
  if (!board.ok) return;
  assert.equal(board.value.counts.open, 0);
  assert.equal(board.value.counts.in_review, 1);
  assert.deepEqual(
    groupBoardTasks(board.value.tasks).map((group) => [group.label, group.tasks.length]),
    [["In review", 1]],
  );
});

test("the board's refusals come back as readable errors, not exceptions", async () => {
  useTempBoard();

  const missing = await claimBoardTask({ taskId: "task_does_not_exist", agentName: "alice (VM)" }, routeFetch);
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.error.length > 0);

  const draft = taskFromMessage("Write the changelog");
  assert.ok(draft);
  const created = await createBoardTask(draft!, routeFetch);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await claimBoardTask({ taskId: created.value.id, agentName: "alice (VM)" }, routeFetch);

  // Someone who did not claim the task cannot submit it.
  const stranger = await submitBoardTask(
    { taskId: created.value.id, agentName: "mallory (VM)", gitBranch: "x", summary: "mine now" },
    routeFetch,
  );
  assert.equal(stranger.ok, false);

  // A second claim on a claimed task is refused.
  const again = await claimBoardTask({ taskId: created.value.id, agentName: "bob (VM)" }, routeFetch);
  assert.equal(again.ok, false);
});

test("askBoard posts to the board-agent chat and returns a filed task", async () => {
  const filed = task({ id: "task_chat", title: "Filed by the agent" });
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/board-agent/chat") {
      return new Response(JSON.stringify({ reply: "Filed it.", conversationId: "conv_1", taskIds: ["task_chat"], runIds: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ tasks: [filed], counts: { tasks: 1, open: 1, claimed: 0, in_review: 0, completed: 0 }, health: { writable: true } }));
  }) as typeof fetch;
  const result = await askBoard("file a task", { fetchImpl });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.reply, "Filed it.");
  assert.equal(result.value.conversationId, "conv_1");
  assert.equal(result.value.task?.id, "task_chat");
  assert.deepEqual(calls, ["POST /api/board-agent/chat", "GET /api/mcp/swarm-board"]);
});

test("an empty request never reaches the board", async () => {
  let called = false;
  const result = await askBoard("   \n ", {
    fetchImpl: (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch,
  });
  assert.deepEqual(result, { ok: false, error: "Describe the task first.", retryable: false });
  assert.equal(called, false);
});

test("a network failure is retryable; a storage outage says so", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  assert.deepEqual(await fetchBoard({ fetchImpl: offline }), { ok: false, error: "fetch failed", retryable: true });

  const outage = (async () =>
    new Response(JSON.stringify({ error: { message: "Board storage is unavailable." }, retryable: true }), {
      status: 503,
    })) as typeof fetch;
  assert.deepEqual(await claimBoardTask({ taskId: "t", agentName: "a" }, outage), {
    ok: false,
    error: "Board storage is unavailable.",
    retryable: true,
  });
});

test("taskFromMessage keeps everything the user typed", () => {
  assert.equal(taskFromMessage("   "), null);
  assert.deepEqual(taskFromMessage("  Add dark mode  "), {
    title: "Add dark mode",
    description: "Add dark mode",
    difficulty: "medium",
  });
  const long = taskFromMessage("x".repeat(TASK_TITLE_MAX + 20));
  assert.equal(long?.title.length, TASK_TITLE_MAX);
  assert.ok(long?.title.endsWith("…"));
  assert.equal(long?.description.length, TASK_TITLE_MAX + 20);
});

test("parseBoardSnapshot tolerates a partial body and reads the read-only flag", () => {
  assert.equal(parseBoardSnapshot(null), null);
  assert.equal(parseBoardSnapshot({ tasks: "nope" }), null);
  const snapshot = parseBoardSnapshot({ tasks: [task({}), { id: 7 }], health: { writable: false } });
  assert.equal(snapshot?.tasks.length, 1, "a malformed task is dropped, not rendered");
  assert.equal(snapshot?.counts.tasks, 1);
  assert.equal(snapshot?.writable, false);
});

test("groups follow the reading order and drop empty statuses", () => {
  const groups = groupBoardTasks([
    task({ id: "a", title: "Ship the release", status: "completed", updatedAt: 5 }),
    task({ id: "b", title: "Fix the login redirect", status: "open", updatedAt: 1 }),
    task({ id: "c", title: "Add dark mode", status: "open", updatedAt: 9 }),
    task({ id: "d", title: "Write the changelog", status: "claimed", updatedAt: 3 }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.status, group.tasks.map((t) => t.id)]),
    [
      ["open", ["c", "b"]],
      ["claimed", ["d"]],
      ["completed", ["a"]],
    ],
  );
});

test("the board shows one row per title, preferring the copy furthest along", () => {
  const groups = groupBoardTasks([
    task({ id: "dup_open", title: "[Router] Automatic per-step model routing", status: "open", updatedAt: 9 }),
    task({ id: "dup_review", title: "[p2] automatic per-step model routing", status: "in_review", updatedAt: 1 }),
    task({ id: "dup_done", title: "Automatic   per-step model routing", status: "completed", updatedAt: 2 }),
    task({ id: "other", title: "Track tool I/O", status: "open", updatedAt: 3 }),
    task({ id: "other_2", title: "[Cost] Track tool I/O", status: "open", updatedAt: 8 }),
  ]);
  const completed = groups.find((group) => group.status === "completed");
  assert.deepEqual(
    completed?.tasks.map((t) => t.id),
    ["dup_done"],
    "the furthest-along copy stands for all three filings",
  );
  assert.equal(completed?.duplicateCounts["dup_done"], 3);
  const open = groups.find((group) => group.status === "open");
  assert.deepEqual(
    open?.tasks.map((t) => t.id),
    ["other_2"],
    "the same-status pair collapses to the most recently active copy",
  );
  assert.equal(open?.duplicateCounts["other_2"], 2);
  assert.equal(groups.find((group) => group.status === "in_review"), undefined);
  assert.equal(groups.flatMap((group) => group.tasks).length, 2, "one row per title across the whole board");
});

test("display titles drop leading bracket tags and normalize for duplicates", () => {
  assert.equal(displayTaskTitle("[p2] Fix the login redirect"), "Fix the login redirect");
  assert.equal(displayTaskTitle("[fix] [auth] Fix the login redirect"), "Fix the login redirect");
  assert.equal(displayTaskTitle("Fix the login redirect"), "Fix the login redirect");
  assert.equal(displayTaskTitle("[p2]"), "[p2]", "a title that is only a tag keeps its text");
  assert.equal(normalizeTaskTitle("[Router]  Automatic   per-step model routing"), "automatic per-step model routing");
  assert.equal(normalizeTaskTitle("AUTOMATIC PER-STEP MODEL ROUTING"), "automatic per-step model routing");
  assert.equal(normalizeTaskTitle("Track tool I/O"), "track tool i/o");
});

test("only http(s) links are links, and a pull URL gets a short label", () => {
  assert.equal(isSafeHttpUrl("https://github.com/acme/app/pull/128"), true);
  assert.equal(isSafeHttpUrl("javascript:alert(1)"), false);
  assert.equal(isSafeHttpUrl("https://example.com/a b"), false);
  assert.equal(isSafeHttpUrl(undefined), false);
  assert.equal(prLabel("https://github.com/acme/app/pull/128"), "PR #128");
  assert.equal(prLabel("https://github.com/acme/app/pull/128/files"), "PR #128");
  assert.equal(prLabel("https://example.com/changes/42"), "Pull request");
});

test("the agent claims under the signed-in user's name", () => {
  assert.equal(agentNameForUser({ id: "u_1", email: "alice@example.com" }), "alice@example.com (VM)");
  assert.equal(agentNameForUser({ id: "u_1", email: null }), "u_1 (VM)");
  assert.equal(agentNameForUser(null), "local (VM)");
});

test("a task's prompt carries the task and asks for a reply the board can use", () => {
  const prompt = buildTaskPrompt(
    task({ id: "task_9", title: "Fix the login redirect", description: "Blank page after sign in.", constraints: ["No new dependencies"] }),
  );
  assert.match(prompt, /^Work on this SwarmBoard task \(task_9\)\./);
  assert.match(prompt, /Task: Fix the login redirect/);
  assert.match(prompt, /Blank page after sign in\./);
  assert.match(prompt, /Constraints:\n- No new dependencies/);
  assert.match(prompt, /Branch: <name>/);

  // A description that only repeats the title is not sent twice.
  const short = buildTaskPrompt(task({ title: "Add dark mode", description: "Add dark mode" }));
  assert.equal(short.split("Add dark mode").length - 1, 1);
});

test("the branch and PR are read back out of the agent's reply", () => {
  const reply = "Fixed the redirect and added a test.\n\nBranch: fix/login-redirect\nPR: https://github.com/acme/app/pull/128";
  assert.deepEqual(extractBranchAndPr(reply), {
    branch: "fix/login-redirect",
    prUrl: "https://github.com/acme/app/pull/128",
  });
  assert.deepEqual(extractBranchAndPr("Git branch: `feat/x`"), { branch: "feat/x" });
  assert.deepEqual(extractBranchAndPr("I looked at the branch: it is fine, mostly."), {});
  assert.deepEqual(extractBranchAndPr(undefined), {});
});

test("a task remembers the run started for it, and a run finds its task", () => {
  let links: TaskRunLinks = {};
  links = linkTaskRun(links, { taskId: "t1", title: "One", runId: "run_1", agentName: "a (VM)", startedAt: 1 });
  links = linkTaskRun(links, { taskId: "t1", title: "One", runId: "run_2", agentName: "a (VM)", startedAt: 2 });
  assert.equal(links.t1.runId, "run_2", "running a task again replaces its link");
  assert.equal(taskLinkForRun(links, "run_2")?.taskId, "t1");
  assert.equal(taskLinkForRun(links, "run_1"), undefined);
  assert.equal(taskLinkForRun(links, undefined), undefined);

  for (let i = 0; i < 250; i += 1) {
    links = linkTaskRun(links, { taskId: `bulk_${i}`, title: "x", runId: `r_${i}`, agentName: "a", startedAt: 100 + i });
  }
  assert.equal(Object.keys(links).length, 200, "old links are dropped past the cap");
  assert.equal(links.t1, undefined);
  assert.ok(links.bulk_249);
});
