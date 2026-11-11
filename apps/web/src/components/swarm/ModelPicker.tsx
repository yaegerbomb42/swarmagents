'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Server, Cloud, Cpu, Key, Sparkles, RotateCcw } from 'lucide-react';
import { modelStore, useModelConfig, type ProviderId } from '@/lib/modelStore';

interface ProviderOption {
  id: ProviderId;
  label: string;
  icon: React.ReactNode;
  blurb: string;
  needsKey: boolean;
}

const PROVIDERS: ProviderOption[] = [
  { id: 'azure', label: 'Azure AI Foundry', icon: <Cloud size={14}/>, blurb: '14 models via the engine gateway — DeepSeek-R1, Llama-4-Maverick-405B, Qwen-3-Max, and more. Intelligent tier-based routing.', needsKey: true },
  { id: 'ollama-local', label: 'Ollama (local)',  icon: <Cpu  size={14}/>, blurb: 'Local Ollama — deepseek-r1-qwen3:8b worker, Qwen, Llama. No API key. For offline use.', needsKey: false },
  { id: 'lambo-local',  label: 'LAMBO 2.1B (Local Swarm)', icon: <Cpu size={14}/>, blurb: 'In-house 2.1B · 20 Ollama agents · 128k ctx · <thought> + mcp_call · $0 cloud.', needsKey: false },
  { id: 'mlx-local',    label: 'MLX (Apple Silicon)', icon: <Cpu size={14}/>, blurb: 'Run mlx_lm.server locally on Mac with your LoRA adapter.', needsKey: false },
  { id: 'custom',       label: 'Custom endpoint',icon: <Server size={14}/>, blurb: 'Any OpenAI-compatible / Ollama / llama.cpp endpoint.', needsKey: false },
  // TEMPORARILY DISABLED - Azure Foundry migration in progress
  // { id: 'vps-testing',  label: 'VPS Testing (11 days)', icon: <Server size={14}/>, blurb: 'VPS-hosted Ollama (OpenAI-compatible) active for 11 days of testing.', needsKey: false },
  // { id: 'antigravity',  label: 'Google Antigravity', icon: <Cloud size={14}/>, blurb: 'Managed agent with remote sandbox — code execution, search, URL context. Requires paid-tier Gemini key.', needsKey: true },
  // { id: 'swarmagent-local', label: 'SwarmAgent Local', icon: <Cpu size={14}/>, blurb: 'Core 16.9B + Router 16.9B + General 1.1B with dynamic task routing. Runs via Ollama.', needsKey: false },
  // { id: 'openai',       label: 'OpenAI',         icon: <Cloud size={14}/>, blurb: 'gpt-4o / gpt-4o-mini / o-series.', needsKey: true  },
  // { id: 'groq',         label: 'Groq',           icon: <Cloud size={14}/>, blurb: 'Llama 3.3 70B / Qwen at ultra-low latency.', needsKey: true  },
  // { id: 'cerebras',     label: 'Cerebras',       icon: <Cloud size={14}/>, blurb: 'gpt-oss-120B / qwen-3-235B / zai-glm-4.7 on wafer-scale.', needsKey: true  },
  // { id: 'anthropic',    label: 'Anthropic',      icon: <Cloud size={14}/>, blurb: 'Claude 3.5 Sonnet / Haiku via Messages API.', needsKey: true  },
  // { id: 'watsonx',      label: 'Watsonx (IBM)',  icon: <Cloud size={14}/>, blurb: 'gpt-oss-120B + Llama 3.3 70B on IBM Cloud (free tier).', needsKey: true  },
  // { id: 'nvidia-nim',   label: 'NVIDIA NIM',     icon: <Cloud size={14}/>, blurb: 'Llama 3.3 70B on NVIDIA Inference Microservices.', needsKey: true  },
  // { id: 'gemini',       label: 'Gemini',         icon: <Cloud size={14}/>, blurb: 'Gemini 2.5 Flash / Pro — 22 live keys, 330+ RPM aggregate.', needsKey: true  },
  // { id: 'mistral',      label: 'Mistral',        icon: <Cloud size={14}/>, blurb: 'mistral-large-latest (~120B premium tier).', needsKey: true  },
  // { id: 'novita',       label: 'Novita AI',      icon: <Cloud size={14}/>, blurb: 'Llama 3.3 70B pay-as-you-go.', needsKey: true  },
  // { id: 'openrouter',   label: 'OpenRouter',     icon: <Cloud size={14}/>, blurb: 'Aggregator — route to any model via a single key.', needsKey: true  },
  // { id: 'huggingface',  label: 'HF Inference',   icon: <Cloud size={14}/>, blurb: 'Hosted inference for HF Hub models.', needsKey: true  },
];

const MODEL_SUGGESTIONS: Record<ProviderId, string[]> = {
  'azure': [
    // Tier 1 - Premium models for complex reasoning
    'DeepSeek-R1', 'DeepSeek-V4-Pro', 'Llama-4-Maverick-405B', 'Qwen-3-Max',
    // Tier 2 - Efficient models for general tasks
    'Mistral-NeMo-12B', 'Llama-3.2-1B', 'Phi-4-mini', 'Phi-3.5-mini',
    'Gemma-3-12B', 'DeepSeek-V4-Flash', 'Qwen-3.5-9B', 'GPT-5.4-Nano',
    'GPT-4o-mini', 'Llama-3.3-70B',
  ],
  'ollama-local': [
    // DeepSeek R1 worker agent
    'deepseek-r1-0528-qwen3:8b',
    // Local GGUF models (import via: ollama create <name> -f Modelfile)
    'qwen3.6-27b:q4_k_m', 'qwen2.5-32b-abliterated:q4_k_m',
    'gemma-4-26b:q3_k_m', 'magnum-v4-72b:iq2_xxs',
    'llama3.1:8b',
  ],
  'lambo-local': ['lambo-2.1b', 'lambo-2.1b-q4_k_m.gguf'],
  'mlx-local': [
    'meta-llama/Llama-3.1-8B-Instruct', 'mlx-community/Llama-3.1-8B-Instruct-4bit',
    'deepseek-r1-0528-qwen3:8b',
  ],
  'custom': [],
  'openai': [],
  'groq': [],
  'cerebras': [],
  'anthropic': [],
  'watsonx': [],
  'nvidia-nim': [],
  'gemini': [],
  'mistral': [],
  'novita': [],
  'openrouter': [],
  'huggingface': [],
  'vps-testing': [],
  'antigravity': [],
  'swarmagent-local': [],
  // TEMPORARILY DISABLED - Azure Foundry migration in progress
  // 'openai':       ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
  // 'groq':         ['llama-3.3-70b-versatile', 'qwen-qwq-32b', 'deepseek-r1-distill-llama-70b'],
  // 'cerebras':     ['gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507', 'zai-glm-4.7', 'llama-3.3-70b'],
  // 'anthropic':    ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022'],
  // 'watsonx':      ['openai/gpt-oss-120b', 'meta-llama/llama-3-3-70b-instruct'],
  // 'nvidia-nim':   ['meta/llama-3.3-70b-instruct'],
  // 'gemini':       ['gemini-2.5-flash', 'gemini-2.5-pro'],
  // 'mistral':      ['mistral-large-latest'],
  // 'novita':       ['meta-llama/llama-3.3-70b-instruct'],
  // 'openrouter':   ['meta-llama/llama-3.3-70b-instruct', 'anthropic/claude-3.5-sonnet'],
  // 'huggingface':  ['meta-llama/Llama-3.1-8B-Instruct', 'mistralai/Mistral-7B-Instruct-v0.3'],
  // 'vps-testing':  ['hamiltonian', 'olmoe', 'lfm', 'hamiltonian:8b-iq3', 'olmoe:latest', 'lfm:latest'],
  // 'antigravity':  ['antigravity-preview-05-2026'],
  // 'swarmagent-local': ['swarmagent-core-16.9b', 'swarmagent-router-16.9b', 'swarmagent-general-1.1b'],
};

export function ModelPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cfg = useModelConfig();
  const [showSystem, setShowSystem] = useState(false);

  // close on escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const currentProvider = PROVIDERS.find(p => p.id === cfg.providerId) ?? PROVIDERS[0];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-2xl max-h-[90vh] overflow-auto rounded-2xl border border-white/10 bg-[#0a1224] text-white/90 shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <div className="text-sm font-semibold tracking-wide">Model</div>
                <div className="text-[11px] text-white/50">Pick the LLM that drives the conductor, sub-agents, and the 3D agents.</div>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-md hover:bg-white/10" aria-label="Close">
                <X size={16}/>
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-5">
              {/* Provider tabs */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-white/40 mb-2">Provider</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {PROVIDERS.map(p => {
                    const active = p.id === cfg.providerId;
                    return (
                      <button
                        key={p.id}
                        onClick={() => modelStore.selectProvider(p.id)}
                        className={[
                          'flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-[11.5px] transition-colors text-left',
                          active
                            ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-100'
                            : 'border-white/10 hover:border-white/25 text-white/70 hover:text-white',
                        ].join(' ')}
                      >
                        {p.icon}<span className="truncate">{p.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="text-[11px] text-white/40 mt-2">
                  {currentProvider.blurb}
                </div>
              </div>

              {/* Endpoint */}
              <div>
                <label className="text-[11px] uppercase tracking-wider text-white/40 mb-1.5 block">Endpoint URL</label>
                <input
                  type="text"
                  value={cfg.endpoint}
                  onChange={(e) => modelStore.set({ endpoint: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-[12.5px] font-mono focus:outline-none focus:border-cyan-400/50"
                  placeholder="https://api.openai.com/v1/chat/completions"
                />
              </div>

              {/* Model */}
              <div>
                <label className="text-[11px] uppercase tracking-wider text-white/40 mb-1.5 block">Model</label>
                <input
                  type="text"
                  value={cfg.model}
                  onChange={(e) => modelStore.set({ model: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-[12.5px] font-mono focus:outline-none focus:border-cyan-400/50"
                  placeholder="model name"
                />
                {(MODEL_SUGGESTIONS[cfg.providerId] || []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {MODEL_SUGGESTIONS[cfg.providerId].map(m => (
                      <button
                        key={m}
                        onClick={() => modelStore.set({ model: m })}
                        className="px-2 py-0.5 rounded-md border border-white/10 hover:border-cyan-400/40 text-[10.5px] text-white/60 hover:text-cyan-200 font-mono"
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* API key */}
              {currentProvider.needsKey && (
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-white/40 mb-1.5 flex items-center gap-1.5">
                    <Key size={11}/> API Key
                  </label>
                  <input
                    type="password"
                    value={cfg.apiKey}
                    onChange={(e) => modelStore.set({ apiKey: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-[12.5px] font-mono focus:outline-none focus:border-cyan-400/50"
                    placeholder="yaeger"
                    autoComplete="off"
                  />
                  <div className="text-[10.5px] text-white/35 mt-1">Stored locally in your browser. Never sent anywhere except the chosen provider.</div>
                </div>
              )}

              {/* LoRA adapter (MLX / Ollama only) */}
              {(cfg.providerId === 'mlx-local' || cfg.providerId === 'ollama-local') && (
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-white/40 mb-1.5 flex items-center gap-1.5">
                    <Sparkles size={11}/> LoRA adapter
                    <span className="text-white/30 font-normal normal-case">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={cfg.loraAdapter}
                    onChange={(e) => modelStore.set({ loraAdapter: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-[12.5px] font-mono focus:outline-none focus:border-cyan-400/50"
                    placeholder={cfg.providerId === 'mlx-local' ? '~/models/llama-3.1-8b-hamiltonian-adapter' : 'yaegerbomb42/qwen3-30b-a3b-hamiltonian-lora-gguf'}
                  />
                  <div className="text-[10.5px] text-white/35 mt-1">
                    {cfg.providerId === 'mlx-local'
                      ? 'Run: python -m mlx_lm.server --model <model> --adapter-path <this path>'
                      : 'For reference only — Ollama uses a Modelfile FROM <model> with PARAMETER adapter.'}
                  </div>
                </div>
              )}

              {/* System prompt (collapsed) */}
              <div>
                <button
                  onClick={() => setShowSystem(s => !s)}
                  className="text-[11px] uppercase tracking-wider text-white/40 hover:text-white/70 flex items-center gap-1.5"
                >
                  {showSystem ? '▾' : '▸'} Conductor system prompt
                </button>
                {showSystem && (
                  <div className="mt-2 space-y-2">
                    <textarea
                      value={cfg.systemPrompt}
                      onChange={(e) => modelStore.set({ systemPrompt: e.target.value })}
                      rows={10}
                      className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-[12px] font-mono focus:outline-none focus:border-cyan-400/50 resize-y"
                    />
                    <button
                      onClick={() => modelStore.resetSystemPrompt()}
                      className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white/80"
                    >
                      <RotateCcw size={11}/> Reset to default
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-white/10 flex items-center justify-between">
              <div className="text-[11px] text-white/40">
                <span className="text-cyan-200/80 font-mono">{cfg.providerId}</span>
                {' · '}
                <span className="font-mono">{cfg.model || '—'}</span>
              </div>
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-md bg-gradient-to-r from-cyan-400 to-teal-400 text-black text-[12px] font-medium hover:brightness-110"
              >
                Done
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
