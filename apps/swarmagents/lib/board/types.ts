import type { SwarmTask, TaskProposal, SwarmMessage } from "@/lib/mcp-types";

/** One player's Elo rating on the arena leaderboard. */
export interface PlayerRating {
  /** Player id, e.g. "anthropic/claude-sonnet-4-5" or an agent name. */
  player: string;
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  updatedAt: number;
}

/** A recorded arena match (two providers/agents battling one prompt). */
export interface ArenaMatch {
  id: string;
  winner: string;
  loser: string;
  /** Why the winner was chosen (verification score, latency, cost…). */
  reason: string;
  winnerScore?: number;
  loserScore?: number;
  winnerLatencyMs?: number;
  loserLatencyMs?: number;
  winnerCostUsd?: number;
  loserCostUsd?: number;
  /** Epoch ms. */
  createdAt: number;
}

/** Per-agent quality signals for orchestrators, exposed by the board GET. */
export type BoardAgentStats = Record<
  string,
  { claimed: number; inReview: number; completed: number; rejected: number }
>;

export interface BoardStore {
  tasks: SwarmTask[];
  proposals: TaskProposal[];
  messages: SwarmMessage[];
  /** Arena Elo leaderboard (optional for backward-compatible boards). */
  leaderboard?: PlayerRating[];
  /** Arena match log (optional for backward-compatible boards). */
  matches?: ArenaMatch[];
  /** Files a hybrid lane published back from cloud or a paired computer. */
  artifacts?: HybridArtifact[];
}

/** A lane result synced across compute targets via the swarm board. */
export interface HybridArtifact {
  id: string;
  runId: string;
  agentId: string;
  taskId: string;
  computeTarget: string;
  files: string[];
  summary: string;
  createdAt: number;
}
