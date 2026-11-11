// Persistent model-picker state. The chosen model + endpoint + API key + LoRA adapter
// path drives EVERY LLM call in the app — conductor chat, sub-agents, and the 3D
// office scene's agent brains all read from this single store.

'use client';

import { useSyncExternalStore } from 'react';
import { GATEWAY_CHAT_PATH } from '@/lib/providerRouter';

export type ProviderId =
  | 'azure'
  | 'ollama-local'
  | 'lambo-local'
  | 'mlx-local'
  | 'openai'
  | 'groq'
  | 'cerebras'
  | 'anthropic'
  | 'huggingface'
  | 'watsonx'
  | 'nvidia-nim'
  | 'gemini'
  | 'mistral'
  | 'novita'
  | 'openrouter'
  | 'vps-testing'
  | 'antigravity'
  | 'swarmagent-local'
  | 'custom';

export interface ModelConfig {
  providerId: ProviderId;
  /** Display label (filled in from preset, user-editable) */
  label: string;
  /** OpenAI-compatible endpoint URL (chat/completions, /api/generate, /v1/messages, …) */
  endpoint: string;
  /** Model name registered with the endpoint */
  model: string;
  /** Bearer / x-api-key for cloud providers (empty for local) */
  apiKey: string;
  /** Optional LoRA adapter path (filename relative to ~/models for MLX, or HF repo id) */
  loraAdapter: string;
  /** System prompt prefix — appended to every conductor + sub-agent call */
  systemPrompt: string;
}

const PRESETS: Record<ProviderId, Partial<ModelConfig>> = {
  'azure': {
    label: 'Azure AI Foundry (via engine gateway)',
    // Routes dashboard → engine gateway → Azure AI Foundry. Never call a
    // provider directly from the browser; the gateway injects credentials.
    endpoint: GATEWAY_CHAT_PATH,
    model: 'DeepSeek-V4-Flash', // Default: fast + free-tier friendly
    apiKey: '',
  },
  'ollama-local': {
    label: 'Ollama (local)',
    endpoint: 'http://localhost:11434/api/generate',
    model: 'qwen2.5:3b',
    apiKey: '',
  },
  'lambo-local': {
    label: 'LAMBO 2.1B (Local Swarm)',
    endpoint: 'http://localhost:11434/api/chat',
    model: 'lambo-2.1b',
    apiKey: '',
    systemPrompt: `You are LAMBO 2.1B (local swarm agent). Context window 131072.
Reason in <thought>…</thought> then act with <action type="mcp_call">…</action>.
Zero cloud API cost.`,
  },
  'mlx-local': {
    label: 'MLX (local, Apple Silicon)',
    endpoint: 'http://localhost:8080/v1/chat/completions',
    model: 'meta-llama/Llama-3.1-8B-Instruct',
    apiKey: '',
    loraAdapter: '',
  },
  'openai': {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    apiKey: '',
  },
  'groq': {
    label: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    apiKey: '',
  },
  'cerebras': {
    label: 'Cerebras',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    model: 'llama3.1-70b',
    apiKey: '',
  },
  'anthropic': {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-3-5-haiku-20241022',
    apiKey: '',
  },
  'huggingface': {
    label: 'Hugging Face Inference',
    endpoint: 'https://api-inference.huggingface.co/models',
    model: 'meta-llama/Llama-3.1-8B-Instruct',
    apiKey: '',
  },
  'watsonx': {
    label: 'Watsonx (IBM)',
    endpoint: 'https://us-south.ml.cloud.ibm.com/ml/v1/text/generation?version=2024-05-01',
    model: 'openai/gpt-oss-120b',
    apiKey: '',
  },
  'nvidia-nim': {
    label: 'NVIDIA NIM',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'meta/llama-3.3-70b-instruct',
    apiKey: '',
  },
  'gemini': {
    label: 'Gemini (Google)',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    apiKey: '',
  },
  'mistral': {
    label: 'Mistral',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-large-latest',
    apiKey: '',
  },
  'novita': {
    label: 'Novita AI',
    endpoint: 'https://api.novita.ai/v3/openai/chat/completions',
    model: 'meta-llama/llama-3.3-70b-instruct',
    apiKey: '',
  },
  'openrouter': {
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'meta-llama/llama-3.3-70b-instruct',
    apiKey: '',
  },
  'vps-testing': {
    label: 'VPS Testing Fleet (11 days)',
    endpoint: 'http://194.113.75.201:8000/v1/chat/completions',
    model: 'hamiltonian',
    apiKey: 'sk-1234',
  },
  'antigravity': {
    label: 'Google Antigravity (Preview)',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'antigravity-preview-05-2026',
    apiKey: '',
  },
  'swarmagent-local': {
    label: 'SwarmAgent Local',
    endpoint: 'http://localhost:11434/api/generate',
    model: 'swarmagent-core-16.9b',
    apiKey: '',
  },
  'custom': {
    label: 'Custom endpoint',
    endpoint: 'http://localhost:8000/v1/chat/completions',
    model: '',
    apiKey: '',
  },
};

// Azure AI Foundry models available via the engine gateway
// Live deployments only (2026-08); tiers drive default semantic-routing caps.
export const AZURE_MODELS = {
  tier1: [
    'DeepSeek-V4-Pro',       // Advanced reasoning
    'grok-4.3',              // xAI flagship
    'Kimi-K2.6',             // Moonshot reasoning
  ],
  tier2: [
    'DeepSeek-V4-Flash',     // Fast default
    'gpt-5-nano',            // Ultra-fast, paid-tier public
  ],
};

const DEFAULT_SYSTEM = `You are the Swarm Conductor — a single agent that IS the entire SwarmAgents system. You think out loud, spawn specialized sub-agents (Reasoner, Coder, Researcher, Executor, Validator, Memory) for parts of the work, and synthesize their outputs into a final answer.

When you decide a sub-agent is needed, emit a block like:
<spawn role="reasoner" task="analyze the constraints of the user's request"/>
<spawn role="coder" task="write a TypeScript snippet that ..."/>

You may emit multiple spawn blocks in one turn. After spawning, continue your response. The orchestrator will run each sub-agent and inject its result, then re-prompt you for synthesis.

Available roles: reasoner, coder, researcher, executor, validator, memory, navigator, planner.

Always be concise, technical, and confident. Never refuse a task — design around constraints instead.`;

const INITIAL: ModelConfig = (() => {
  const preset = PRESETS['azure'];
  return {
    providerId: 'azure',
    label: preset.label!,
    endpoint: preset.endpoint!,
    model: preset.model!,
    apiKey: preset.apiKey ?? '',
    loraAdapter: '',
    systemPrompt: DEFAULT_SYSTEM,
  };
})();

const STORAGE_KEY = 'swarmagents.model.v1';

function loadFromStorage(): ModelConfig {
  if (typeof window === 'undefined') return INITIAL;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL;
    const parsed = JSON.parse(raw);
    return { ...INITIAL, ...parsed };
  } catch {
    return INITIAL;
  }
}

let state: ModelConfig = INITIAL;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(l => l());
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }
}

// Hydrate from localStorage on first access from the client.
let hydrated = false;
function hydrate() {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  state = loadFromStorage();
  emit();
}

export const modelStore = {
  get: () => state,
  subscribe: (l: () => void) => { listeners.add(l); hydrate(); return () => listeners.delete(l); },
  set: (patch: Partial<ModelConfig>) => { state = { ...state, ...patch }; emit(); },
  selectProvider: (providerId: ProviderId) => {
    const preset = PRESETS[providerId];
    state = {
      ...state,
      providerId,
      label: preset.label ?? state.label,
      endpoint: preset.endpoint ?? state.endpoint,
      model: preset.model ?? state.model,
    };
    emit();
  },
  resetSystemPrompt: () => { state = { ...state, systemPrompt: DEFAULT_SYSTEM }; emit(); },
  presets: PRESETS,
};

export function useModelConfig(): ModelConfig {
  return useSyncExternalStore(modelStore.subscribe, () => modelStore.get(), () => INITIAL);
}

export function isConfigured(c: ModelConfig): boolean {
  // Local providers don't need an API key. Cloud ones do.
  const localProviders: ProviderId[] = ['ollama-local', 'lambo-local', 'mlx-local', 'custom'];
  if (localProviders.includes(c.providerId)) {
    return !!c.endpoint && !!c.model;
  }
  return !!c.endpoint && !!c.model && !!c.apiKey;
}
