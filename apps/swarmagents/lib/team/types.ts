// Team Mode — shared types.
//
// One prompt becomes a small team inside the user's VM: a Planner writes a
// task list, 2–4 role lanes run their tasks in parallel under
// /workspace/team/<runId>/<agentId>/, and a Reviewer merges each result or
// sends it back for rework.
//
// This file is client-safe (no node imports): the minimalist UI imports the
// snapshot shape from here.

export type TeamRunStatus = "planning" | "running" | "reviewing" | "completed" | "failed" | "cancelled";

export type LaneKind = "planner" | "worker" | "reviewer";

export type LaneStatus = "queued" | "running" | "review" | "rework" | "merged" | "failed" | "paused";

export type TaskStatus = "pending" | "active" | "rework" | "passed" | "merged" | "failed";

export interface TeamTask {
  id: string;
  title: string;
  detail: string;
  /** Role id from lib/roles.ts that owns this task. */
  roleId: string;
  /** Lane that ran it, filled in once lanes are created. */
  agentId?: string;
  status: TaskStatus;
  /** Review note from the last rejection, when any. */
  note?: string;
  summary?: string;
}

/**
 * A lane's pending approval. The lane paused on a tool call the risk
 * classifier flagged as "ask" and waits for the user to approve or deny it
 * (the same gate a normal run uses).
 */
export interface LaneApproval {
  /** The approval id the decision endpoint expects (/api/runtime/approvals/{id}). */
  id: string;
  /** The tool that asked for permission (e.g. "Bash"). */
  tool: string;
  /** Human-readable summary of the flagged action (e.g. the shell command). */
  action: string;
  /** Why the action needs approval. */
  reason: string;
  /** Epoch ms at which an unanswered approval auto-denies itself. */
  expiresAt: number;
}

export interface TeamLane {
  agentId: string;
  kind: LaneKind;
  roleId: string;
  roleName: string;
  /** One or two character glyph from the role definition. */
  glyph: string;
  taskId: string | null;
  taskTitle: string | null;
  status: LaneStatus;
  currentAction: string;
  provider: string;
  model: string;
  /** Path inside the VM, e.g. /workspace/team/<runId>/a1. */
  worktree: string;
  /** Rework attempts used (review rejections sent back). */
  attempts: number;
  /**
   * Turns the lane has taken: one per lane invocation, rework included, so
   * the panel can show how chatty a lane was. The planner counts its plan
   * rounds (1 + revisions).
   */
  turns: number;
  tokens: number;
  costUsd: number;
  startedAt: number | null;
  finishedAt: number | null;
  takenOver: boolean;
  note: string | null;
  /** "cloud" or "computer:<id>" for this lane. */
  computeTarget?: string;
  /** Where the lane was placed. "byoc" only when a paired computer was assigned. */
  computePlacement?: "cloud" | "byoc";
  /** The approval this lane is waiting for, while it waits. */
  approval?: LaneApproval;
}

export interface TeamBudget {
  tokenCap: number;
  tokensUsed: number;
  costCapUsd: number;
  costUsedUsd: number;
}

export interface TeamRun {
  runId: string;
  userId: string;
  prompt: string;
  /** Roles the user pre-granted for every lane in this team run. */
  grantedRoleIds?: string[];
  /** Paired computer that receives BYOC lanes (`cmp_…`). */
  byocComputerId?: string;
  status: TeamRunStatus;
  createdAt: number;
  updatedAt: number;
  plan: TeamTask[];
  lanes: TeamLane[];
  /**
   * Outcome of the pre-execution plan-review gate, once it has run:
   * how many review rounds the plan took and the reviewer's last note.
   */
  planReview?: {
    /** 1 = first plan approved, 2 = revised plan approved (or rejected). */
    rounds: number;
    approved: boolean;
    /** The reviewer's note on the last round. */
    note: string | null;
  };
  budget: TeamBudget;
  concurrency: { limit: number; active: number };
  mergedFiles: string[];
  error: string | null;
}

export interface TeamSettings {
  /** Max lanes running at once for this user (1–4, default 3). */
  maxAgents: number;
  /** Max tasks the planner may produce (2–4, default 4). */
  maxTasks: number;
  /** Total tokens one team run may spend. */
  tokenCap: number;
  /** Total USD one team run may spend. */
  costCapUsd: number;
  /** Review rework attempts per task before it fails (1–3, default 2). */
  maxAttempts: number;
}

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  maxAgents: 3,
  maxTasks: 4,
  tokenCap: 120_000,
  costCapUsd: 2,
  maxAttempts: 2,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function resolveTeamSettings(input?: Partial<TeamSettings> | null): TeamSettings {
  const s = input ?? {};
  return {
    maxAgents: clamp(Math.round(Number(s.maxAgents) || DEFAULT_TEAM_SETTINGS.maxAgents), 1, 4),
    maxTasks: clamp(Math.round(Number(s.maxTasks) || DEFAULT_TEAM_SETTINGS.maxTasks), 2, 4),
    tokenCap: Math.max(1, Math.round(Number(s.tokenCap) || DEFAULT_TEAM_SETTINGS.tokenCap)),
    costCapUsd: Math.max(0.01, Number(s.costCapUsd) || DEFAULT_TEAM_SETTINGS.costCapUsd),
    maxAttempts: clamp(Math.round(Number(s.maxAttempts) || DEFAULT_TEAM_SETTINGS.maxAttempts), 1, 3),
  };
}

/** One planner draft, before validation. */
export interface PlanDraft {
  title: string;
  detail: string;
  roleId: string;
}

export interface LaneResult {
  ok: boolean;
  summary: string;
  files: string[];
  tokens: number;
  costUsd: number;
  provider?: string;
  model?: string;
  error?: string;
}

export interface ReviewResult {
  approved: boolean;
  note: string;
  tokens: number;
  costUsd: number;
}

export interface MergeResult {
  files: string[];
  note: string;
}

/** Telemetry event names emitted by Team Mode (on top of the harness events). */
export const TEAM_EVENTS = {
  plan: "team.plan",
  planReview: "team.plan.review",
  agentStarted: "team.agent.started",
  agentFinished: "team.agent.finished",
  review: "team.review",
  budget: "team.budget",
  takeover: "team.agent.takeover",
  snapshot: "team.run",
} as const;

/** WAI: the run id format shared by the runtime routes. */
export const TEAM_RUN_ID_RE = /^team_[A-Za-z0-9_-]{1,48}$/;