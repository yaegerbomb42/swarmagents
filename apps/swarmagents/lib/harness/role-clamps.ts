/**
 * Role clamps — pure functions that bound a run to a role's limits.
 *
 * Ported from the vendored engine (`vendor/swarmagents-repo/packages/engine/src/
 * roles/filter.ts` + `bind.ts`) into the app so a role can actually cap the
 * work it is allowed to do: turn ceiling, wall-clock deadline, output tokens,
 * per-turn timeout, and a tool whitelist (with human-readable denial reasons).
 *
 * This module is deliberately pure and side-effect free. It does NOT load the
 * YAML role registry and it does NOT touch the runner/manager — wiring the
 * clamps into the run path is a separate change. Callers pass in a
 * {@link RunRequest} and a {@link RoleClamp}; with no role the request is
 * returned unchanged.
 *
 * `vendor/` is read-only reference material; nothing here imports from it.
 */

import type { RunRequest } from "./types";

/** Sandbox / capability flags that further restrict a role's tool surface. */
export interface RolePermissions {
  readOnly?: boolean;
  networkAllowed?: boolean;
  commandExecutionAllowed?: boolean;
}

/** Model / turn / deadline clamps carried by a role. */
export interface RoleModelConfig {
  provider?: string;
  modelId?: string;
  temperature?: number;
  /** Prompt / context-window clamp in tokens. */
  maxContextTokens?: number;
  /** Per-call output token clamp. */
  maxTokens?: number;
  /** Upper bound on turns in a single cycle. */
  maxTurns?: number;
  /** Per-turn timeout in milliseconds. */
  turnTimeoutMs?: number;
  /** Relative wall-clock deadline for the cycle, in milliseconds from start. */
  deadlineMs?: number;
}

/**
 * The subset of a role definition that bounds a run. Mirrors the engine's
 * `RoleDefinition` clamps: an id, an optional tool allowlist, permission
 * flags, and turn/deadline/token/timeout limits (either on the role directly
 * or nested under `modelConfig`).
 */
export interface RoleClamp {
  id: string;
  name?: string;
  allowedTools?: readonly string[];
  systemPrompt?: string;
  permissions?: RolePermissions;
  modelConfig?: RoleModelConfig;
  /** Shorthand for `modelConfig.maxTurns` (modelConfig wins when both set). */
  maxTurns?: number;
  /** Shorthand for `modelConfig.deadlineMs` (modelConfig wins when both set). */
  maxDeadlineMs?: number;
}

/** Tools that mutate files. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "str_replace",
  "multi_edit",
  "replace_lines",
  "write_file",
]);

/** Tools that execute commands. */
const EXEC_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/** Tools that reach the network. */
const NETWORK_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch",
  "web_search",
  "browser",
  "mcp",
  "mcp_call",
  "mcp_search",
  "integrations_search",
  "integrations_install",
]);

/** Effective turn ceiling: `modelConfig.maxTurns` wins over the shorthand `maxTurns`. */
export function roleMaxTurns(role: RoleClamp | undefined): number | undefined {
  return role?.modelConfig?.maxTurns ?? role?.maxTurns;
}

/** Effective relative deadline: `modelConfig.deadlineMs` wins over `maxDeadlineMs`. */
export function roleDeadlineMs(role: RoleClamp | undefined): number | undefined {
  return role?.modelConfig?.deadlineMs ?? role?.maxDeadlineMs;
}

/**
 * Clamp the turn ceiling to the role-defined maximum. If neither the role nor
 * the global value is set, returns the global default. The result is always at
 * least 1.
 */
export function clampedTurnCeiling(role: RoleClamp | undefined, globalMax: number): number {
  const roleMax = roleMaxTurns(role);
  const floorGlobal = Math.max(1, Math.floor(globalMax));
  if (roleMax !== undefined) return Math.max(1, Math.min(roleMax, floorGlobal));
  return floorGlobal;
}

/**
 * Clamp the absolute deadline to the role-defined relative deadline. The
 * role's deadline is measured from `cycleStartMs`.
 */
export function clampedDeadlineMs(
  role: RoleClamp | undefined,
  globalDeadlineMs: number | undefined,
  cycleStartMs: number,
): number | undefined {
  const relative = roleDeadlineMs(role);
  if (relative !== undefined && globalDeadlineMs !== undefined) {
    return Math.min(cycleStartMs + relative, globalDeadlineMs);
  }
  if (relative !== undefined) return cycleStartMs + relative;
  return globalDeadlineMs;
}

/** Filter a tool list by the role's allowedTools whitelist. */
export function filteredTools<T extends { name: string }>(
  role: RoleClamp | undefined,
  tools: readonly T[],
): readonly T[] {
  if (!role?.allowedTools?.length) return tools;
  const ok = new Set(role.allowedTools);
  return tools.filter((t) => ok.has(t.name));
}

/** Return true if the tool name is allowed by the role (whitelist + permissions). */
export function isToolAllowed(role: RoleClamp | undefined, toolName: string): boolean {
  return toolDenialReason(role, toolName) === undefined;
}

/**
 * Why a tool call is rejected for this role, or undefined if it may run.
 * Checks the whitelist first, then the permission flags (readOnly, network,
 * command execution).
 */
export function toolDenialReason(
  role: RoleClamp | undefined,
  toolName: string,
): string | undefined {
  if (!role) return undefined;
  if (role.allowedTools?.length && !role.allowedTools.includes(toolName)) {
    return `tool "${toolName}" is not in the "${role.id}" role whitelist`;
  }
  const perms = role.permissions;
  if (perms?.readOnly === true && EDIT_TOOLS.has(toolName)) {
    return `role "${role.id}" is read-only and cannot use "${toolName}"`;
  }
  if (perms?.commandExecutionAllowed === false && EXEC_TOOLS.has(toolName)) {
    return `role "${role.id}" is not permitted to execute commands ("${toolName}")`;
  }
  if (perms?.networkAllowed === false && NETWORK_TOOLS.has(toolName)) {
    return `role "${role.id}" is not permitted to use the network ("${toolName}")`;
  }
  return undefined;
}

/** Message stored on a rejected tool_result (does not throw inside the loop). */
export function toolDenialMessage(
  role: RoleClamp | undefined,
  toolName: string,
): string | undefined {
  const reason = toolDenialReason(role, toolName);
  if (!reason) return undefined;
  return `Role tool denial: ${reason}`;
}

/** Error thrown by {@link assertToolAllowed} when a tool is not permitted. */
export class RoleToolDeniedError extends Error {
  constructor(
    readonly roleId: string,
    readonly toolName: string,
    readonly reason: string,
  ) {
    super(`Role "${roleId}" is not permitted to use tool "${toolName}": ${reason}`);
    this.name = "RoleToolDeniedError";
  }
}

/** Throw if the tool is not permitted. Use in unit tests and callers that prefer exceptions. */
export function assertToolAllowed(role: RoleClamp | undefined, toolName: string): void {
  const reason = toolDenialReason(role, toolName);
  if (reason && role) throw new RoleToolDeniedError(role.id, toolName, reason);
}

/** Clamp the provider max_tokens to the role's modelConfig.maxTokens. */
export function clampedMaxTokens(role: RoleClamp | undefined, globalMaxTokens: number): number {
  if (role?.modelConfig?.maxTokens !== undefined) {
    return Math.min(role.modelConfig.maxTokens, globalMaxTokens);
  }
  return globalMaxTokens;
}

/** Clamp a per-turn timeout the way `withTurnTimeout` would. */
export function clampedTurnTimeoutMs(
  role: RoleClamp | undefined,
  globalTimeoutMs: number | undefined,
): number | undefined {
  const roleTimeout = role?.modelConfig?.turnTimeoutMs;
  if (roleTimeout !== undefined && globalTimeoutMs !== undefined) {
    return Math.min(roleTimeout, globalTimeoutMs);
  }
  if (roleTimeout !== undefined) return roleTimeout;
  return globalTimeoutMs;
}

/** The role's appended system prompt, when set. */
export function roleSystemPrompt(role: RoleClamp | undefined): string | undefined {
  return role?.systemPrompt;
}

/** Resolved model routing for a role. Throws if provider/modelId are missing. */
export interface RoleModelRoute {
  provider: string;
  modelId: string;
  temperature?: number;
  maxContextTokens?: number;
  maxTokens?: number;
}

/** Resolve the provider/model a role routes to. Throws when either is missing. */
export function roleModelRoute(role: RoleClamp): RoleModelRoute {
  const provider = role.modelConfig?.provider;
  const modelId = role.modelConfig?.modelId;
  if (!provider || !modelId) {
    throw new Error(`Role "${role.id}" is missing modelConfig.provider or modelConfig.modelId`);
  }
  const route: RoleModelRoute = { provider, modelId };
  if (role.modelConfig?.temperature !== undefined) route.temperature = role.modelConfig.temperature;
  if (role.modelConfig?.maxContextTokens !== undefined) {
    route.maxContextTokens = role.modelConfig.maxContextTokens;
  }
  if (role.modelConfig?.maxTokens !== undefined) route.maxTokens = role.modelConfig.maxTokens;
  return route;
}

/** The subset of loop deps a role can clamp or filter. */
export interface RoleLoopSlice {
  role?: RoleClamp;
  budget: { max_turns_per_cycle: number };
  maxTokens: number;
  deadlineMs?: number;
  tools: readonly { name: string }[];
  clock: { now: () => number };
  refreshTools?: () => { tools: readonly { name: string }[]; specs: readonly { name: string }[] };
  turnTimeoutMs?: number;
}

/**
 * Apply a bound role to loop dependencies: clamp turn ceiling, deadline, max
 * tokens, and turn timeout; filter the tool list (and refreshTools). Returns
 * `deps` unchanged when no role is bound.
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

/** Global limits the role clamps are applied against, when the caller knows them. */
export interface RoleClampOptions {
  /** Global turn ceiling; when set the role cannot exceed it. */
  globalMaxTurns?: number;
  /** Absolute global deadline (epoch ms). */
  globalDeadlineMs?: number;
  /** Reference start time for a relative role deadline (defaults to 0). */
  cycleStartMs?: number;
  /** Global output-token cap. */
  globalMaxTokens?: number;
  /** Global per-turn timeout (ms). */
  globalTurnTimeoutMs?: number;
}

/** A tool the role would reject, with the reason. */
export interface ToolDenial {
  tool: string;
  reason: string;
}

/** Resolved clamps for a run (only the values that are defined). */
export interface RunLimits {
  maxTurns?: number;
  deadlineMs?: number;
  maxTokens?: number;
  turnTimeoutMs?: number;
}

/** The result of applying a role to a {@link RunRequest}. */
export interface AppliedRoleRun {
  /** The request to run. `rolePhase.allowedTools` is narrowed to the role whitelist. */
  request: RunRequest;
  /** The turn / deadline / token / timeout clamps, where a limit is defined. */
  limits: RunLimits;
  /** Per-tool denial reasons for the request's role tool surface. */
  denials: ToolDenial[];
  /** True when the role changed the request (i.e. it filtered the tool list). */
  changed: boolean;
}

/**
 * Apply a role's clamps to a {@link RunRequest}.
 *
 * - With no role the original request is returned unchanged (same reference).
 * - The role's `allowedTools` whitelist narrows `request.rolePhase.allowedTools`
 *   (a copy is returned only when something is actually removed).
 * - Turn / deadline / token / timeout clamps are resolved against the supplied
 *   global limits (a limit is reported only when a global or role value exists).
 * - Every tool the role would reject is reported in `denials` with its reason.
 */
export function applyRoleToRunRequest(
  request: RunRequest,
  role: RoleClamp | undefined,
  opts: RoleClampOptions = {},
): AppliedRoleRun {
  if (!role) return { request, limits: {}, denials: [], changed: false };

  const now = opts.cycleStartMs ?? 0;

  const limits: RunLimits = {};
  if (opts.globalMaxTurns !== undefined) {
    limits.maxTurns = clampedTurnCeiling(role, opts.globalMaxTurns);
  }
  if (opts.globalDeadlineMs !== undefined || roleDeadlineMs(role) !== undefined) {
    const deadlineMs = clampedDeadlineMs(role, opts.globalDeadlineMs, now);
    if (deadlineMs !== undefined) limits.deadlineMs = deadlineMs;
  }
  if (opts.globalMaxTokens !== undefined) {
    limits.maxTokens = clampedMaxTokens(role, opts.globalMaxTokens);
  }
  if (opts.globalTurnTimeoutMs !== undefined || role.modelConfig?.turnTimeoutMs !== undefined) {
    const turnTimeoutMs = clampedTurnTimeoutMs(role, opts.globalTurnTimeoutMs);
    if (turnTimeoutMs !== undefined) limits.turnTimeoutMs = turnTimeoutMs;
  }

  // Narrow the request's role tool surface to the whitelist.
  let next = request;
  let changed = false;
  const phase = request.rolePhase;
  if (phase && role.allowedTools?.length) {
    const allowed = new Set(role.allowedTools);
    const filtered = phase.allowedTools.filter((t) => allowed.has(t));
    if (filtered.length !== phase.allowedTools.length) {
      next = { ...request, rolePhase: { ...phase, allowedTools: filtered } };
      changed = true;
    }
  }

  // Report why each tool the role would reject is denied.
  const denials: ToolDenial[] = [];
  if (phase) {
    for (const tool of phase.allowedTools) {
      const reason = toolDenialReason(role, tool);
      if (reason) denials.push({ tool, reason });
    }
  }

  return { request: next, limits, denials, changed };
}