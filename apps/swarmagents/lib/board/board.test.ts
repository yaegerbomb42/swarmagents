import test from "node:test";
import assert from "node:assert/strict";
import {
  handleCreateTask,
  handlePollTasks,
  handleClaimTask,
  handleSubmitTaskWork,
  handleSubmitProposal,
  handleJudgeProposal,
  handleListProposals,
  handleReviewAndMergeTask,
  handleInitialize,
  handlePing,
  handleToolsList,
  assertTransition,
} from "./handlers";
import type { BoardStore } from "./types";
import type { SwarmTask, TaskProposal } from "@/lib/mcp-types";
import { configureStorePaths, getStoragePaths, loadStore, withLockedStore, saveStoreAtomic } from "./store";
import { validateGitBranch } from "./validation";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The remote branch check defaults on; handler tests use fake branches
// that were never pushed, so disable it here (the check itself is
// covered by git-remote.test.ts with a stubbed git).
process.env.SWARM_GIT_REMOTE_CHECK = "0";

function emptyStore(): BoardStore {
  return { tasks: [], proposals: [], messages: [] };
}

function makeTask(overrides: Partial<SwarmTask> = {}): SwarmTask {
  const now = Date.now();
  return {
    id: "t1",
    title: "T",
    description: "D",
    difficulty: "easy",
    minElo: 1200,
    constraints: [],
    status: "open",
    history: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function payload(result: { result: { content: Array<{ text: string }> } }): {
  message: string;
  task: SwarmTask;
} {
  return JSON.parse(result.result.content[0].text);
}

test("handleInitialize returns MCP initialize result", () => {
  const res = handleInitialize(1);
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2024-11-05");
});

test("handlePing returns empty result", () => {
  const res = handlePing(2);
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.id, 2);
  assert.deepEqual(res.result, {});
});

test("handleCreateTask validates missing title", async () => {
  const store = emptyStore();
  const result = await handleCreateTask(store, { description: "d", difficulty: "easy" });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /title/);
});

test("handleCreateTask validates description too long", async () => {
  const store = emptyStore();
  const result = await handleCreateTask(store, { title: "t", description: "d".repeat(8001), difficulty: "easy" });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /description/);
});

test("handleCreateTask creates a task", async () => {
  const store = emptyStore();
  const result = await handleCreateTask(store, { title: "Test", description: "Desc", difficulty: "hard" });
  assert.ok("result" in result);
  const parsed = JSON.parse(result.result.content[0].text);
  assert.equal(parsed.message, "Task created");
  assert.equal(parsed.task.difficulty, "hard");
  assert.equal(store.tasks.length, 1);
});

test("handleClaimTask rejects non-open task", async () => {
  const store = emptyStore();
  store.tasks.push({
    id: "t1",
    title: "T",
    description: "D",
    difficulty: "easy",
    minElo: 1200,
    constraints: [],
    status: "claimed",
    createdAt: 0,
    updatedAt: Date.now(),
  });
  const result = await handleClaimTask(store, { taskId: "t1", agentName: "A", workerElo: 1300 });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /not open/);
});

test("handleClaimTask claims open task", async () => {
  const store = emptyStore();
  store.tasks.push({
    id: "t1",
    title: "T",
    description: "D",
    difficulty: "easy",
    minElo: 1200,
    constraints: [],
    status: "open",
    createdAt: 0,
    updatedAt: 0,
  });
  const result = await handleClaimTask(store, { taskId: "t1", agentName: "A", workerElo: 1300 });
  assert.ok("result" in result);
  const parsed = JSON.parse(result.result.content[0].text);
  assert.equal(parsed.task.status, "claimed");
  assert.equal(parsed.task.claimedBy, "A");
});

test("handlePollTasks filters and sorts", () => {
  const store = emptyStore();
  store.tasks.push(
    { id: "t1", title: "A", description: "D", difficulty: "easy", minElo: 1200, constraints: [], status: "open", createdAt: 0, updatedAt: 0 },
    { id: "t2", title: "B", description: "D", difficulty: "hard", minElo: 1600, constraints: [], status: "open", createdAt: 0, updatedAt: 0 }
  );
  const result = handlePollTasks(store, { workerElo: 1400, status: "open" });
  assert.ok("result" in result);
  const parsed = JSON.parse(result.result.content[0].text);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.tasks[0].id, "t1"); // closer elo diff
});

test("handleSubmitTaskWork requires summary", async () => {
  const store = emptyStore();
  const result = await handleSubmitTaskWork(store, { taskId: "x", gitBranch: "feat/x" });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
});

test("handleReviewAndMergeTask rejects missing feedback", async () => {
  const store = emptyStore();
  const result = await handleReviewAndMergeTask(store, { taskId: "x", approved: true });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /feedback/);
});

test("handleSubmitProposal validates difficulty enum", async () => {
  const store = emptyStore();
  const result = await handleSubmitProposal(store, { proposedBy: "A", title: "T", problem: "P", proposedSolution: "S", suggestedDifficulty: "extreme" });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /suggestedDifficulty/);
});

test("list_proposals round-trip: submit, list, judge, and see status change", async () => {
  const store = emptyStore();
  const submitted = await handleSubmitProposal(store, {
    proposedBy: "scout-1",
    title: "Improve docs",
    problem: "Docs are unclear",
    proposedSolution: "Rewrite README section",
    suggestedDifficulty: "easy",
  });
  assert.ok("result" in submitted);
  const submittedPayload = JSON.parse(submitted.result.content[0].text);
  assert.equal(submittedPayload.proposal.status, "pending");
  const proposalId = submittedPayload.proposal.id as string;

  const listed = handleListProposals(store, {});
  assert.ok("result" in listed);
  const listedPayload = JSON.parse(listed.result.content[0].text);
  assert.equal(listedPayload.count, 1);
  assert.equal(listedPayload.proposals[0].id, proposalId);
  assert.equal(listedPayload.proposals[0].status, "pending");

  const pendingOnly = handleListProposals(store, { status: "pending" });
  assert.ok("result" in pendingOnly);
  assert.equal(JSON.parse(pendingOnly.result.content[0].text).count, 1);

  const judged = await handleJudgeProposal(store, { proposalId, approved: true, feedback: "Looks good" });
  assert.ok("result" in judged);
  const judgedPayload = JSON.parse(judged.result.content[0].text);
  assert.equal(judgedPayload.proposal.status, "approved");

  const after = handleListProposals(store, { status: "approved" });
  assert.ok("result" in after);
  const afterPayload = JSON.parse(after.result.content[0].text);
  assert.equal(afterPayload.count, 1);
  assert.equal(afterPayload.proposals[0].id, proposalId);
  assert.equal(afterPayload.proposals[0].status, "approved");

  const pendingAfter = handleListProposals(store, { status: "pending" });
  assert.ok("result" in pendingAfter);
  assert.equal(JSON.parse(pendingAfter.result.content[0].text).count, 0);
});

test("withLockedStore prevents concurrent double claim", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-board-test-"));
  const dataFile = path.join(tmpDir, "swarm_board.json");
  configureStorePaths(tmpDir, dataFile);

  const seed: BoardStore = {
    tasks: [{
      id: "t1",
      title: "T",
      description: "D",
      difficulty: "easy",
      minElo: 1200,
      constraints: [],
      status: "open",
      createdAt: 0,
      updatedAt: 0,
    }],
    proposals: [],
    messages: [],
  };
  await saveStoreAtomic(seed);

  const results = await Promise.all([
    withLockedStore((s) => handleClaimTask(s, { taskId: "t1", agentName: "A1", workerElo: 1300 })),
    withLockedStore((s) => handleClaimTask(s, { taskId: "t1", agentName: "A2", workerElo: 1300 })),
  ]);

  const successes = results.filter((r) => "result" in r);
  const failures = results.filter((r) => "error" in r);
  assert.equal(successes.length, 1, "only one claim should succeed");
  assert.equal(failures.length, 1, "one claim should fail");
  assert.equal(failures[0].error.code, -32602, "failure should be invalid params because task not open");

  // cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
   Transition guards (bug 21): ownership, state machine, and audit history
──────────────────────────────────────────────────────────────────────────── */

test("submit_task_work requires agentName with a migration-friendly error", async () => {
  const store = emptyStore();
  store.tasks.push(makeTask({ status: "claimed", claimedBy: "agent-a" }));
  const result = await handleSubmitTaskWork(store, {
    taskId: "t1",
    gitBranch: "feat/x",
    summary: "done",
  });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /agentName is required/);
  // No mutation on validation failure.
  assert.equal(store.tasks[0].status, "claimed");
  assert.equal(store.tasks[0].gitBranch, undefined);
});

test("submit_task_work rejects a different agent and never overwrites the owner's work", async () => {
  const store = emptyStore();
  store.tasks.push(
    makeTask({
      status: "claimed",
      claimedBy: "agent-a",
      history: [{ from: "open", to: "claimed", actor: "agent-a", at: 1 }],
    })
  );
  const result = await handleSubmitTaskWork(store, {
    taskId: "t1",
    agentName: "agent-b",
    gitBranch: "feat/hijack",
    prUrl: "https://example.com/pr/9",
    summary: "stolen",
  });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /claimed by agent-a/);
  const task = store.tasks[0];
  assert.equal(task.status, "claimed");
  assert.equal(task.claimedBy, "agent-a");
  assert.equal(task.gitBranch, undefined);
  assert.equal(task.prUrl, undefined);
  assert.equal(task.resultSummary, undefined);
  assert.equal(task.history?.length, 1);
});

test("submit_task_work rejects resubmitting a completed task", async () => {
  const store = emptyStore();
  store.tasks.push(makeTask({ status: "completed", claimedBy: "agent-a" }));
  const result = await handleSubmitTaskWork(store, {
    taskId: "t1",
    agentName: "agent-a",
    gitBranch: "feat/again",
    summary: "again",
  });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /cannot be submitted from status completed/);
  assert.equal(store.tasks[0].status, "completed");
});

test("submit_task_work happy path: owner moves claimed → in_review and appends history", async () => {
  const store = emptyStore();
  store.tasks.push(
    makeTask({
      status: "claimed",
      claimedBy: "agent-a",
      history: [{ from: "open", to: "claimed", actor: "agent-a", at: 1 }],
    })
  );
  const result = await handleSubmitTaskWork(store, {
    taskId: "t1",
    agentName: "agent-a",
    gitBranch: "feat/x",
    prUrl: "https://example.com/pr/1",
    summary: "all tests pass",
  });
  assert.ok("result" in result);
  const parsed = JSON.parse(result.result.content[0].text) as { task: SwarmTask };
  assert.equal(parsed.task.status, "in_review");
  assert.equal(parsed.task.gitBranch, "feat/x");
  assert.equal(parsed.task.prUrl, "https://example.com/pr/1");
  assert.deepEqual(
    parsed.task.history?.map((h) => [h.from, h.to, h.actor]),
    [
      ["open", "claimed", "agent-a"],
      ["claimed", "in_review", "agent-a"],
    ]
  );
});

test("review_and_merge_task rejects a task that is not in_review", async () => {
  for (const status of ["open", "claimed", "completed", "blocked"] as const) {
    const store = emptyStore();
    store.tasks.push(makeTask({ status, claimedBy: status === "open" ? undefined : "agent-a" }));
    const result = await handleReviewAndMergeTask(store, {
      taskId: "t1",
      approved: true,
      feedback: "lgtm",
    });
    assert.ok("error" in result, `status ${status} should be rejected`);
    assert.equal(result.error.code, -32602);
    assert.match(result.error.message, /only in_review/);
    assert.equal(store.tasks[0].status, status);
  }
});

test("review_and_merge_task rejects a never-claimed task (cannot approve to completed)", async () => {
  const store = emptyStore();
  store.tasks.push(makeTask({ status: "open" }));
  const result = await handleReviewAndMergeTask(store, {
    taskId: "t1",
    approved: true,
    feedback: "lgtm",
    reviewer: "orchestrator-x",
  });
  assert.ok("error" in result);
  assert.equal(store.tasks[0].status, "open");
  assert.equal(store.tasks[0].reviewedBy, undefined);
});

test("review_and_merge_task approves an in_review task and records reviewer + history", async () => {
  const store = emptyStore();
  store.tasks.push(
    makeTask({
      status: "in_review",
      claimedBy: "agent-a",
      history: [{ from: "claimed", to: "in_review", actor: "agent-a", at: 1 }],
    })
  );
  const before = Date.now();
  const result = await handleReviewAndMergeTask(store, {
    taskId: "t1",
    approved: true,
    feedback: "ship it",
    reviewer: "orchestrator-x",
  });
  assert.ok("result" in result);
  const parsed = JSON.parse(result.result.content[0].text) as { task: SwarmTask };
  assert.equal(parsed.task.status, "completed");
  assert.equal(parsed.task.claimedBy, "agent-a");
  assert.equal(parsed.task.reviewedBy, "orchestrator-x");
  assert.ok((parsed.task.reviewedAt ?? 0) >= before);
  const last = parsed.task.history?.at(-1);
  assert.deepEqual(
    { from: last?.from, to: last?.to, actor: last?.actor },
    { from: "in_review", to: "completed", actor: "orchestrator-x" }
  );
});

test("review_and_merge_task rejection returns an owned task to claimed and allows resubmission", async () => {
  const store = emptyStore();
  store.tasks.push(
    makeTask({
      status: "in_review",
      claimedBy: "agent-a",
      gitBranch: "feat/x",
      resultSummary: "v1",
    })
  );
  const review = await handleReviewAndMergeTask(store, {
    taskId: "t1",
    approved: false,
    feedback: "add tests",
  });
  assert.ok("result" in review);
  assert.equal(store.tasks[0].status, "claimed");
  assert.equal(store.tasks[0].claimedBy, "agent-a");
  assert.equal(store.tasks[0].reviewedBy, "orchestrator");
  assert.deepEqual(
    store.tasks[0].history?.map((h) => [h.from, h.to]),
    [["in_review", "claimed"]]
  );

  // The same agent can fix and resubmit from claimed.
  const submit = await handleSubmitTaskWork(store, {
    taskId: "t1",
    agentName: "agent-a",
    gitBranch: "feat/x",
    summary: "v2 with tests",
  });
  assert.ok("result" in submit);
  assert.equal(store.tasks[0].status, "in_review");
  assert.equal(store.tasks[0].history?.at(-1)?.to, "in_review");
});

test("review_and_merge_task rejection returns a legacy unowned task to open", async () => {
  const store = emptyStore();
  store.tasks.push(makeTask({ status: "in_review" }));
  const result = await handleReviewAndMergeTask(store, {
    taskId: "t1",
    approved: false,
    feedback: "no owner",
  });
  assert.ok("result" in result);
  assert.equal(store.tasks[0].status, "open");
  assert.equal(store.tasks[0].history?.at(-1)?.to, "open");
});

test("create → claim → submit → review happy path produces a complete audit trail visible in poll", async () => {
  const store = emptyStore();
  const created = await handleCreateTask(store, { title: "Test", description: "Desc", difficulty: "easy" });
  assert.ok("result" in created);
  const taskId = payload(created).task.id;

  assert.ok("result" in (await handleClaimTask(store, { taskId, agentName: "agent-a", workerElo: 1300 })));
  assert.ok(
    "result" in
      (await handleSubmitTaskWork(store, {
        taskId,
        agentName: "agent-a",
        gitBranch: "feat/x",
        summary: "ready",
      }))
  );
  assert.ok(
    "result" in
      (await handleReviewAndMergeTask(store, {
        taskId,
        approved: true,
        feedback: "lgtm",
        reviewer: "orchestrator",
      }))
  );

  const polled = handlePollTasks(store, { status: "completed" });
  assert.ok("result" in polled);
  const body = JSON.parse(polled.result.content[0].text) as {
    tasks: Array<{ status: string; history: Array<{ from: string; to: string; actor: string; at: number }> }>;
  };
  assert.equal(body.tasks.length, 1);
  assert.deepEqual(
    body.tasks[0].history.map((h) => [h.from, h.to, h.actor]),
    [
      ["none", "open", "orchestrator"],
      ["open", "claimed", "agent-a"],
      ["claimed", "in_review", "agent-a"],
      ["in_review", "completed", "orchestrator"],
    ]
  );
  assert.ok(body.tasks[0].history.every((h) => typeof h.at === "number"));
});

test("transition guards run under the write lock: concurrent submits/reviews cannot double-apply", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-board-guard-"));
  const dataFile = path.join(tmpDir, "swarm_board.json");
  configureStorePaths(tmpDir, dataFile);

  await saveStoreAtomic({
    tasks: [makeTask({ status: "claimed", claimedBy: "agent-a" })],
    proposals: [],
    messages: [],
  });

  const submits = await Promise.all([
    withLockedStore((s) =>
      handleSubmitTaskWork(s, { taskId: "t1", agentName: "agent-a", gitBranch: "feat/a", summary: "a" })
    ),
    withLockedStore((s) =>
      handleSubmitTaskWork(s, { taskId: "t1", agentName: "agent-b", gitBranch: "feat/b", summary: "b" })
    ),
  ]);
  assert.equal(submits.filter((r) => "result" in r).length, 1);
  assert.equal(submits.filter((r) => "error" in r).length, 1);
  const afterSubmit = loadStore().tasks[0];
  assert.equal(afterSubmit.status, "in_review");
  assert.equal(afterSubmit.gitBranch, "feat/a");

  const reviews = await Promise.all([
    withLockedStore((s) =>
      handleReviewAndMergeTask(s, { taskId: "t1", approved: true, feedback: "one", reviewer: "r1" })
    ),
    withLockedStore((s) =>
      handleReviewAndMergeTask(s, { taskId: "t1", approved: false, feedback: "two", reviewer: "r2" })
    ),
  ]);
  assert.equal(reviews.filter((r) => "result" in r).length, 1);
  assert.equal(reviews.filter((r) => "error" in r).length, 1);
  const afterReview = loadStore().tasks[0];
  // Exactly one decision landed; the second saw a non-in_review status.
  assert.ok(["completed", "claimed"].includes(afterReview.status));
  assert.equal(afterReview.history?.filter((h) => h.from === "in_review").length, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ────────────────────────────────────────────────────────────────────────────
   Proposal judgement (bug 22): one decision per pending proposal + audit log
──────────────────────────────────────────────────────────────────────────── */

function makeProposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    id: "prop_1",
    proposedBy: "scout-1",
    title: "Improve docs",
    problem: "Docs are unclear",
    proposedSolution: "Rewrite the README section",
    suggestedDifficulty: "easy",
    status: "pending",
    createdAt: 0,
    ...overrides,
  };
}

test("assertTransition encodes the task and proposal state machines", () => {
  assert.equal(assertTransition("task", "open", "claimed"), null);
  assert.equal(assertTransition("task", "claimed", "in_review"), null);
  assert.equal(assertTransition("task", "in_review", "completed"), null);
  assert.equal(assertTransition("task", "in_review", "claimed"), null);
  assert.equal(assertTransition("task", "in_review", "in_review"), null);
  assert.match(assertTransition("task", "completed", "in_review") ?? "", /cannot transition/);
  assert.match(assertTransition("task", "blocked", "claimed") ?? "", /cannot transition/);
  assert.equal(assertTransition("proposal", "pending", "approved"), null);
  assert.equal(assertTransition("proposal", "pending", "rejected"), null);
  assert.match(assertTransition("proposal", "approved", "rejected") ?? "", /only pending/);
  assert.match(assertTransition("proposal", "rejected", "approved") ?? "", /only pending/);
});

test("judge_proposal rejects re-judging a rejected proposal without mutating it", async () => {
  const store = emptyStore();
  store.proposals.push(
    makeProposal({
      status: "rejected",
      orchestratorFeedback: "too vague",
      decisions: [{ approved: false, feedback: "too vague", actor: "orchestrator", at: 10 }],
    })
  );
  const result = await handleJudgeProposal(store, {
    proposalId: "prop_1",
    approved: true,
    feedback: "changed my mind",
    finalDifficulty: "hard",
    actor: "orchestrator-x",
  });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /pending/);
  const proposal = store.proposals[0];
  assert.equal(proposal.status, "rejected");
  assert.equal(proposal.orchestratorFeedback, "too vague");
  assert.equal(proposal.suggestedDifficulty, "easy");
  assert.equal(proposal.decisions?.length, 1);
});

test("judge_proposal rejects re-judging an approved proposal without mutating it", async () => {
  const store = emptyStore();
  store.proposals.push(
    makeProposal({
      status: "approved",
      orchestratorFeedback: "ship it",
      decisions: [{ approved: true, feedback: "ship it", actor: "orchestrator", at: 10 }],
    })
  );
  const result = await handleJudgeProposal(store, {
    proposalId: "prop_1",
    approved: false,
    feedback: "reversed",
  });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /pending/);
  assert.equal(store.proposals[0].status, "approved");
  assert.equal(store.proposals[0].orchestratorFeedback, "ship it");
  assert.equal(store.proposals[0].decisions?.length, 1);
});

test("judge_proposal appends a decision and mirrors the latest feedback", async () => {
  const store = emptyStore();
  store.proposals.push(makeProposal());
  const before = Date.now();

  const result = await handleJudgeProposal(store, {
    proposalId: "prop_1",
    approved: false,
    feedback: "needs a narrower scope",
    actor: "orchestrator-x",
  });
  assert.ok("result" in result);
  const parsed = JSON.parse(result.result.content[0].text) as { proposal: TaskProposal };
  assert.equal(parsed.proposal.status, "rejected");
  assert.equal(parsed.proposal.orchestratorFeedback, "needs a narrower scope");
  const decision = parsed.proposal.decisions?.[0];
  assert.deepEqual(
    { approved: decision?.approved, feedback: decision?.feedback, actor: decision?.actor },
    { approved: false, feedback: "needs a narrower scope", actor: "orchestrator-x" }
  );
  assert.ok((decision?.at ?? 0) >= before);

  // The audit entry is immutable: a second judgement errors and appends nothing.
  const again = await handleJudgeProposal(store, {
    proposalId: "prop_1",
    approved: true,
    feedback: "overwrite",
  });
  assert.ok("error" in again);
  assert.equal(store.proposals[0].decisions?.length, 1);
  assert.equal(store.proposals[0].orchestratorFeedback, "needs a narrower scope");
});

test("list_proposals exposes decision history (including legacy proposals with none)", async () => {
  const store = emptyStore();
  store.proposals.push(
    makeProposal({
      status: "approved",
      orchestratorFeedback: "great",
      decisions: [{ approved: true, feedback: "great", actor: "orchestrator", at: 5 }],
    }),
    makeProposal({ id: "prop_legacy", status: "pending" })
  );

  const listed = handleListProposals(store, {});
  assert.ok("result" in listed);
  const payload = JSON.parse(listed.result.content[0].text) as { proposals: TaskProposal[] };
  assert.equal(payload.proposals.length, 2);
  const judged = payload.proposals.find((p) => p.id === "prop_1");
  assert.equal(judged?.decisions?.length, 1);
  assert.equal(judged?.decisions?.[0].approved, true);
  assert.equal(judged?.decisions?.[0].actor, "orchestrator");
  const legacy = payload.proposals.find((p) => p.id === "prop_legacy");
  assert.deepEqual(legacy?.decisions, []);
});

test("judge_proposal is gated by the write lock: concurrent judges cannot double-apply", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-board-judge-"));
  const dataFile = path.join(tmpDir, "swarm_board.json");
  configureStorePaths(tmpDir, dataFile);

  await saveStoreAtomic({ tasks: [], proposals: [makeProposal()], messages: [] });

  const results = await Promise.all([
    withLockedStore((s) => handleJudgeProposal(s, { proposalId: "prop_1", approved: true, feedback: "one" })),
    withLockedStore((s) => handleJudgeProposal(s, { proposalId: "prop_1", approved: false, feedback: "two" })),
  ]);

  assert.equal(results.filter((r) => "result" in r).length, 1);
  assert.equal(results.filter((r) => "error" in r).length, 1);
  const persisted = loadStore().proposals[0];
  assert.equal(persisted.decisions?.length, 1);
  assert.ok(["approved", "rejected"].includes(persisted.status));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});


test("a claim cannot steal a task already in review", async () => {
  const task = makeTask({ status: "in_review", claimedBy: "agent-a", gitBranch: "feat/a" });
  const store = { ...emptyStore(), tasks: [task] };
  const result = await handleClaimTask(store, { taskId: task.id, agentName: "agent-b", workerElo: 1300 });
  assert.ok("error" in result);
  assert.equal(result.error.code, -32602);
  assert.equal(store.tasks[0], task);
  assert.equal(task.claimedBy, "agent-a");
  assert.equal(task.status, "in_review");
  assert.deepEqual(task.history, []);
});

test("a rejection cannot review an open task with legacy assignment metadata", async () => {
  const task = makeTask({ claimedBy: "old-worker" });
  const store = { ...emptyStore(), tasks: [task] };
  const result = await handleReviewAndMergeTask(store, { taskId: task.id, approved: false, feedback: "No." });
  assert.ok("error" in result);
  assert.match(result.error.message, /only in_review/);
  assert.equal(store.tasks[0], task);
  assert.deepEqual(task.history, []);
});

test("concurrent identical submissions write one history event; a revised branch clears the old PR", async (t) => {
  const { STORAGE_DIR, DATA_FILE } = getStoragePaths();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-board-retry-"));
  configureStorePaths(dir, path.join(dir, "swarm_board.json"));
  t.after(() => {
    configureStorePaths(STORAGE_DIR, DATA_FILE);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const task = makeTask({ status: "claimed", claimedBy: "agent-a" });
  await saveStoreAtomic({ ...emptyStore(), tasks: [task] });
  const submission = {
    taskId: task.id, agentName: "agent-a", gitBranch: "feat/a", summary: "Ready", prUrl: "https://example.test/pr/1",
  };
  const submit = (args: Record<string, unknown>) => withLockedStore((store) => handleSubmitTaskWork(store, args));
  const [first, retry] = await Promise.all([submit(submission), submit(submission)]);
  assert.ok("result" in first);
  assert.deepEqual(retry, first);
  assert.deepEqual(loadStore().tasks[0].history?.map(({ from, to }) => [from, to]), [["claimed", "in_review"]]);

  const revision = await submit({ ...submission, gitBranch: "feat/b", prUrl: undefined });
  assert.ok("result" in revision);
  const updated = payload(revision).task;
  assert.equal(updated.gitBranch, "feat/b");
  assert.equal(updated.prUrl, undefined);
  assert.deepEqual(updated.history?.map(({ from, to }) => [from, to]), [["claimed", "in_review"], ["in_review", "in_review"]]);
});

test("validateGitBranch accepts feat/fix/docs branches and rejects the rest", () => {
  for (const branch of ["feat/x", "fix/abc-def", "docs/readme", "feat/a/b/c", " feat/x "]) {
    assert.equal(validateGitBranch(branch), null, branch);
  }
  const rejects: Array<[unknown, RegExp]> = [
    ["", /required/],
    ["main", /must not be main or master/],
    ["master", /must not be main or master/],
    ["chore/x", /must start with one of/],
    ["feature/x", /must start with one of/],
    ["feat/", /must name a branch after its prefix/],
    ["feat//x", /must name a branch after its prefix/],
    ["feat/x/", /must name a branch after its prefix/],
    ["feat/has space", /must not contain whitespace/],
    ["feat/has..dots", /must not contain whitespace/],
    [123, /required/],
  ];
  for (const [branch, pattern] of rejects) {
    const err = validateGitBranch(branch);
    assert.ok(err, String(branch));
    assert.equal(err.field, "gitBranch");
    assert.match(err.message, pattern, String(branch));
  }
});

test("submit_task_work rejects main/master and non-prefixed branches with a clear error", async () => {
  for (const [gitBranch, pattern] of [
    ["main", /must not be main or master/],
    ["master", /must not be main or master/],
    ["chore/x", /must start with one of feat\/, fix\/, docs\//],
  ] as const) {
    const store = emptyStore();
    store.tasks.push(makeTask({ status: "claimed", claimedBy: "agent-a" }));
    const result = await handleSubmitTaskWork(store, {
      taskId: "t1",
      agentName: "agent-a",
      gitBranch,
      summary: "done",
    });
    assert.ok("error" in result, gitBranch);
    assert.equal(result.error.code, -32602);
    assert.match(result.error.message, pattern, gitBranch);
    // No mutation on validation failure.
    assert.equal(store.tasks[0].status, "claimed");
    assert.equal(store.tasks[0].gitBranch, undefined);
  }
});

test("submit_task_work accepts a docs/ branch end to end", async () => {
  const store = emptyStore();
  store.tasks.push(makeTask({ status: "claimed", claimedBy: "agent-a" }));
  const result = await handleSubmitTaskWork(store, {
    taskId: "t1",
    agentName: "agent-a",
    gitBranch: "docs/board-push-rule",
    summary: "documented",
  });
  assert.ok("result" in result);
  const parsed = payload(result);
  assert.equal(parsed.task.status, "in_review");
  assert.equal(parsed.task.gitBranch, "docs/board-push-rule");
});
