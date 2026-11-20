export type TaskDifficulty = "trivial" | "easy" | "medium" | "hard" | "expert";

export type TaskStatus = "open" | "claimed" | "in_review" | "completed" | "blocked";

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

export const DIFFICULTY_ELO_MAP: Record<TaskDifficulty, number> = {
  trivial: 1000, // Flash-Lite, Haiku
  easy: 1200,    // Gemini Flash, GPT-4o-mini
  medium: 1400,  // Standard Coding models
  hard: 1600,    // Claude 3.5 Sonnet, GPT-4o
  expert: 1800,  // OpenAI o1/o3, Opus
};
