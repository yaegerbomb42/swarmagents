/**
 * Declarative role schema for the SwarmAgents / Omnexx engine.
 *
 * This is distinct from `config/roles.ts`, which is a model-routing pool
 * (chat / planner / worker / cheap / helpers). A RoleDefinition here is a
 * full agent persona: model, tools, MCP servers, permissions, and prompt.
 */

/** How an MCP server is mounted for a role. */
export type McpLoadMode = 'lazy' | 'eager';

export interface McpServerBinding {
  /** Server name as registered in the MCP mount layer. */
  name: string;
  /** `eager` is started with the loop; `lazy` is attached on first use. */
  load: McpLoadMode;
}

/**
 * Model provider, id, sampling, and turn/context/deadline clamps.
 * Built-in roles always set `provider` and `modelId`. Drafts that `extends`
 * a parent may omit them and inherit.
 */
export interface ModelConfig {
  provider: string;
  modelId: string;
  temperature?: number;
  /** Prompt / context-window clamp in tokens. */
  maxContextTokens?: number;
  /** Per-call output token clamp. */
  maxTokens?: number;
  /** Upper bound on turns in a single cycle. */
  maxTurns?: number;
  /** Per-turn timeout in milliseconds (maps onto withTurnTimeout-style clamps). */
  turnTimeoutMs?: number;
  /** Relative wall-clock deadline for the cycle, in milliseconds from start. */
  deadlineMs?: number;
}

/** Sandbox / capability flags from the role brief. */
export interface RolePermissions {
  readOnly: boolean;
  networkAllowed: boolean;
  commandExecutionAllowed: boolean;
}

/**
 * A role definition. Built-ins populate every field. Custom drafts may omit
 * fields and inherit them via `extends`.
 */
export interface RoleDefinition {
  id: string;
  name: string;
  description?: string;
  modelConfig?: Partial<ModelConfig>;
  allowedTools?: readonly string[];
  mcpServers?: readonly McpServerBinding[];
  systemPrompt?: string;
  permissions?: Partial<RolePermissions>;
  /**
   * Optional shorthand for `modelConfig.maxTurns`. When both are set,
   * `modelConfig.maxTurns` wins.
   */
  maxTurns?: number;
  /**
   * Optional shorthand for `modelConfig.deadlineMs`. When both are set,
   * `modelConfig.deadlineMs` wins.
   */
  maxDeadlineMs?: number;
  /** Parent role id for inheritance / override. */
  extends?: string;
}

export interface RoleValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
