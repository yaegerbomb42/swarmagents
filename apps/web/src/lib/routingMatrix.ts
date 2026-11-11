/**
 * Role → provider / model / quota routing matrix.
 */

export type AgentRole =
  | 'architect'
  | 'planning'
  | 'coding'
  | 'research'
  | 'validation'
  | 'browser'
  | 'execution';

export interface RoleRoute {
  role: AgentRole;
  label: string;
  description: string;
  provider: string;
  model: string;
  /** Fallback chain: "provider:model" */
  fallbacks: string[];
  rpmLimit: number;
  dailyBudgetUsd: number;
  maxConcurrent: number;
  enabled: boolean;
}

export interface RouteUsage {
  role: AgentRole;
  callsToday: number;
  tokensToday: number;
  spendUsd: number;
  rpmWindow: number; // calls in last 60s
  lastCallAt?: number;
}

export interface RoutingMatrix {
  version: 1;
  updatedAt: string;
  routes: RoleRoute[];
  usage: RouteUsage[];
}

export const ROLE_META: Record<
  AgentRole,
  { label: string; description: string; defaultProvider: string; defaultModel: string }
> = {
  architect: {
    label: 'Decomp / Architect',
    description: 'Top-level decomposition & hard reasoning',
    defaultProvider: 'azure',
    defaultModel: 'DeepSeek-V4-Flash',
  },
  planning: {
    label: 'Planning',
    description: 'Branch plans, dependency ordering',
    defaultProvider: 'azure',
    defaultModel: 'DeepSeek-V4-Flash',
  },
  coding: {
    label: 'Coding (grunt)',
    description: 'Atomic code edits for small local models',
    defaultProvider: 'lambo',
    defaultModel: 'lambo-2.1b',
  },
  research: {
    label: 'Research',
    description: 'Web / docs lookup',
    defaultProvider: 'groq',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  validation: {
    label: 'Validation',
    description: 'QA, tests, acceptance checks',
    defaultProvider: 'azure',
    defaultModel: 'DeepSeek-V4-Flash',
  },
  browser: {
    label: 'Browser',
    description: 'CDP navigation & scraping',
    defaultProvider: 'azure',
    defaultModel: 'gpt-5-nano',
  },
  execution: {
    label: 'Execution',
    description: 'Shell / general worker',
    defaultProvider: 'ollama',
    defaultModel: 'qwen2.5:14b',
  },
};

export const PROVIDER_OPTIONS = [
  { id: 'modal', label: 'Modal Labs (Free Gemma 4)' },
  { id: 'azure', label: 'Azure AI Foundry' },
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'lambo', label: 'LAMBO 2.1B (Local Swarm)' },
  { id: 'groq', label: 'Groq' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'custom', label: 'Custom endpoint' },
] as const;

export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  modal: ['ep-gemma-4-31b-it', 'gemma-4-31b-it'],
  azure: [
    'DeepSeek-V4-Flash',
    'DeepSeek-V4-Pro',
    'gpt-5-nano',
    'grok-4.3',
    'Kimi-K2.6',
  ],
  ollama: [
    'lambo-2.1b',
    'deepseek-r1-0528-qwen3:8b',
    'qwen2.5:14b',
    'qwen2.5:32b',
    'llama3.1:8b',
    'qwen3.6-27b:q4_k_m',
  ],
  lambo: ['lambo-2.1b', 'lambo-2.1b-q4_k_m.gguf'],
  groq: ['llama-3.3-70b-versatile', 'qwen-qwq-32b', 'deepseek-r1-distill-llama-70b'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
  anthropic: ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  cerebras: ['llama-3.3-70b', 'qwen-3-235b'],
  custom: [],
};

export function defaultRoute(role: AgentRole): RoleRoute {
  const meta = ROLE_META[role];
  const defaults: Record<AgentRole, Partial<RoleRoute>> = {
    architect: { rpmLimit: 30, dailyBudgetUsd: 25, maxConcurrent: 1 },
    planning: { rpmLimit: 40, dailyBudgetUsd: 10, maxConcurrent: 2 },
    coding: { rpmLimit: 120, dailyBudgetUsd: 2, maxConcurrent: 8 },
    research: { rpmLimit: 60, dailyBudgetUsd: 8, maxConcurrent: 3 },
    validation: { rpmLimit: 40, dailyBudgetUsd: 8, maxConcurrent: 2 },
    browser: { rpmLimit: 30, dailyBudgetUsd: 5, maxConcurrent: 2 },
    execution: { rpmLimit: 100, dailyBudgetUsd: 1, maxConcurrent: 6 },
  };
  return {
    role,
    label: meta.label,
    description: meta.description,
    provider: meta.defaultProvider,
    model: meta.defaultModel,
    fallbacks: ['modal:ep-gemma-4-31b-it'],
    rpmLimit: defaults[role].rpmLimit ?? 60,
    dailyBudgetUsd: defaults[role].dailyBudgetUsd ?? 5,
    maxConcurrent: defaults[role].maxConcurrent ?? 2,
    enabled: true,
  };
}

export function defaultUsage(role: AgentRole): RouteUsage {
  return {
    role,
    callsToday: 0,
    tokensToday: 0,
    spendUsd: 0,
    rpmWindow: 0,
  };
}

export function createDefaultMatrix(): RoutingMatrix {
  const roles = Object.keys(ROLE_META) as AgentRole[];
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    routes: roles.map(defaultRoute),
    usage: roles.map(defaultUsage),
  };
}

/** Map agent_class / model_tier → role for runtime lookup */
export function roleForAgentClass(agentClass?: string, modelTier?: string): AgentRole {
  const c = (agentClass || '').toLowerCase();
  const t = (modelTier || '').toLowerCase();
  if (c === 'architect' || c === 'orchestrator' || t === 'architect') return 'architect';
  if (c === 'research' || c === 'researcher') return 'research';
  if (c === 'qa' || c === 'validator' || c === 'validation') return 'validation';
  if (c === 'frontend' || c === 'backend' || c === 'specialist' || c === 'coding') return 'coding';
  if (c === 'planning' || c === 'planner') return 'planning';
  if (c === 'browser') return 'browser';
  if (t === 'grunt') return 'coding';
  return 'execution';
}

export function resolveRoute(
  matrix: RoutingMatrix,
  role: AgentRole
): RoleRoute | undefined {
  return matrix.routes.find((r) => r.role === role && r.enabled);
}

export function usagePct(used: number, limit: number): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

/** Convert matrix → legacy Configuration shape for engine PUT */
export function matrixToEngineConfig(matrix: RoutingMatrix): {
  orchestrator: { providers: Array<Record<string, unknown>> };
  workers: { providers: Array<Record<string, unknown>> };
  role_routes: RoleRoute[];
} {
  const arch = resolveRoute(matrix, 'architect') || defaultRoute('architect');
  const workers = matrix.routes
    .filter((r) => r.role !== 'architect' && r.enabled)
    .map((r, i) => ({
      type: r.provider,
      model: r.model,
      priority: i + 1,
      task_types: [r.role],
      rpm_limit: r.rpmLimit,
      daily_budget_usd: r.dailyBudgetUsd,
      max_concurrent: r.maxConcurrent,
      fallbacks: r.fallbacks,
      has_api_key: r.provider !== 'ollama' && r.provider !== 'custom',
    }));

  return {
    orchestrator: {
      providers: [
        {
          type: arch.provider,
          model: arch.model,
          priority: 1,
          task_types: ['architect', 'planning'],
          rpm_limit: arch.rpmLimit,
          daily_budget_usd: arch.dailyBudgetUsd,
          max_concurrent: arch.maxConcurrent,
          fallbacks: arch.fallbacks,
          has_api_key: true,
        },
      ],
    },
    workers: { providers: workers },
    role_routes: matrix.routes,
  };
}
