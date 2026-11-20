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
  minElo?: number;
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
  /** Agent Elo used when polling the swarm board. Defaults to 1400 (medium). */
  workerElo: number;
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
  minElo: number;
}
