/**
 * Team Mode — shared types.
 *
 * One prompt becomes a small team on the user's own machine: a Planner writes
 * a task list, 2–4 sub-agents execute tasks in parallel in isolated folders
 * under /workspace/team/<runId>/, and a Reviewer merges or sends each result
 * back for rework.
 *
 * This file is client-safe: no node imports, so the panel can import types.
 */

export type TeamRunStatus =
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TeamAgentStatus =
  | 'queued'
  | 'running'
  | 'review'
  | 'rework'
  | 'merged'
  | 'failed'
  | 'paused';

export type TeamTaskStatus = 'pending' | 'active' | 'rework' | 'passed' | 'merged' | 'failed';

export type TeamAgentKind = 'planner' | 'worker' | 'reviewer';

export interface TeamPlanItem {
  id: string;
  title: string;
  detail: string;
  /** Role id from lib/agentRoles.ts that owns this task. */
  roleId: string;
  /** Lane that ran it, filled in once lanes are created. */
  agentId?: string;
  status: TeamTaskStatus;
}

export interface TeamBudget {
  tokenCap: number;
  tokensUsed: number;
  costCapUsd: number;
  costUsedUsd: number;
}

export interface TeamAgentLane {
  agentId: string;
  kind: TeamAgentKind;
  roleId: string;
  roleName: string;
  /** Single-character glyph shown in the lane header. */
  glyph: string;
  color: string;
  taskId: string | null;
  taskTitle: string | null;
  status: TeamAgentStatus;
  currentAction: string;
  provider: string;
  model: string;
  worktree: string;
  attempts: number;
  tokens: number;
  costUsd: number;
  startedAt: number | null;
  finishedAt: number | null;
  takenOver: boolean;
  lastNote: string | null;
}

export interface TeamSettings {
  /** Max agents running at once for this user (1–4, default 3). */
  maxAgents: number;
  /** Max tasks the planner may produce (2–4, default 4). */
  maxTasks: number;
  /** Total tokens a single team run may spend. */
  tokenCap: number;
  /** Total USD a single team run may spend. */
  costCapUsd: number;
  /** Review rework attempts before a task is failed (1–3, default 2). */
  maxAttempts: number;
  /** Tool allow-list from the user's settings; agents never exceed it. */
  allowedTools?: string[];
}

export interface TeamRun {
  runId: string;
  goal: string;
  status: TeamRunStatus;
  createdAt: number;
  updatedAt: number;
  plan: TeamPlanItem[];
  agents: TeamAgentLane[];
  budget: TeamBudget;
  concurrency: { limit: number; active: number };
  mergedFiles: string[];
  error: string | null;
  /** Provider rotation cursor, advanced on every lane assignment. */
  rotationCursor: number;
  /** User the run belongs to — the concurrency gate is keyed on this. */
  userId: string;
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
    allowedTools: Array.isArray(s.allowedTools) && s.allowedTools.length
      ? s.allowedTools.map(String)
      : undefined,
  };
}

export interface TeamTaskDraft {
  title: string;
  detail: string;
  roleId: string;
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  files: string[];
  tokens: number;
  error?: string;
}

export interface ReviewVerdict {
  approved: boolean;
  note: string;
}

export interface MergeOutcome {
  merged: boolean;
  files: string[];
  note: string;
}

export interface TeamEvent {
  id: string;
  runId: string;
  type: 'team';
  action: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export function teamEventId(): string {
  return `tev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}