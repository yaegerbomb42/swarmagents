export type ApiFormat = 'openai' | 'anthropic' | 'gemini' | 'cohere' | 'responses';
export type RotationStrategy = 'ranked_fallback' | 'round_robin' | 'racing' | 'random';

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  format: ApiFormat;
  keyHint: string;
  color: string;
  local?: boolean;
}

export interface ProviderConfig {
  uid: string;
  presetId: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  format: ApiFormat;
  color: string;
  enabled: boolean;
  priority?: number;
}

export interface McpSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  type: 'terminal' | 'browser' | 'filesystem' | 'database' | 'github' | 'custom';
}

export interface RolePreset {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  prompt: string;
  hue: number;
  tools: string[];
  mcpSkills: string[];
}

export interface ActiveRole extends RolePreset {
  uid: string;
  providerUid: string | 'sim';
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
  kind: 'image' | 'video' | 'audio' | 'text' | 'file';
  url: string;
  dataUrl?: string;
  text?: string;
  /** The original File handle, kept so the upload can read exact bytes at send time. */
  file?: File;
}

export interface VmState {
  id: string;
  status: 'running' | 'resetting' | 'stopped';
  ip?: string;
  os: 'linux-debian';
  activeRole: string;
  uptimeSeconds: number;
  lastWipeAt?: number;
  currentDirectory: string;
  activeProcesses: string[];
}

export const PROVIDERS: ProviderPreset[] = [
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest', format: 'anthropic', keyHint: 'sk-ant-…', color: '#d97757' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', format: 'openai', keyHint: 'sk-…', color: '#10a37f' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-1.5-pro', format: 'gemini', keyHint: 'AIza…', color: '#4285f4' },
  { id: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', format: 'openai', keyHint: 'xai-…', color: '#e5e5e5' },
  { id: 'meta', name: 'Meta Muse', baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3', format: 'openai', keyHint: 'MODEL_API_KEY', color: '#0082fb' },
  { id: 'arena', name: 'Arena', baseUrl: 'https://api.arena.ai/v1', model: 'coding-router-preview', format: 'responses', keyHint: 'ARENA_API_KEY', color: '#f59e0b' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', format: 'openai', keyHint: 'sk-…', color: '#4d6bfe' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant', format: 'openai', keyHint: 'gsk_…', color: '#f55036' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o', format: 'openai', keyHint: 'sk-or-…', color: '#8b5cf6' },
  { id: 'ollama', name: 'Ollama / Local', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', format: 'openai', keyHint: 'not required', color: '#ffffff', local: true },
  { id: 'custom', name: 'Custom Gateway (LiteLLM / Claude Code proxy)', baseUrl: 'http://localhost:8000/v1', model: 'custom-model', format: 'openai', keyHint: 'optional', color: '#94a3b8' },
];

/**
 * Frontier agent harnesses — the external agent stacks the user can point
 * A1 at, surfaced as one section in Settings (Providers tab). A "harness"
 * here is the frontier lab's agent stack, not just its model API: each
 * entry wires up that lab's provider preset in one click (reusing the
 * normal provider-setup flow) and notes how the harness itself is used.
 * The provider preset is the thing A1 actually calls; the harness note
 * tells the user where that same key / endpoint also drives the lab's own
 * terminal agent (Muse Code, Codex) or that there is nothing extra to
 * install (Grok, which A1 drives straight through the xAI API).
 */
export interface FrontierHarness {
  id: string;
  name: string;
  blurb: string;
  /** Id of the one-click provider preset in PROVIDERS this harness configures. */
  presetId: string;
  /** How the lab's own harness is used (or that there is none to install). */
  harnessNote: string;
}

export const FRONTIER_HARNESSES: FrontierHarness[] = [
  {
    id: 'grok',
    name: 'Grok',
    blurb: 'xAI frontier models via the OpenAI-compatible xAI API.',
    presetId: 'xai',
    harnessNote: 'A1 drives Grok straight through the xAI API — no separate harness to install.',
  },
  {
    id: 'muse',
    name: 'Muse',
    blurb: 'Meta frontier models via the Meta Model API (OpenAI-compatible).',
    presetId: 'meta',
    harnessNote: 'Muse Code is Meta’s terminal coding agent — install `muse`; it signs in with the same Model API key and runs on Muse Spark.',
  },
  {
    id: 'arena',
    name: 'Arena',
    blurb: 'Frontier models via the Arena API (OpenAI Responses wire format).',
    presetId: 'arena',
    harnessNote: 'Arena doubles as a Codex model provider — the same key and base URL configure Codex.',
  },
];

export const DEFAULT_MCP_SKILLS: McpSkill[] = [
  { id: 'terminal-exec', name: 'Bash & Terminal', description: 'Executes zsh/bash commands, git, build runners directly in the Linux VM', enabled: true, type: 'terminal' },
  { id: 'browser-live', name: 'Live Headed Browser', description: 'Interactive Chromium session streamed directly into user dashboard', enabled: true, type: 'browser' },
  { id: 'file-editor', name: 'Surgical File Editor', description: 'Atomic file reading, writing, and diff-based code patching', enabled: true, type: 'filesystem' },
  { id: 'postgres-mcp', name: 'PostgreSQL MCP', description: 'Direct DB query execution, migrations and schema inspector', enabled: false, type: 'database' },
  { id: 'github-mcp', name: 'GitHub Integration', description: 'Branch management, pull request drafting, and commit checks', enabled: true, type: 'github' },
];

export const ROLES: RolePreset[] = [
  {
    id: 'general',
    name: 'Autonomous Engineer',
    icon: 'Bot',
    blurb: 'Full-capability software engineer with shell, browser & editor',
    prompt: 'You are the Autonomous Principal Systems Engineer with direct access to your dedicated Linux computer. You write clean, tested code, run verification pipelines, and manage your environment with care.',
    hue: 215,
    tools: ['bash', 'file_editor', 'browser', 'git'],
    mcpSkills: ['terminal-exec', 'browser-live', 'file-editor', 'github-mcp'],
  },
  {
    id: 'coder',
    name: 'Code Implementer',
    icon: 'Code2',
    blurb: 'Deep focus on code changes, test passes, and AST hygiene',
    prompt: 'You are the Code Implementer. Focus exclusively on exact code edits, running unit tests, fixing syntax issues, and staging changes atomically.',
    hue: 140,
    tools: ['bash', 'file_editor'],
    mcpSkills: ['terminal-exec', 'file-editor'],
  },
  {
    id: 'researcher',
    name: 'Codebase Researcher',
    icon: 'Search',
    blurb: 'Read-only exploration, ripgrep, AST discovery, web search',
    prompt: 'You are the Codebase Researcher. Survey existing patterns, dependencies, and architecture. Never modify files directly.',
    hue: 170,
    tools: ['ripgrep', 'cat', 'browser'],
    mcpSkills: ['browser-live', 'terminal-exec'],
  },
  {
    id: 'devops',
    name: 'DevOps & Cloud Operator',
    icon: 'Database',
    blurb: 'Container management, deployment scripts, system administration',
    prompt: 'You are the DevOps & Cloud Operator. Handle Docker, process management, deploy scripts, and VPS operations.',
    hue: 35,
    tools: ['bash', 'docker', 'curl'],
    mcpSkills: ['terminal-exec', 'postgres-mcp'],
  },
  {
    id: 'critic',
    name: 'Auditor & QA Verifier',
    icon: 'ShieldAlert',
    blurb: 'Validates outcomes, runs 3-phase verification rubrics',
    prompt: 'You are the Auditor & QA Verifier. Perform rigorous phase-by-phase verification, inspect diffs, test edge cases, and enforce security policies.',
    hue: 0,
    tools: ['git_diff', 'npm_test', 'browser'],
    mcpSkills: ['terminal-exec', 'browser-live'],
  },
];

/**
 * Legacy Why file default. The Why file UI is gone — replaced by the Agent
 * Card. This constant is kept only so client-side migration can detect a
 * user's custom Why text and fold it into the card once.
 */
export const DEFAULT_WHY_FILE = `# Autonomous Agent Institutional Knowledge (WHY.md)

## Current Objective & Identity
- Single unified agent running on a dedicated persistent Linux computer.
- Connected to user-selected provider pool with intelligent rotation & fallback.
- Operates in strict 3-phase verification (Preflight Contract -> Milestone -> Semantic Acceptance).

## Active Decisions
1. **Single Agent Architecture**: Avoids thrashing and context fragmentation across multiple disconnected subagents. One agent switches roles smoothly.
2. **Dedicated Cloud Machine**: Preserves installed tools, terminal history, and local files between tasks with instant factory-reset capability.
3. **Multi-Provider Engine**: Supports Claude Code harness proxying, OpenAI, Gemini, Groq, and local Ollama with automatic failover.
`;

/**
 * Default Agent Card text. The card IS the role: it is sent with every
 * dispatched task as the appended system prompt, so this text describes who
 * the agent is and the objectives it works from on the user's own VM.
 */
export const DEFAULT_AGENT_CARD = `I am A1, your autonomous engineer, running directly on your dedicated Linux cloud computer. I work transparently: I explain what I am doing and why as I do it, and I keep you in the loop the whole way. I treat your workspace as my own, leave it clean, and verify my own work before calling a task done.

Main objectives:
- Work transparently: share what I'm doing and why, while I'm doing it.
- Ask approval before risky actions: anything destructive, irreversible, or costly gets your explicit OK first.
- Explain as I go: narrate each step so you always know the current state.
- Finish the goal: deliver a working result, verified with tests and builds, and report exactly what changed.
`;

export const uid = () => Math.random().toString(36).slice(2, 10);
export const MIN_ROLES = 1;
export const MAX_ROLES = 10;

