export type TaskDifficulty = "easy" | "medium" | "hard";

export type TaskStatus = "open" | "claimed" | "in_review" | "completed" | "blocked";

export interface SwarmTask {
  id: string;
  title: string;
  description: string;
  difficulty: TaskDifficulty;
  constraints: string[];
  status: TaskStatus;
  claimedBy?: string;
  resultSummary?: string;
  gitBranch?: string;
  prUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export type ProposalStatus = "pending" | "approved" | "rejected";

export interface TaskProposal {
  id: string;
  proposedBy: string;
  title: string;
  problem: string;
  proposedSolution: string;
  suggestedDifficulty: TaskDifficulty;
  status: ProposalStatus;
  orchestratorFeedback?: string;
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

/** Difficulty order, easiest first. */
export const DIFFICULTY_RANK: Record<TaskDifficulty, number> = {
  easy: 0,
  medium: 1,
  hard: 2,
};

/** Map a legacy difficulty (trivial/expert) onto the current three levels. */
export function normalizeDifficulty(value: unknown): TaskDifficulty {
  if (value === "trivial" || value === "easy") return "easy";
  if (value === "expert" || value === "hard") return "hard";
  return "medium";
}
