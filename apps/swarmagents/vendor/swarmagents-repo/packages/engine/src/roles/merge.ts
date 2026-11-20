import type { McpServerBinding, ModelConfig, RoleDefinition, RolePermissions } from './types.js';

function mergeArrays<T>(
  parent: readonly T[] | undefined,
  child: readonly T[] | undefined,
): readonly T[] | undefined {
  if (child !== undefined) return child;
  return parent;
}

function mergeModelConfig(
  parent: RoleDefinition['modelConfig'],
  child: RoleDefinition['modelConfig'],
): RoleDefinition['modelConfig'] {
  if (!child) return parent;
  if (!parent) return child;
  const merged: Partial<ModelConfig> = {
    ...(parent.provider !== undefined || child.provider !== undefined
      ? { provider: child.provider ?? parent.provider }
      : {}),
    ...(parent.modelId !== undefined || child.modelId !== undefined
      ? { modelId: child.modelId ?? parent.modelId }
      : {}),
    ...(parent.temperature !== undefined || child.temperature !== undefined
      ? { temperature: child.temperature ?? parent.temperature }
      : {}),
    ...(parent.maxContextTokens !== undefined || child.maxContextTokens !== undefined
      ? { maxContextTokens: child.maxContextTokens ?? parent.maxContextTokens }
      : {}),
    ...(parent.maxTokens !== undefined || child.maxTokens !== undefined
      ? { maxTokens: child.maxTokens ?? parent.maxTokens }
      : {}),
    ...(parent.maxTurns !== undefined || child.maxTurns !== undefined
      ? { maxTurns: child.maxTurns ?? parent.maxTurns }
      : {}),
    ...(parent.turnTimeoutMs !== undefined || child.turnTimeoutMs !== undefined
      ? { turnTimeoutMs: child.turnTimeoutMs ?? parent.turnTimeoutMs }
      : {}),
    ...(parent.deadlineMs !== undefined || child.deadlineMs !== undefined
      ? { deadlineMs: child.deadlineMs ?? parent.deadlineMs }
      : {}),
  };
  return merged;
}

function mergePermissions(
  parent: RoleDefinition['permissions'],
  child: RoleDefinition['permissions'],
): RoleDefinition['permissions'] {
  if (!child) return parent;
  if (!parent) return child;
  const merged: Partial<RolePermissions> = {
    ...(parent.readOnly !== undefined || child.readOnly !== undefined
      ? { readOnly: child.readOnly ?? parent.readOnly }
      : {}),
    ...(parent.networkAllowed !== undefined || child.networkAllowed !== undefined
      ? { networkAllowed: child.networkAllowed ?? parent.networkAllowed }
      : {}),
    ...(parent.commandExecutionAllowed !== undefined || child.commandExecutionAllowed !== undefined
      ? { commandExecutionAllowed: child.commandExecutionAllowed ?? parent.commandExecutionAllowed }
      : {}),
  };
  return merged;
}

/**
 * Merge `child` onto `parent`. Every provided child field overrides the
 * parent; arrays (`allowedTools`, `mcpServers`) are replaced, not concatenated.
 * `extends` is cleared — ancestry is flattened after resolution.
 */
export function mergeRole(parent: RoleDefinition, child: RoleDefinition): RoleDefinition {
  const result: RoleDefinition = {
    id: child.id,
    name: child.name || parent.name || child.id,
  };
  const description = child.description ?? parent.description;
  if (description !== undefined) result.description = description;
  const modelConfig = mergeModelConfig(parent.modelConfig, child.modelConfig);
  if (modelConfig !== undefined) result.modelConfig = modelConfig;
  const allowedTools = mergeArrays(parent.allowedTools, child.allowedTools);
  if (allowedTools !== undefined) result.allowedTools = allowedTools;
  const mcpServers = mergeArrays<McpServerBinding>(parent.mcpServers, child.mcpServers);
  if (mcpServers !== undefined) result.mcpServers = mcpServers;
  const systemPrompt = child.systemPrompt ?? parent.systemPrompt;
  if (systemPrompt !== undefined) result.systemPrompt = systemPrompt;
  const permissions = mergePermissions(parent.permissions, child.permissions);
  if (permissions !== undefined) result.permissions = permissions;
  const maxTurns = child.maxTurns ?? parent.maxTurns;
  if (maxTurns !== undefined) result.maxTurns = maxTurns;
  const maxDeadlineMs = child.maxDeadlineMs ?? parent.maxDeadlineMs;
  if (maxDeadlineMs !== undefined) result.maxDeadlineMs = maxDeadlineMs;
  return result;
}
