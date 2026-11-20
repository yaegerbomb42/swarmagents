import type { RoleDefinition } from './types.js';
import type { Tool } from '../tools/types.js';

const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'str_replace',
  'multi_edit',
  'replace_lines',
  'write_file',
]);

const EXEC_TOOLS: ReadonlySet<string> = new Set(['bash']);

const NETWORK_TOOLS: ReadonlySet<string> = new Set([
  'web_fetch',
  'web_search',
  'browser',
  'mcp',
  'mcp_call',
  'mcp_search',
  'integrations_search',
  'integrations_install',
]);

/** Effective turn ceiling: `modelConfig.maxTurns` wins over the shorthand `maxTurns`. */
export function roleMaxTurns(role: RoleDefinition | undefined): number | undefined {
  return role?.modelConfig?.maxTurns ?? role?.maxTurns;
}

/** Effective relative deadline: `modelConfig.deadlineMs` wins over `maxDeadlineMs`. */
export function roleDeadlineMs(role: RoleDefinition | undefined): number | undefined {
  return role?.modelConfig?.deadlineMs ?? role?.maxDeadlineMs;
}

/**
 * Clamp the turn ceiling to the role-defined maximum. If neither
 * the role nor the global value is set, returns the global default.
 */
export function clampedTurnCeiling(role: RoleDefinition | undefined, globalMax: number): number {
  const roleMax = roleMaxTurns(role);
  const floorGlobal = Math.max(1, Math.floor(globalMax));
  if (roleMax !== undefined) return Math.max(1, Math.min(roleMax, floorGlobal));
  return floorGlobal;
}

/**
 * Clamp the absolute deadline to the role-defined relative deadline.
 * The role's deadline is measured from `cycleStartMs`.
 */
export function clampedDeadlineMs(
  role: RoleDefinition | undefined,
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
export function filteredTools(
  role: RoleDefinition | undefined,
  tools: readonly Tool[],
): readonly Tool[] {
  if (!role?.allowedTools?.length) return tools;
  const ok = new Set(role.allowedTools);
  return tools.filter((t) => ok.has(t.name));
}

/** Return true if the tool name is allowed by the whitelist alone. */
export function isToolAllowed(role: RoleDefinition | undefined, toolName: string): boolean {
  return toolDenialReason(role, toolName) === undefined;
}

/**
 * Why a tool call is rejected for this role, or undefined if it may run.
 * Checks the whitelist first, then permission flags (readOnly, network,
 * command execution).
 */
export function toolDenialReason(role: RoleDefinition | undefined, toolName: string): string | undefined {
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
export function toolDenialMessage(role: RoleDefinition | undefined, toolName: string): string | undefined {
  const reason = toolDenialReason(role, toolName);
  if (!reason) return undefined;
  return `Role tool denial: ${reason}`;
}

export class RoleToolDeniedError extends Error {
  constructor(
    readonly roleId: string,
    readonly toolName: string,
    readonly reason: string,
  ) {
    super(`Role "${roleId}" is not permitted to use tool "${toolName}": ${reason}`);
    this.name = 'RoleToolDeniedError';
  }
}

/** Throw if the tool is not permitted. Use in unit tests and callers that prefer exceptions. */
export function assertToolAllowed(role: RoleDefinition | undefined, toolName: string): void {
  const reason = toolDenialReason(role, toolName);
  if (reason && role) throw new RoleToolDeniedError(role.id, toolName, reason);
}

/** Clamp the provider max_tokens to the role's modelConfig.maxTokens. */
export function clampedMaxTokens(role: RoleDefinition | undefined, globalMaxTokens: number): number {
  if (role?.modelConfig?.maxTokens !== undefined) {
    return Math.min(role.modelConfig.maxTokens, globalMaxTokens);
  }
  return globalMaxTokens;
}

/** Clamp a per-turn timeout the way `withTurnTimeout` would. */
export function clampedTurnTimeoutMs(
  role: RoleDefinition | undefined,
  globalTimeoutMs: number | undefined,
): number | undefined {
  const roleTimeout = role?.modelConfig?.turnTimeoutMs;
  if (roleTimeout !== undefined && globalTimeoutMs !== undefined) {
    return Math.min(roleTimeout, globalTimeoutMs);
  }
  if (roleTimeout !== undefined) return roleTimeout;
  return globalTimeoutMs;
}

export function roleSystemPrompt(role: RoleDefinition | undefined): string | undefined {
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

export function roleModelRoute(role: RoleDefinition): RoleModelRoute {
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

/**
 * Race a promise against an AbortSignal. Reuses the loop's abortable idea
 * (`abortable` in agent/loop.ts); exported here because this checkout has
 * no existing `raceAbort` symbol.
 */
export async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    const err = new Error(String(signal.reason ?? 'aborted'));
    err.name = 'AbortError';
    throw err;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const err = new Error(String(signal.reason ?? 'aborted'));
      err.name = 'AbortError';
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
