import type { RoleDefinition } from './types.js';
import type { Tool } from '../tools/types.js';
import type { SystemBlock, ToolSpec } from '../providers/types.js';
import {
  clampedDeadlineMs,
  clampedMaxTokens,
  clampedTurnCeiling,
  clampedTurnTimeoutMs,
  filteredTools,
  isToolAllowed,
  roleModelRoute,
  roleSystemPrompt,
} from './filter.js';

/** The subset of loop deps a role can clamp or filter. */
export interface RoleLoopSlice {
  role?: RoleDefinition;
  budget: { max_turns_per_cycle: number };
  maxTokens: number;
  deadlineMs?: number;
  tools: readonly Tool[];
  clock: { now: () => number };
  refreshTools?: () => { tools: readonly Tool[]; specs: ToolSpec[] };
  turnTimeoutMs?: number;
}

/**
 * Apply a bound role to loop dependencies: clamp turn ceiling, deadline,
 * max tokens, and turn timeout; filter the tool list (and refreshTools).
 * Returns `deps` unchanged when no role is bound.
 */
export function applyRoleToLoopDeps<T extends RoleLoopSlice>(deps: T, now = deps.clock.now()): T {
  const role = deps.role;
  if (!role) return deps;

  const maxTurns = clampedTurnCeiling(role, deps.budget.max_turns_per_cycle);
  const deadlineMs = clampedDeadlineMs(role, deps.deadlineMs, now);
  const maxTokens = clampedMaxTokens(role, deps.maxTokens);
  const tools = filteredTools(role, deps.tools);
  const turnTimeoutMs = clampedTurnTimeoutMs(role, deps.turnTimeoutMs);

  const baseRefresh = deps.refreshTools;
  const refreshTools = baseRefresh
    ? () => {
        const fresh = baseRefresh();
        const filtered = filteredTools(role, fresh.tools);
        return {
          tools: filtered,
          specs: fresh.specs.filter((s) => isToolAllowed(role, s.name)),
        };
      }
    : undefined;

  return {
    ...deps,
    budget: { ...deps.budget, max_turns_per_cycle: maxTurns },
    maxTokens,
    tools,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    ...(refreshTools ? { refreshTools } : {}),
  };
}

/** Append the role system prompt and filter tool specs presented to the model. */
export function applyRoleToLoopContext<T extends { system: SystemBlock[]; tools: ToolSpec[] }>(
  ctx: T,
  role: RoleDefinition | undefined,
): T {
  if (!role) return ctx;
  const prompt = roleSystemPrompt(role);
  const tools = role.allowedTools?.length
    ? ctx.tools.filter((s) => isToolAllowed(role, s.name))
    : ctx.tools;
  return {
    ...ctx,
    tools,
    system: prompt ? [...ctx.system, { text: prompt }] : ctx.system,
  };
}

export { roleModelRoute };
