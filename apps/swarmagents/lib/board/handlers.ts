import type { BoardStore } from "./types";
import type {
  SwarmTask,
  TaskProposal,
  TaskDifficulty,
  TaskStatus,
  ProposalStatus,
  ProposalDecision,
} from "@/lib/mcp-types";
import { DIFFICULTY_ELO_MAP } from "@/lib/mcp-types";
import { saveStoreAtomic } from "./store";
import { applyArenaMatch } from "./leaderboard";
import {
  validateCreateTask,
  validatePollTasks,
  validateClaimTask,
  validateSubmitTaskWork,
  validateSubmitProposal,
  validateJudgeProposal,
  validateListProposals,
  validateReviewAndMergeTask,
  validateRecordMatch,
  validateSyncArtifact,
  validateListArtifacts,
} from "./validation";
import { randomUUID } from "node:crypto";
import type { HybridArtifact } from "./types";

export type JsonRpcError = { code: number; message: string };
export type JsonRpcResult = { content: Array<{ type: "text"; text: string }> };

function ok(text: string): JsonRpcResult {
  return { content: [{ type: "text", text }] };
}

function invalidParams(msg: string): JsonRpcError {
  return { code: -32602, message: msg };
}

function notFound(msg: string): JsonRpcError {
  return { code: -32000, message: msg };
}

/**
 * Single source of truth for board state transitions. Both task and proposal
 * handlers consult this table; nothing else is allowed to decide whether a
 * status change is legal.
 *
 * `in_review → in_review` is intentional: an owner may resubmit updated work
 * while a review has not landed yet. `claimed → open` is claim expiry, not a
 * review. The handlers also enforce the preconditions for each action.
 */
const TASK_TRANSITIONS: Record<TaskStatus | "none", readonly TaskStatus[]> = {
  none: ["open"],
  open: ["claimed"],
  claimed: ["in_review", "open"],
  in_review: ["in_review", "completed", "claimed", "open"],
  completed: [],
  blocked: [],
};

const PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  pending: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

export type TransitionKind = "task" | "proposal";

/**
 * Return a human-readable error when `from -> to` is not allowed, or null when
 * it is. Callers must not mutate anything when an error is returned.
 */
export function assertTransition(
  kind: TransitionKind,
  from: TaskStatus | ProposalStatus | "none",
  to: TaskStatus | ProposalStatus
): string | null {
  if (kind === "task") {
    const allowed = TASK_TRANSITIONS[from as TaskStatus | "none"];
    if (allowed?.includes(to as TaskStatus)) return null;
    return `Task cannot transition from status ${from} to ${to}`;
  }
  const allowed = PROPOSAL_TRANSITIONS[from as ProposalStatus];
  if (allowed?.includes(to as ProposalStatus)) return null;
  return `Proposal cannot be judged from status ${from}; only pending proposals can be judged`;
}

/** Return a task with an appended audit entry without changing the input. */
function transitionTask(
  task: SwarmTask,
  to: TaskStatus,
  actor: string,
  at: number,
  from: TaskStatus | "none" = task.status,
): SwarmTask {
  const blocked = assertTransition("task", from, to);
  if (blocked) throw new Error(blocked);
  return {
    ...task,
    status: to,
    updatedAt: at,
    history: [...(Array.isArray(task.history) ? task.history : []), { from, to, actor, at }],
  };
}

const DEFAULT_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

function claimExpiry(task: SwarmTask): number {
  const ttl = Number(process.env.SWARM_BOARD_CLAIM_TTL_MS);
  return task.updatedAt + (Number.isSafeInteger(ttl) && ttl > 0 ? ttl : DEFAULT_CLAIM_TTL_MS);
}

export function isClaimExpired(task: SwarmTask, now: number): boolean {
  return task.status === "claimed" && now >= claimExpiry(task);
}

function clearAssignment(task: SwarmTask): SwarmTask {
  const next = { ...task };
  delete next.claimedBy;
  delete next.claimedByElo;
  delete next.gitBranch;
  delete next.resultSummary;
  delete next.prUrl;
  return next;
}

/**
 * Expiry is effective as of the deadline, even on a read-only poll. The
 * expiry event and next claim are saved together under the write lock. Use
 * the deadline (not the poll/reclaim time) so the visible history is stable.
 */
export function viewBoardTask(task: SwarmTask, now: number): SwarmTask {
  if (!isClaimExpired(task, now)) return task;
  return transitionTask(clearAssignment(task), "open", "swarm-board", claimExpiry(task));
}

/**
 * Persist store state, mapping any write failure onto a JSON-RPC internal
 * error. Never report success for a task that was not actually saved.
 */
async function persistOrError(store: BoardStore): Promise<JsonRpcError | null> {
  try {
    await saveStoreAtomic(store);
    return null;
  } catch (err) {
    return {
      code: -32603,
      message: `Failed to persist board state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Do not publish the new task snapshot in memory unless it reached disk. */
async function persistTask(
  store: BoardStore, task: SwarmTask, index = store.tasks.length,
): Promise<JsonRpcError | null> {
  const tasks = store.tasks.slice();
  tasks[index] = task;
  const error = await persistOrError({ ...store, tasks });
  if (!error) store.tasks = tasks;
  return error;
}

export function handleInitialize(id: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "swarmagents-cloud-mcp", version: "2.0.0" },
    },
  };
}

export function handlePing(id: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result: {},
  };
}

export function handleToolsList(id: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    result: {
      tools: [
        {
          name: "create_task",
          description: "Orchestrator tool to post new prioritized tasks with explicit difficulty/minElo.",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              difficulty: { type: "string", enum: ["trivial", "easy", "medium", "hard", "expert"] },
              constraints: { type: "array", items: { type: "string" } },
            },
            required: ["title", "description", "difficulty"],
          },
        },
        {
          name: "poll_tasks",
          description: "Worker tool to query tasks with Elo alignment score.",
          inputSchema: {
            type: "object",
            properties: {
              workerElo: { type: "number" },
              status: { type: "string", enum: ["open", "claimed", "in_review", "completed", "blocked"] },
            },
          },
        },
        {
          name: "claim_task",
          description: "Claim an open task. Unsubmitted claims expire and can be reclaimed; work in review cannot be claimed.",
          inputSchema: {
            type: "object",
            properties: {
              taskId: { type: "string" },
              agentName: { type: "string" },
              workerElo: { type: "number" },
            },
            required: ["taskId", "agentName", "workerElo"],
          },
        },
        {
          name: "submit_task_work",
          description:
            "Submit branch and PR summary once work passes tests. Requires agentName matching the task's claimedBy exactly; only that agent may submit, and only while the claim is active or the task is in_review.",
          inputSchema: {
            type: "object",
            properties: {
              taskId: { type: "string" },
              agentName: {
                type: "string",
                description:
                  "Exact agentName used when claiming the task (owner check; required since v2.1).",
              },
              gitBranch: { type: "string" },
              prUrl: { type: "string" },
              summary: { type: "string" },
            },
            required: ["taskId", "agentName", "gitBranch", "summary"],
          },
        },
        {
          name: "submit_proposal",
          description: "Worker tool to propose improvements when backlog is empty.",
          inputSchema: {
            type: "object",
            properties: {
              proposedBy: { type: "string" },
              title: { type: "string" },
              problem: { type: "string" },
              proposedSolution: { type: "string" },
              suggestedDifficulty: { type: "string", enum: ["trivial", "easy", "medium", "hard", "expert"] },
            },
            required: ["proposedBy", "title", "problem", "proposedSolution", "suggestedDifficulty"],
          },
        },
        {
          name: "list_proposals",
          description: "List proposals, optionally filtered by status.",
          inputSchema: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["pending", "approved", "rejected"] },
            },
          },
        },
        {
          name: "judge_proposal",
          description:
            "Orchestrator tool to approve or reject a scouting proposal. Only pending proposals can be judged; a second judgement returns a JSON-RPC error without changing the proposal. Each decision is appended to the proposal's decisions log and orchestratorFeedback mirrors the latest one.",
          inputSchema: {
            type: "object",
            properties: {
              proposalId: { type: "string" },
              approved: { type: "boolean" },
              feedback: { type: "string" },
              finalDifficulty: { type: "string", enum: ["trivial", "easy", "medium", "hard", "expert"] },
              actor: {
                type: "string",
                description: "Optional judge identity recorded in the decisions log (default: orchestrator).",
              },
            },
            required: ["proposalId", "approved"],
          },
        },
        {
          name: "review_and_merge_task",
          description:
            "Record a decision on a task in review. Approval completes the task on the board but does not run or verify a Git merge. Rejection renews the current owner's claim or returns the task to open. Records reviewer, reviewedAt, and a transition history entry.",
          inputSchema: {
            type: "object",
            properties: {
              taskId: { type: "string" },
              approved: { type: "boolean" },
              feedback: { type: "string" },
              autoMergeGit: { type: "boolean" },
              reviewer: {
                type: "string",
                description: "Optional reviewer identity recorded on the task (default: orchestrator).",
              },
            },
            required: ["taskId", "approved", "feedback"],
          },
        },
        {
          name: "record_match",
          description:
            "Record an arena battle result into the Swarm Board Elo leaderboard. The winner gains rating, the loser loses the same amount (K=32), and an entry is appended to the match log. Used by the arena runner to feed verified match winners into rankings.",
          inputSchema: {
            type: "object",
            properties: {
              winner: { type: "string" },
              loser: { type: "string" },
              reason: { type: "string" },
              winnerScore: { type: "number" },
              loserScore: { type: "number" },
              winnerLatencyMs: { type: "number" },
              loserLatencyMs: { type: "number" },
              winnerCostUsd: { type: "number" },
              loserCostUsd: { type: "number" },
            },
            required: ["winner", "loser"],
          },
        },
        {
          name: "sync_artifact",
          description:
            "Publish files produced by one hybrid-compute lane (cloud VM or a paired computer) so the other side of the run can read them.",
          inputSchema: {
            type: "object",
            properties: {
              runId: { type: "string" },
              agentId: { type: "string" },
              taskId: { type: "string" },
              computeTarget: { type: "string", description: "cloud or computer:<id>" },
              files: { type: "array", items: { type: "string" } },
              summary: { type: "string" },
            },
            required: ["runId", "agentId", "taskId", "computeTarget", "files", "summary"],
          },
        },
        {
          name: "list_artifacts",
          description: "List hybrid-compute artifacts, optionally for one team run.",
          inputSchema: {
            type: "object",
            properties: {
              runId: { type: "string" },
            },
          },
        },
      ],
    },
  };
}

export async function handleCreateTask(
  store: BoardStore,
  args: Record<string, unknown>,
  actor = "orchestrator",
): Promise<{ result: JsonRpcResult } | { error: JsonRpcError }> {
  const ve = validateCreateTask(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const difficulty = (args.difficulty as TaskDifficulty) || "medium";
  const minElo = DIFFICULTY_ELO_MAP[difficulty];
  const now = Date.now();
  const task = transitionTask({
    id: `task_${randomUUID()}`,
    title: args.title as string,
    description: args.description as string,
    difficulty,
    minElo,
    constraints: (args.constraints as string[]) || [],
    status: "open",
    createdAt: now,
    updatedAt: now,
  }, "open", actor, now, "none");
  const persistErr = await persistTask(store, task);
  if (persistErr) return { error: persistErr };
  return { result: ok(JSON.stringify({ message: "Task created", task }, null, 2)) };
}

export function handlePollTasks(
  store: BoardStore,
  args: Record<string, unknown>
): { result: JsonRpcResult } | { error: JsonRpcError } {
  const ve = validatePollTasks(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const status = (args.status as string) || "open";
  const workerElo = (args.workerElo as number) ?? 1400;
  const now = Date.now();
  const filtered = store.tasks
    .map((task) => viewBoardTask(task, now))
    .filter((t) => t.status === status)
    .map((t) => {
      const eloDiff = workerElo - t.minElo;
      let recommendation = "Ideal Match";
      if (eloDiff < -150) recommendation = "Under-qualified (High Risk)";
      else if (eloDiff > 350) recommendation = "Over-qualified (Prefer lower tier model)";
      return { ...t, history: Array.isArray(t.history) ? t.history : [], eloDiff, recommendation };
    })
    .sort((a, b) => Math.abs(a.eloDiff) - Math.abs(b.eloDiff));

  return { result: ok(JSON.stringify({ count: filtered.length, tasks: filtered }, null, 2)) };
}

export async function handleClaimTask(
  store: BoardStore,
  args: Record<string, unknown>
): Promise<{ result: JsonRpcResult } | { error: JsonRpcError }> {
  const ve = validateClaimTask(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const index = store.tasks.findIndex((t) => t.id === args.taskId);
  if (index < 0) return { error: notFound("Task not found") };
  const now = Date.now();
  const task = viewBoardTask(store.tasks[index], now);
  // in_review → claimed is reserved for a review rejection. Merely
  // permitting the status edge here let a late claim steal submitted work.
  if (task.status !== "open") {
    return { error: invalidParams(`Task is not open (current status: ${task.status})`) };
  }
  const agentName = args.agentName as string;
  const claimed = transitionTask({
    ...clearAssignment(task),
    claimedBy: agentName,
    claimedByElo: args.workerElo as number,
  }, "claimed", agentName, now);
  const persistErr = await persistTask(store, claimed, index);
  if (persistErr) return { error: persistErr };
  return { result: ok(JSON.stringify({ message: `Claimed by ${agentName}`, task: claimed }, null, 2)) };
}

export async function handleSubmitTaskWork(
  store: BoardStore,
  args: Record<string, unknown>
): Promise<{ result: JsonRpcResult } | { error: JsonRpcError }> {
  const ve = validateSubmitTaskWork(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const index = store.tasks.findIndex((t) => t.id === args.taskId);
  if (index < 0) return { error: notFound("Task not found") };
  const task = store.tasks[index];

  const agentName = args.agentName as string;
  // Owner-only submission: never let one agent overwrite another's branch/prUrl.
  if (task.claimedBy !== agentName) {
    return {
      error: invalidParams(
        `Task is claimed by ${task.claimedBy ?? "no agent"}; only the claiming agent may submit work (agentName must match exactly, got "${agentName}")`
      ),
    };
  }
  const blocked = assertTransition("task", task.status, "in_review");
  if (blocked) {
    return {
      error: invalidParams(
        `Task cannot be submitted from status ${task.status}; expected claimed or in_review`
      ),
    };
  }

  const now = Date.now();
  if (isClaimExpired(task, now)) {
    return { error: invalidParams("Task claim expired. Claim the task again before submitting work.") };
  }
  const gitBranch = args.gitBranch as string;
  const resultSummary = args.summary as string;
  // An omitted link can retain the PR on the same branch, but must not
  // attach the previous branch's PR to a different submission.
  const prUrl = (args.prUrl as string | undefined) || (gitBranch === task.gitBranch ? task.prUrl : undefined);
  const unchanged = task.status === "in_review" && task.gitBranch === gitBranch &&
    task.resultSummary === resultSummary && task.prUrl === prUrl;
  const submitted = unchanged ? task : transitionTask({ ...task, gitBranch, resultSummary, prUrl }, "in_review", agentName, now);
  // A retry after a lost response is a no-op; revised work is still accepted.
  if (!unchanged) {
    const persistErr = await persistTask(store, submitted, index);
    if (persistErr) return { error: persistErr };
  }
  return { result: ok(JSON.stringify({ message: "Submitted for review", task: submitted }, null, 2)) };
}

export async function handleSubmitProposal(
  store: BoardStore,
  args: Record<string, unknown>
): Promise<{ result: JsonRpcResult } | { error: JsonRpcError }> {
  const ve = validateSubmitProposal(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const proposal: TaskProposal = {
    id: `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    proposedBy: args.proposedBy as string,
    title: args.title as string,
    problem: args.problem as string,
    proposedSolution: args.proposedSolution as string,
    suggestedDifficulty: args.suggestedDifficulty as TaskDifficulty,
    status: "pending",
    createdAt: Date.now(),
  };
  store.proposals.push(proposal);
  const persistErr = await persistOrError(store);
  if (persistErr) return { error: persistErr };
  return { result: ok(JSON.stringify({ message: "Proposal submitted", proposal }, null, 2)) };
}

export async function handleJudgeProposal(
  store: BoardStore,
  args: Record<string, unknown>
): Promise<{ result: JsonRpcResult } | { error: JsonRpcError }> {
  const ve = validateJudgeProposal(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const proposal = store.proposals.find((p) => p.id === args.proposalId);
  if (!proposal) return { error: notFound("Proposal not found") };

  // A proposal is judged exactly once. Check before touching any field so a
  // re-judge never mutates status, feedback, difficulty, or the decision log.
  const nextStatus: ProposalStatus = args.approved ? "approved" : "rejected";
  const blocked = assertTransition("proposal", proposal.status, nextStatus);
  if (blocked) return { error: invalidParams(blocked) };

  const at = Date.now();
  const feedback = (args.feedback as string) || undefined;
  const actor = (args.actor as string) || "orchestrator";
  const decision: ProposalDecision = { approved: Boolean(args.approved), feedback, actor, at };
  if (!Array.isArray(proposal.decisions)) proposal.decisions = [];
  proposal.decisions.push(decision);

  proposal.status = nextStatus;
  // Keep the legacy field in sync with the latest decision for older clients.
  proposal.orchestratorFeedback = feedback;
  if (args.finalDifficulty) proposal.suggestedDifficulty = args.finalDifficulty as TaskDifficulty;
  const persistErr = await persistOrError(store);
  if (persistErr) return { error: persistErr };
  return { result: ok(JSON.stringify({ message: args.approved ? "Approved" : "Rejected", proposal }, null, 2)) };
}

export function handleListProposals(
  store: BoardStore,
  args: Record<string, unknown>
): { result: JsonRpcResult } | { error: JsonRpcError } {
  const ve = validateListProposals(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const status = args.status as string | undefined;
  const proposals = (status ? store.proposals.filter((p) => p.status === status) : [...store.proposals]).map(
    (p) => ({ ...p, decisions: Array.isArray(p.decisions) ? p.decisions : [] })
  );
  return { result: ok(JSON.stringify({ count: proposals.length, proposals }, null, 2)) };
}

export async function handleRecordMatch(
  store: BoardStore,
  args: Record<string, unknown>
): Promise<{ result: JsonRpcResult } | { error: JsonRpcError }> {
  const ve = validateRecordMatch(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }

  let applied;
  try {
    applied = applyArenaMatch(store, {
      winner: args.winner as string,
      loser: args.loser as string,
      reason: (args.reason as string | undefined) ?? "arena battle",
      winnerScore: args.winnerScore as number | undefined,
      loserScore: args.loserScore as number | undefined,
      winnerLatencyMs: args.winnerLatencyMs as number | undefined,
      loserLatencyMs: args.loserLatencyMs as number | undefined,
      winnerCostUsd: args.winnerCostUsd as number | undefined,
      loserCostUsd: args.loserCostUsd as number | undefined,
    });
  } catch (err) {
    return { error: invalidParams(err instanceof Error ? err.message : String(err)) };
  }

  store.leaderboard = applied.leaderboard;
  store.matches = [...(store.matches ?? []), applied.match];
  const persistErr = await persistOrError(store);
  if (persistErr) return { error: persistErr };
  return {
    result: ok(
      JSON.stringify(
        {
          message: "Arena match recorded",
          match: applied.match,
          delta: applied.delta,
          winnerAfter: applied.winnerAfter,
          loserAfter: applied.loserAfter,
        },
        null,
        2
      )
    ),
  };
}

export async function handleReviewAndMergeTask(
  store: BoardStore,
  args: Record<string, unknown>
): Promise<{ result: JsonRpcResult } | { error: JsonRpcError }> {
  const ve = validateReviewAndMergeTask(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const index = store.tasks.findIndex((t) => t.id === args.taskId);
  if (index < 0) return { error: notFound("Task not found") };
  const task = store.tasks[index];
  // Other actions also have edges into claimed/open, so the target status
  // alone cannot authorize a review.
  if (task.status !== "in_review") {
    return {
      error: invalidParams(
        `Task cannot be reviewed from status ${task.status}; only in_review tasks can be reviewed`
      ),
    };
  }

  const reviewer = (args.reviewer as string | undefined) || "orchestrator";
  const now = Date.now();
  // Rejection returns the task to its owner so they can fix and resubmit; a
  // task without an owner falls back to the open pool (legacy semantics).
  const nextStatus: TaskStatus = args.approved
    ? "completed"
    : task.claimedBy
      ? "claimed"
      : "open";
  const reviewed = transitionTask({
    ...(nextStatus === "open" ? clearAssignment(task) : task),
    reviewedBy: reviewer,
    reviewedAt: now,
  }, nextStatus, reviewer, now);
  const persistErr = await persistTask(store, reviewed, index);
  if (persistErr) return { error: persistErr };
  return { result: ok(JSON.stringify({ message: args.approved ? "Approved" : "Rejected", task: reviewed }, null, 2)) };
}

const MAX_ARTIFACTS = 200;

export async function handleSyncArtifact(
  store: BoardStore,
  args: Record<string, unknown>,
): Promise<{ result: JsonRpcResult } | { error: JsonRpcError }> {
  const ve = validateSyncArtifact(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const artifact: HybridArtifact = {
    id: `art_${randomUUID()}`,
    runId: String(args.runId),
    agentId: String(args.agentId),
    taskId: String(args.taskId),
    computeTarget: String(args.computeTarget),
    files: (args.files as string[]).slice(0, 50),
    summary: String(args.summary).slice(0, 500),
    createdAt: Date.now(),
  };
  store.artifacts = [...(store.artifacts ?? []), artifact].slice(-MAX_ARTIFACTS);
  const persistErr = await persistOrError(store);
  if (persistErr) return { error: persistErr };
  return { result: ok(JSON.stringify({ message: "Artifact synced", artifact }, null, 2)) };
}

export function handleListArtifacts(
  store: BoardStore,
  args: Record<string, unknown>,
): { result: JsonRpcResult } | { error: JsonRpcError } {
  const ve = validateListArtifacts(args);
  if (ve.length) {
    return { error: invalidParams(ve.map((v) => `${v.field}: ${v.message}`).join("; ")) };
  }
  const runId = typeof args.runId === "string" ? args.runId : undefined;
  const artifacts = (store.artifacts ?? []).filter((artifact) => !runId || artifact.runId === runId);
  return { result: ok(JSON.stringify({ artifacts }, null, 2)) };
}
