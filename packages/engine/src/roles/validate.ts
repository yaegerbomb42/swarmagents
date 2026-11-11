import type { RoleDefinition, RoleValidationResult } from './types.js';

/** Every built-in tool name known to the engine. */
export const KNOWN_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'outline',
  'read_symbol',
  'search',
  'str_replace',
  'multi_edit',
  'replace_lines',
  'write_file',
  'bash',
  'read_log',
  'web_fetch',
  'web_search',
  'browser',
  'remember',
  'recall',
  'context',
  'running_context',
  'query_artifact',
  'repl_projection',
  'task',
  'todo',
  'define_contract',
  'more_tools',
  'request_tools',
  'mcp',
  'mcp_call',
  'mcp_search',
  'skill',
  'agent',
  'semantic_search',
  'integrations_search',
  'integrations_install',
  'list',
  'ts-check',
]);

const ID_RE = /^[a-z][a-z0-9-]*$/;

function clampField(name: string, value: number | undefined, errors: string[]): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    errors.push(`${name} must be a positive integer`);
  }
}

/**
 * Validate a role definition (resolved or draft).
 *
 * Unknown tool names are warnings, not errors, so custom MCP tools can be
 * whitelisted without failing validation.
 */
export function validateRole(role: RoleDefinition): RoleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!role.id || !role.id.trim().length) {
    errors.push('Role id is required');
  } else if (!ID_RE.test(role.id)) {
    errors.push(`Role id "${role.id}" must be kebab-case starting with a letter`);
  }
  if (!role.name || !role.name.trim().length) {
    errors.push('Role name is required');
  }
  const maxTurns = role.modelConfig?.maxTurns ?? role.maxTurns;
  const deadlineMs = role.modelConfig?.deadlineMs ?? role.maxDeadlineMs;
  clampField('maxTurns', maxTurns, errors);
  clampField('maxDeadlineMs', deadlineMs, errors);
  clampField('maxTokens', role.modelConfig?.maxTokens, errors);
  clampField('maxContextTokens', role.modelConfig?.maxContextTokens, errors);
  clampField('turnTimeoutMs', role.modelConfig?.turnTimeoutMs, errors);
  const temperature = role.modelConfig?.temperature;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    errors.push('modelConfig.temperature must be between 0 and 2');
  }
  if (role.allowedTools) {
    for (const t of role.allowedTools) {
      if (!t || typeof t !== 'string') {
        errors.push('allowedTools entries must be non-empty strings');
      } else if (!KNOWN_NATIVE_TOOLS.has(t)) {
        warnings.push(`Tool "${t}" is not a known native tool (possible MCP or custom tool)`);
      }
    }
  }
  if (role.mcpServers) {
    for (const s of role.mcpServers) {
      if (!s || typeof s.name !== 'string' || !s.name.trim().length) {
        errors.push('mcpServers entries must have a non-empty name');
      } else if (s.load !== 'lazy' && s.load !== 'eager') {
        errors.push(`mcpServers "${s.name}" load must be "lazy" or "eager"`);
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}
