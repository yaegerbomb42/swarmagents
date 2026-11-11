'use client';

import React, { useState, useEffect } from 'react';
import { AGENTS, agentBrainStore, setAgentBrainConfig, useAgentBrainConfig, type AgentBrainConfig } from './OfficeScene';
import { modelStore } from '@/lib/modelStore';
import type { ProviderId } from '@/lib/modelStore';

const PRESET_KEYS: { id: ProviderId; label: string; model: string; endpoint: string }[] = [
  { id: 'ollama-local',     label: 'Ollama (local)',       model: 'qwen2.5:3b',              endpoint: 'http://localhost:11434/api/generate' },
  { id: 'lambo-local',      label: 'LAMBO 2.1B (Local Swarm)', model: 'lambo-2.1b',          endpoint: 'http://localhost:11434/api/chat' },
  { id: 'groq',             label: 'Groq',                 model: 'llama-3.3-70b-versatile', endpoint: 'https://api.groq.com/openai/v1/chat/completions' },
  { id: 'cerebras',         label: 'Cerebras',             model: 'llama3.1-70b',            endpoint: 'https://api.cerebras.ai/v1/chat/completions' },
  { id: 'anthropic',        label: 'Anthropic',            model: 'claude-3-5-haiku',        endpoint: 'https://api.anthropic.com/v1/messages' },
  { id: 'openai',           label: 'OpenAI',               model: 'gpt-4o-mini',             endpoint: 'https://api.openai.com/v1/chat/completions' },
  { id: 'huggingface',      label: 'HuggingFace',          model: 'meta-llama/Llama-3.1-8B', endpoint: 'https://api-inference.huggingface.co/models' },
  { id: 'nvidia-nim',       label: 'NVIDIA NIM',           model: 'meta/llama-3.3-70b',      endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions' },
  { id: 'gemini',           label: 'Gemini',               model: 'gemini-2.5-flash',        endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'vps-testing',      label: 'VPS Testing',          model: 'hamiltonian',             endpoint: 'http://194.113.75.201:8000/v1/chat/completions' },
  { id: 'antigravity',      label: 'Antigravity',          model: 'antigravity-preview',     endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'swarmagent-local', label: 'SwarmAgent Local',     model: 'swarmagent-core-16.9b',   endpoint: 'http://localhost:11434/api/generate' },
  { id: 'custom',           label: 'Custom',               model: '',                        endpoint: '' },
];

export function AgentBrainPanel() {
  const [open, setOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={() => setOpen(v => !v)}
        className="fixed top-20 right-4 z-50 px-3 py-2 rounded-xl bg-black/70 backdrop-blur-md border border-cyan-500/30 text-cyan-300 text-xs font-mono hover:bg-cyan-500/10 transition-all"
      >
        {open ? 'Close Brain Panel' : 'Agent Brains'}
      </button>

      {open && (
        <div className="fixed top-16 right-4 bottom-4 w-80 z-40 bg-[#070718]/95 backdrop-blur-xl border border-cyan-500/20 rounded-2xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-cyan-500/10">
            <h3 className="text-sm font-semibold text-white">Agent Brain Assignments</h3>
            <p className="text-[10px] text-gray-500 mt-0.5">Assign different LLMs to each robot</p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {AGENTS.map(agent => (
              <AgentBrainCard
                key={agent.id}
                agent={agent}
                isSelected={selectedAgent === agent.id}
                onClick={() => setSelectedAgent(agent.id)}
              />
            ))}
          </div>

          {selectedAgent && (
            <BrainConfigForm agentId={selectedAgent} onClose={() => setSelectedAgent(null)} />
          )}
        </div>
      )}
    </>
  );
}

function AgentBrainCard({ agent, isSelected, onClick }: {
  agent: typeof AGENTS[0];
  isSelected: boolean;
  onClick: () => void;
}) {
  const cfg = useAgentBrainConfig(agent.id);
  const globalCfg = modelStore.get();
  const active = cfg.endpoint ? cfg : null;
  const label = active?.label || globalCfg.label || 'Default';
  const model = active?.model || globalCfg.model || 'reflex';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-xl border transition-all ${
        isSelected
          ? 'bg-cyan-500/10 border-cyan-400/30'
          : 'bg-white/[0.02] border-white/[0.06] hover:border-cyan-500/20'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: agent.color }} />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-white truncate">{agent.label}</div>
          <div className="text-[10px] text-gray-500 font-mono truncate">{model}</div>
        </div>
        <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${
          active ? 'bg-emerald-500/10 text-emerald-300 border-emerald-400/30' : 'bg-gray-500/10 text-gray-500 border-gray-500/20'
        }`}>
          {active ? 'Custom' : 'Global'}
        </span>
      </div>
    </button>
  );
}

function BrainConfigForm({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const cfg = useAgentBrainConfig(agentId);
  const [provider, setProvider] = useState<ProviderId>(cfg.providerId);
  const [model, setModel] = useState(cfg.model);
  const [endpoint, setEndpoint] = useState(cfg.endpoint);
  const [apiKey, setApiKey] = useState(cfg.apiKey);

  const preset = PRESET_KEYS.find(p => p.id === provider);

  useEffect(() => {
    if (preset && preset.model) {
      setModel(preset.model);
      setEndpoint(preset.endpoint);
    }
  }, [provider]);

  const handleSave = () => {
    const p = PRESET_KEYS.find(x => x.id === provider);
    setAgentBrainConfig(agentId, {
      providerId: provider,
      label: p?.label || 'Custom',
      model: model || p?.model || '',
      endpoint: endpoint || p?.endpoint || '',
      apiKey,
    });
    onClose();
  };

  const handleReset = () => {
    setAgentBrainConfig(agentId, { endpoint: '', model: '', apiKey: '' });
    onClose();
  };

  const agent = AGENTS.find(a => a.id === agentId);

  return (
    <div className="absolute inset-x-0 bottom-0 bg-[#0a0a12] border-t border-cyan-500/20 p-4 rounded-t-2xl">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: agent?.color }} />
        <span className="text-xs font-medium text-white">{agent?.label}</span>
        <button onClick={onClose} className="ml-auto text-gray-500 hover:text-white text-xs">Close</button>
      </div>

      <div className="space-y-2.5">
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">Provider</label>
          <select
            value={provider}
            onChange={e => setProvider(e.target.value as ProviderId)}
            className="w-full mt-1 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white focus:border-cyan-400/40 focus:outline-none"
          >
            {PRESET_KEYS.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">Model</label>
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="model name"
            className="w-full mt-1 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder:text-gray-600 focus:border-cyan-400/40 focus:outline-none font-mono"
          />
        </div>

        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">Endpoint</label>
          <input
            value={endpoint}
            onChange={e => setEndpoint(e.target.value)}
            placeholder="http://..."
            className="w-full mt-1 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder:text-gray-600 focus:border-cyan-400/40 focus:outline-none font-mono"
          />
        </div>

        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full mt-1 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder:text-gray-600 focus:border-cyan-400/40 focus:outline-none font-mono"
          />
        </div>
      </div>

      <div className="flex gap-2 mt-3">
        <button
          onClick={handleSave}
          className="flex-1 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/30 text-cyan-200 text-xs font-medium transition-all"
        >
          Save Brain
        </button>
        <button
          onClick={handleReset}
          className="px-3 py-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 text-gray-400 text-xs transition-all"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
