export type TaskDifficulty = "trivial" | "easy" | "medium" | "hard" | "expert";

export type TaskStatus = "open" | "claimed" | "in_review" | "completed" | "blocked";

/**
 * One auditable status change on a board task. Appended by every mutating
 * handler so a task's lifecycle is visible in poll and GET output. For new
 * tasks `none → open` records creation; legacy tasks need not have that
 * entry. `claimed → open` by the board records claim expiry.
 */
export interface TaskTransition {
  from: TaskStatus | "none";
  to: TaskStatus;
  actor: string;
  at: number;
}

export interface SwarmTask {
  id: string;
  title: string;
  description: string;
  difficulty: TaskDifficulty;
  minElo: number;
  constraints: string[];
  status: TaskStatus;
  claimedBy?: string;
  claimedByElo?: number;
  resultSummary?: string;
  gitBranch?: string;
  prUrl?: string;
  /** Reviewer recorded by review_and_merge_task (approve or reject). */
  reviewedBy?: string;
  /** Epoch ms of the last review_and_merge_task decision. */
  reviewedAt?: number;
  /** Append-only status transition log for audit. Older tasks may omit it. */
  history?: TaskTransition[];
  createdAt: number;
  updatedAt: number;
}

export type ProposalStatus = "pending" | "approved" | "rejected";

/**
 * One orchestrator decision on a proposal. Decisions are append-only (a
 * proposal can only be judged while pending) so the full judgement history
 * survives; `orchestratorFeedback` mirrors the latest decision for older
 * clients that predate this field.
 */
export interface ProposalDecision {
  approved: boolean;
  feedback?: string;
  actor: string;
  at: number;
}

export interface TaskProposal {
  id: string;
  proposedBy: string;
  title: string;
  problem: string;
  proposedSolution: string;
  suggestedDifficulty: TaskDifficulty;
  status: ProposalStatus;
  orchestratorFeedback?: string;
  /** Append-only judgement log. Older proposals may omit it. */
  decisions?: ProposalDecision[];
  promotedTaskId?: string;
  createdAt: number;
}

export interface SwarmMessage {
  id: string;
  fromAgent: string;
  channel: "general" | "blockers" | "announcements" | "idle_scouts";
  content: string;
  timestamp: number;
}

export const DIFFICULTY_ELO_MAP: Record<TaskDifficulty, number> = {
  trivial: 1000, // Flash-Lite, Haiku
  easy: 1200,    // Gemini Flash, GPT-4o-mini
  medium: 1400,  // Standard Coding models
  hard: 1600,    // Claude 3.5 Sonnet, GPT-4o
  expert: 1800,  // OpenAI o1/o3, Opus
};
