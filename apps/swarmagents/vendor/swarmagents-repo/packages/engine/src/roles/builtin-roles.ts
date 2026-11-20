import type { RoleDefinition } from './types.js';

const READ_AST = ['read', 'outline', 'search', 'read_symbol', 'list'] as const;
const MEMORY = ['remember', 'recall', 'context', 'running_context', 'query_artifact'] as const;
const EDIT = ['str_replace', 'multi_edit', 'replace_lines', 'write_file'] as const;
const SHELL = ['bash', 'read_log'] as const;
const WEB = ['web_search', 'web_fetch'] as const;

/**
 * Orchestrator — high-reasoning coordinator: triage, planning, and delegation.
 */
export const orchestratorRole: RoleDefinition = {
  id: 'orchestrator',
  name: 'Orchestrator',
  description:
    'High-reasoning coordinator. Triages work, plans, and delegates to other roles. Does not mutate the tree itself.',
  modelConfig: {
    provider: 'anthropic',
    modelId: 'claude-opus',
    temperature: 0.3,
    maxContextTokens: 200_000,
    maxTokens: 16_384,
    maxTurns: 24,
    turnTimeoutMs: 180_000,
    deadlineMs: 3_600_000,
  },
  allowedTools: [...READ_AST, 'task', 'agent', 'todo', ...MEMORY],
  mcpServers: [],
  systemPrompt:
    'You are the orchestrator. Triage the request, plan the work, and delegate via the task/agent tools. Do not edit files or run shell commands yourself. Produce a clear plan and hand work to the right role.',
  permissions: { readOnly: true, networkAllowed: false, commandExecutionAllowed: false },
  maxTurns: 24,
  maxDeadlineMs: 3_600_000,
};

/**
 * Researcher — fast, low-cost; read-only filesystem, web and AST tools, no edits.
 */
export const researcherRole: RoleDefinition = {
  id: 'researcher',
  name: 'Researcher',
  description:
    'Fast, low-cost researcher. Reads the tree, searches the web, and analyses AST/symbols. Never edits files or runs commands.',
  modelConfig: {
    provider: 'anthropic',
    modelId: 'claude-haiku',
    temperature: 0.2,
    maxContextTokens: 100_000,
    maxTokens: 8_192,
    maxTurns: 18,
    turnTimeoutMs: 90_000,
    deadlineMs: 1_800_000,
  },
  allowedTools: [...READ_AST, ...WEB, 'semantic_search', ...MEMORY.filter((n) => n !== 'running_context')],
  mcpServers: [{ name: 'web', load: 'lazy' }],
  systemPrompt:
    'You are a researcher. Gather evidence by reading the codebase and searching the web. You are read-only: do not edit files, and do not run shell commands. Return concise findings with citations (paths, line ranges, URLs).',
  permissions: { readOnly: true, networkAllowed: true, commandExecutionAllowed: false },
  maxTurns: 18,
  maxDeadlineMs: 1_800_000,
};

/**
 * Implementer (alias: coder) — precise code generation, file edits, scoped test runner.
 */
export const implementerRole: RoleDefinition = {
  id: 'implementer',
  name: 'Implementer',
  description:
    'High-precision implementer. Edits files and runs a scoped test runner (bash limited to tests and typechecks).',
  modelConfig: {
    provider: 'anthropic',
    modelId: 'claude-sonnet',
    temperature: 0.1,
    maxContextTokens: 200_000,
    maxTokens: 16_384,
    maxTurns: 40,
    turnTimeoutMs: 180_000,
    deadlineMs: 5_400_000,
  },
  allowedTools: [
    ...READ_AST,
    ...EDIT,
    ...SHELL,
    'ts-check',
    'todo',
    'repl_projection',
    'task',
    ...MEMORY,
  ],
  mcpServers: [],
  systemPrompt:
    'You are the implementer (coder). Write precise, minimal code changes. Use bash only as a scoped test runner (unit tests, typecheck, formatters). Do not deploy, and do not reach the network. Verify your work before reporting done.',
  permissions: { readOnly: false, networkAllowed: false, commandExecutionAllowed: true },
  maxTurns: 40,
  maxDeadlineMs: 5_400_000,
};

/**
 * Auditor — diffs, lint, and security analysis.
 */
export const auditorRole: RoleDefinition = {
  id: 'auditor',
  name: 'Auditor',
  description:
    'Analytical reviewer. Inspects diffs, runs lint/security checks, and reports findings. Does not write product code.',
  modelConfig: {
    provider: 'anthropic',
    modelId: 'claude-sonnet',
    temperature: 0,
    maxContextTokens: 200_000,
    maxTokens: 8_192,
    maxTurns: 20,
    turnTimeoutMs: 120_000,
    deadlineMs: 2_400_000,
  },
  allowedTools: [...READ_AST, ...SHELL, 'ts-check', 'remember', 'recall', 'context', 'query_artifact'],
  mcpServers: [],
  systemPrompt:
    'You are the auditor. Review diffs for correctness, lint issues, and security problems. You may run read-only check commands (lint, test, tsc). Do not modify product files; report findings clearly.',
  permissions: { readOnly: true, networkAllowed: false, commandExecutionAllowed: true },
  maxTurns: 20,
  maxDeadlineMs: 2_400_000,
};

/**
 * DevOps — deterministic scripts (deploy.sh, Docker, compose, process management).
 */
export const devopsRole: RoleDefinition = {
  id: 'devops',
  name: 'DevOps',
  description:
    'Deterministic operator for deploy.sh, Docker, compose, and process management.',
  modelConfig: {
    provider: 'anthropic',
    modelId: 'claude-sonnet',
    temperature: 0,
    maxContextTokens: 100_000,
    maxTokens: 8_192,
    maxTurns: 30,
    turnTimeoutMs: 240_000,
    deadlineMs: 3_600_000,
  },
  allowedTools: [...READ_AST, ...SHELL, ...EDIT, 'todo', 'task', ...MEMORY],
  mcpServers: [],
  systemPrompt:
    'You are the devops operator. Prefer deterministic, scripted actions: deploy.sh, Docker, compose, and process management. Keep changes minimal and reversible. Confirm each step against logs before proceeding.',
  permissions: { readOnly: false, networkAllowed: true, commandExecutionAllowed: true },
  maxTurns: 30,
  maxDeadlineMs: 3_600_000,
};

/** All pre-registered built-in roles shipped with the engine. */
export const BUILTIN_ROLES: readonly RoleDefinition[] = [
  orchestratorRole,
  researcherRole,
  implementerRole,
  auditorRole,
  devopsRole,
];

/**
 * Alternate ids that resolve to a built-in. `coder` is the specified alias
 * of `implementer`. A later `register({ id: 'coder' })` overrides the alias.
 */
export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  coder: 'implementer',
};
