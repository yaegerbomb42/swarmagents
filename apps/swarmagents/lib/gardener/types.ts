import type { TaskDifficulty } from "../mcp-types";

/** One-click proposal produced while a VM sits in the pre-hibernate window. */
export type GardenerProposalKind = "unit-test" | "pr" | "board-task";

export type GardenerProposalStatus = "awaiting_approval" | "approved" | "dismissed";

export interface GardenerProposal {
  id: string;
  userId: string;
  kind: GardenerProposalKind;
  title: string;
  summary: string;
  repoRoot?: string;
  path?: string;
  taskId?: string;
  difficulty?: TaskDifficulty;
  status: GardenerProposalStatus;
  createdAt: number;
}

export interface PinnedProject {
  repoRoot: string;
  pinnedAt: number;
}

export const MAX_REPO_ROOT_LEN = 300;
export const MAX_PINNED_REPOSITORIES = 50;

export interface GardenerUserState {
  enabled: boolean;
  /** Hardest board-task difficulty the autopilot may propose. Defaults to medium. */
  maxDifficulty: TaskDifficulty;
  pinned: PinnedProject[];
  proposals: GardenerProposal[];
}

export interface GardenerFile {
  version: 1;
  users: Record<string, GardenerUserState>;
}

export interface QuotaProvider {
  id: string;
  isFree?: boolean;
  baseUrl?: string;
  enabled?: boolean;
  dailyBudgetUsd?: number;
  spentTodayUsd?: number;
  /** Epoch ms; provider is skipped while this is in the future. */
  quotaExhaustedUntil?: number;
}

export interface HotspotInput {
  path: string;
  heat: number;
  coveragePct?: number | null;
}

export interface BoardTaskInput {
  id: string;
  title: string;
  description?: string;
  status: string;
  difficulty: TaskDifficulty;
  updatedAt?: number;
}
