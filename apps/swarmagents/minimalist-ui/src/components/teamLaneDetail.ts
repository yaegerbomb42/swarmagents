/**
 * Click-to-inspect for a team lane: the detail the panel shows when the user
 * opens a lane.
 *
 * Pure (no React, no DOM) so the panel can render it and node:test can cover
 * it: the lane's brief (its current task's title + detail), the tools its
 * role may call, and the run facts the snapshot already carries (turns,
 * tokens, cost, worktree). The role lookup runs against the built-in
 * catalog; a custom role has no client-side tool list, so the panel says so
 * instead of inventing one.
 */

import type { TeamLane, TeamTask } from "../../../lib/team/types";
import type { RoleDefinition } from "../../../lib/roles";

export interface LaneInspectDetail {
  agentId: string;
  roleName: string;
  roleId: string;
  kind: TeamLane["kind"];
  status: TeamLane["status"];
  glyph: string;
  /** The lane's current task (from the plan), or the lane's own title. */
  taskTitle: string | null;
  /** The task brief the planner wrote, when the lane has a plan task. */
  taskDetail: string | null;
  taskStatus: TeamTask["status"] | null;
  /** Tool names this lane's role may call (empty for a custom role). */
  tools: string[];
  mcpServers: string[];
  skills: string[];
  /** True when the lane's role is not a built-in (no client-side tool list). */
  customRole: boolean;
  worktree: string;
  provider: string;
  model: string;
  /** Turns the lane has taken (falls back to attempts on old snapshots). */
  turns: number;
  attempts: number;
  tokens: number;
  costUsd: number;
  note: string | null;
  currentAction: string;
}

export function buildLaneInspectDetail(
  lane: TeamLane,
  tasks: readonly TeamTask[],
  roles: readonly RoleDefinition[],
): LaneInspectDetail {
  const task = lane.taskId ? tasks.find((item) => item.id === lane.taskId) : undefined;
  const role = roles.find((candidate) => candidate.id === lane.roleId);
  return {
    agentId: lane.agentId,
    roleName: lane.roleName,
    roleId: lane.roleId,
    kind: lane.kind,
    status: lane.status,
    glyph: lane.glyph,
    taskTitle: task?.title ?? lane.taskTitle,
    taskDetail: task?.detail ?? null,
    taskStatus: task?.status ?? null,
    tools: role?.tools ?? [],
    mcpServers: role?.mcpServers ?? [],
    skills: role?.skills ?? [],
    customRole: !role,
    worktree: lane.worktree,
    provider: lane.provider,
    model: lane.model,
    turns: lane.turns ?? lane.attempts ?? 0,
    attempts: lane.attempts,
    tokens: lane.tokens,
    costUsd: lane.costUsd,
    note: lane.note,
    currentAction: lane.currentAction,
  };
}
