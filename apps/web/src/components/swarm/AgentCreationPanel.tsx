'use client';

import React, { useState, useCallback } from 'react';
import { Cpu, Sparkles, Wrench, BookOpen, Brain, ChevronRight, ChevronDown, Loader2, Check, X, Zap, Search, Sliders } from 'lucide-react';

interface ModelProvider {
  id: string;
  label: string;
  models: string[];
  needsKey: boolean;
  endpoint?: string;
}

const PROVIDERS: ModelProvider[] = [
  { id: 'ollama', label: 'Ollama (Local)', models: ['swarmagent-core-16.9b', 'swarmagent-router-16.9b', 'swarmagent-general-1.1b', 'qwen3-hamiltonian', 'llama3.3:latest', 'phi4:latest'], needsKey: false, endpoint: 'http://localhost:11434/api/generate' },
  { id: 'groq', label: 'Groq', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b', 'gemma2-9b-it'], needsKey: true, endpoint: 'https://api.groq.com/openai/v1/chat/completions' },
  { id: 'cerebras', label: 'Cerebras', models: ['llama3.1-70b', 'llama-3.3-70b'], needsKey: true, endpoint: 'https://api.cerebras.ai/v1/chat/completions' },
  { id: 'anthropic', label: 'Anthropic', models: ['claude-3-5-haiku', 'claude-3-5-sonnet'], needsKey: true, endpoint: 'https://api.anthropic.com/v1/messages' },
  { id: 'openai', label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'], needsKey: true, endpoint: 'https://api.openai.com/v1/chat/completions' },
  { id: 'gemini', label: 'Gemini', models: ['gemini-2.5-flash', 'gemini-2.5-pro'], needsKey: true, endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'nvidia', label: 'NVIDIA NIM', models: ['meta/llama-3.3-70b', 'meta/llama-3.1-8b'], needsKey: true, endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions' },
  { id: 'huggingface', label: 'HuggingFace', models: ['meta-llama/Llama-3.1-8B', 'deepseek-ai/DeepSeek-R1'], needsKey: true, endpoint: 'https://api-inference.huggingface.co/models' },
  { id: 'custom', label: 'Custom Endpoint', models: ['custom-model'], needsKey: true },
];

const TRAIT_SLIDERS = [
  { key: 'reasoning', label: 'Reasoning', emoji: '🧠' },
  { key: 'creativity', label: 'Creativity', emoji: '🎨' },
  { key: 'execution', label: 'Execution', emoji: '⚡' },
  { key: 'memory', label: 'Memory', emoji: '📚' },
  { key: 'planning', label: 'Planning', emoji: '🗺️' },
  { key: 'validation', label: 'Validation', emoji: '✅' },
  { key: 'research', label: 'Research', emoji: '🔬' },
  { key: 'coding', label: 'Coding', emoji: '💻' },
];

interface AgentCard {
  name: string;
  role: string;
  personality: string;
  strengths: string[];
  weaknesses: string[];
  traits: Record<string, number>;
  provider: string;
  model: string;
  endpoint: string;
  loraConfig?: string;
}

export default function AgentCreationPanel() {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<ModelProvider>(PROVIDERS[0]);
  const [selectedModel, setSelectedModel] = useState(PROVIDERS[0].models[0]);
  const [apiKey, setApiKey] = useState('');
  const [customEndpoint, setCustomEndpoint] = useState('');
  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [agentCard, setAgentCard] = useState<AgentCard | null>(null);
  const [traits, setTraits] = useState<Record<string, number>>({
    reasoning: 50, creativity: 50, execution: 50, memory: 50,
    planning: 50, validation: 50, research: 50, coding: 50,
  });
  const [ragQuery, setRagQuery] = useState('');
  const [ragSearching, setRagSearching] = useState(false);
  const [ragResults, setRagResults] = useState<string[]>([]);
  const [loraBuilding, setLoraBuilding] = useState(false);
  const [loraDone, setLoraDone] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const [expandedSection, setExpandedSection] = useState<string | null>('traits');

  const generateAgentCard = useCallback(async () => {
    if (!description.trim()) return;
    setGenerating(true);
    // Simulate generation
    await new Promise(r => setTimeout(r, 1500));

    const desc = description.toLowerCase();
    const inferredTraits = { ...traits };
    if (desc.includes('code') || desc.includes('develop')) { inferredTraits.coding = 85; inferredTraits.execution = 80; }
    if (desc.includes('research') || desc.includes('analyze')) { inferredTraits.research = 85; inferredTraits.reasoning = 80; }
    if (desc.includes('creative') || desc.includes('design')) { inferredTraits.creativity = 85; inferredTraits.planning = 75; }
    if (desc.includes('plan') || desc.includes('strategy')) { inferredTraits.planning = 85; inferredTraits.reasoning = 80; }
    if (desc.includes('write') || desc.includes('content')) { inferredTraits.creativity = 80; inferredTraits.memory = 75; }
    if (desc.includes('review') || desc.includes('check')) { inferredTraits.validation = 85; inferredTraits.reasoning = 75; }

    const card: AgentCard = {
      name: desc.split(' ').slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'SwarmAgent',
      role: desc.includes('code') ? 'Software Engineer' : desc.includes('research') ? 'Research Analyst' : desc.includes('creative') ? 'Creative Director' : desc.includes('plan') ? 'Strategist' : 'General Agent',
      personality: desc.includes('aggressive') ? 'Assertive and results-driven' : desc.includes('calm') ? 'Patient and methodical' : desc.includes('fast') ? 'Rapid and adaptive' : 'Balanced and collaborative',
      strengths: inferredTraits.coding > 70 ? ['Code generation', 'Debugging', 'Architecture'] : inferredTraits.research > 70 ? ['Deep research', 'Data synthesis', 'Report writing'] : inferredTraits.creativity > 70 ? ['Ideation', 'Visual design', 'Copywriting'] : ['Adaptability', 'General problem-solving', 'Communication'],
      weaknesses: inferredTraits.coding > 70 ? ['May over-engineer', 'Narrow domain focus'] : inferredTraits.research > 70 ? ['Analysis paralysis', 'Slow with execution'] : inferredTraits.creativity > 70 ? ['Inconsistent output', 'May miss constraints'] : ['Jack of all trades', 'No deep specialization'],
      traits: inferredTraits,
      provider: provider.label,
      model: selectedModel,
      endpoint: provider.endpoint || customEndpoint || '',
    };
    setAgentCard(card);
    setTraits(inferredTraits);
    setGenerating(false);
    setStep(2);
  }, [description, provider, selectedModel, traits, customEndpoint]);

  const runRAG = useCallback(async () => {
    const query = ragQuery || description;
    if (!query.trim()) return;
    setRagSearching(true);
    setRagResults([]);
    await new Promise(r => setTimeout(r, 2000));
    // Simulated RAG results
    const results = [
      `Retrieved 12 documents on "${query.slice(0, 30)}..."`,
      'Found 3 expert papers on agent specialization',
      'Extracted 847 relevant tokens for LoRA training',
      'Generated embedding space: 4096-dim vectors',
    ];
    setRagResults(results);
    setRagSearching(false);
  }, [ragQuery, description]);

  const buildLoRA = useCallback(async () => {
    setLoraBuilding(true);
    await new Promise(r => setTimeout(r, 3000));
    setLoraBuilding(false);
    setLoraDone(true);
    setAgentCard(prev => prev ? { ...prev, loraConfig: `lora_${prev.name.toLowerCase().replace(/\s+/g, '_')}_r32_alpha64` } : null);
  }, []);

  const deployAgent = useCallback(async () => {
    setDeployed(true);
  }, []);

  const steps = [
    { label: 'Base Model', icon: Cpu },
    { label: 'Describe', icon: Sparkles },
    { label: 'Personality', icon: Brain },
    { label: 'LoRA', icon: Wrench },
    { label: 'Deploy', icon: Zap },
  ];

  return (
    <div className="space-y-6">
      {/* Stepper */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <React.Fragment key={i}>
            <button
              onClick={() => setStep(i)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                i === step ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-400/30' :
                i < step ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-400/20' :
                'bg-white/[0.03] text-white/30 border border-white/[0.06]'
              }`}
            >
              <s.icon size={12} />
              {s.label}
              {i < step && <Check size={10} className="ml-0.5" />}
            </button>
            {i < steps.length - 1 && <ChevronRight size={12} className="text-white/10" />}
          </React.Fragment>
        ))}
      </div>

      {/* Step 0: Base Model */}
      {step === 0 && (
        <div className="space-y-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-white/40 mb-2 block">Provider</label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {PROVIDERS.map(p => (
                <button
                  key={p.id}
                  onClick={() => { setProvider(p); setSelectedModel(p.models[0]); }}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    provider.id === p.id
                      ? 'bg-cyan-500/10 border-cyan-400/30'
                      : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.12]'
                  }`}
                >
                  <div className="text-[12px] font-medium text-white/80">{p.label}</div>
                  <div className="text-[10px] text-white/30 mt-0.5">{p.models.length} models</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wider text-white/40 mb-2 block">Model</label>
            <select
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-[13px] text-white focus:border-cyan-400/40 focus:outline-none"
            >
              {provider.models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          {provider.needsKey && (
            <div>
              <label className="text-[11px] uppercase tracking-wider text-white/40 mb-2 block">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-[13px] text-white placeholder:text-white/20 focus:border-cyan-400/40 focus:outline-none font-mono"
              />
            </div>
          )}

          {provider.id === 'custom' && (
            <div>
              <label className="text-[11px] uppercase tracking-wider text-white/40 mb-2 block">Endpoint URL</label>
              <input
                value={customEndpoint}
                onChange={e => setCustomEndpoint(e.target.value)}
                placeholder="https://api.example.com/v1/chat/completions"
                className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-[13px] text-white placeholder:text-white/20 focus:border-cyan-400/40 focus:outline-none font-mono"
              />
            </div>
          )}

          <button
            onClick={() => setStep(1)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-[13px] font-medium hover:brightness-110 transition-all"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}

      {/* Step 1: Description */}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-white/40 mb-2 block">What should this agent do?</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={4}
              placeholder="Describe the agent's purpose, personality, or task... e.g. 'A creative coding assistant that generates React components with a playful personality'"
              className="w-full px-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-[13px] text-white placeholder:text-white/20 focus:border-cyan-400/40 focus:outline-none resize-y"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={generateAgentCard}
              disabled={!description.trim() || generating}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-[13px] font-medium hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {generating ? 'Building model card...' : 'Generate Model Card'}
            </button>
            <button onClick={() => setStep(0)} className="text-[12px] text-white/40 hover:text-white/70 transition">Back</button>
          </div>

          {generating && (
            <div className="p-4 rounded-xl border border-cyan-500/10 bg-cyan-500/[0.03]">
              <div className="flex items-center gap-2 text-[12px] text-cyan-300/70">
                <Loader2 size={12} className="animate-spin" />
                Analyzing description...
              </div>
              <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-cyan-400/40 rounded-full animate-pulse w-2/3" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Personality & Traits */}
      {step === 2 && agentCard && (
        <div className="space-y-4">
          {/* Model Card Preview */}
          <div className="p-5 rounded-xl border border-cyan-500/10 bg-cyan-500/[0.03]">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-lg font-semibold text-white/90">{agentCard.name}</div>
                <div className="text-[12px] text-cyan-300/60">{agentCard.role}</div>
              </div>
              <div className="text-[10px] px-2 py-1 rounded bg-white/5 text-white/40 font-mono">{agentCard.model}</div>
            </div>
            <div className="text-[13px] text-white/50 mb-3">{agentCard.personality}</div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {agentCard.strengths.map((s, i) => (
                <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300/70 border border-emerald-400/20">{s}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agentCard.weaknesses.map((w, i) => (
                <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/10 text-red-300/70 border border-red-400/20">{w}</span>
              ))}
            </div>
          </div>

          {/* Traits */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-4">
            <button
              onClick={() => setExpandedSection(expandedSection === 'traits' ? null : 'traits')}
              className="w-full flex items-center justify-between mb-2"
            >
              <span className="text-[11px] uppercase tracking-wider text-white/40 flex items-center gap-2">
                <Sliders size={12} /> Fine-tune Traits
              </span>
              {expandedSection === 'traits' ? <ChevronDown size={14} className="text-white/30" /> : <ChevronRight size={14} className="text-white/30" />}
            </button>
            {expandedSection === 'traits' && (
              <div className="space-y-3 pt-2">
                {TRAIT_SLIDERS.map(t => (
                  <div key={t.key} className="flex items-center gap-3">
                    <span className="text-[12px] text-white/50 w-28 shrink-0">{t.emoji} {t.label}</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={traits[t.key]}
                      onChange={e => setTraits(prev => ({ ...prev, [t.key]: Number(e.target.value) }))}
                      className="flex-1 h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-cyan-400"
                    />
                    <span className="text-[11px] text-white/30 font-mono w-8 text-right">{traits[t.key]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* RAG Search */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-4">
            <button
              onClick={() => setExpandedSection(expandedSection === 'rag' ? null : 'rag')}
              className="w-full flex items-center justify-between mb-2"
            >
              <span className="text-[11px] uppercase tracking-wider text-white/40 flex items-center gap-2">
                <Search size={12} /> Auto-RAG Knowledge Search
              </span>
              {expandedSection === 'rag' ? <ChevronDown size={14} className="text-white/30" /> : <ChevronRight size={14} className="text-white/30" />}
            </button>
            {expandedSection === 'rag' && (
              <div className="space-y-3 pt-2">
                <div className="flex gap-2">
                  <input
                    value={ragQuery}
                    onChange={e => setRagQuery(e.target.value)}
                    placeholder={`Search knowledge for "${agentCard.role}" expertise...`}
                    className="flex-1 px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-[12px] text-white placeholder:text-white/20 focus:border-cyan-400/40 focus:outline-none"
                  />
                  <button
                    onClick={runRAG}
                    disabled={ragSearching}
                    className="px-4 py-2 rounded-lg bg-cyan-500/15 border border-cyan-400/30 text-cyan-200 text-[12px] hover:bg-cyan-500/25 transition-all disabled:opacity-40"
                  >
                    {ragSearching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                  </button>
                </div>
                {ragResults.length > 0 && (
                  <div className="space-y-1">
                    {ragResults.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px] text-white/40">
                        <Check size={10} className="text-emerald-400/60" />
                        {r}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setStep(3)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-[13px] font-medium hover:brightness-110 transition-all"
            >
              Next <ChevronRight size={14} />
            </button>
            <button onClick={() => setStep(1)} className="text-[12px] text-white/40 hover:text-white/70 transition">Back</button>
          </div>
        </div>
      )}

      {/* Step 3: LoRA Build */}
      {step === 3 && agentCard && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl border border-violet-500/10 bg-violet-500/[0.03]">
            <div className="text-[11px] uppercase tracking-wider text-violet-300/50 mb-3 flex items-center gap-2">
              <Wrench size={12} /> LoRA Configuration
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              {[
                { label: 'Rank (r)', value: '32' },
                { label: 'Alpha', value: '64' },
                { label: 'Target Modules', value: 'q_proj, v_proj' },
                { label: 'Dropout', value: '0.05' },
              ].map((c, i) => (
                <div key={i} className="p-2.5 rounded-lg border border-white/[0.05] bg-black/20">
                  <div className="text-[10px] text-white/30 mb-0.5">{c.label}</div>
                  <div className="text-[12px] text-white/60 font-mono">{c.value}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={buildLoRA}
                disabled={loraBuilding || loraDone}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-violet-500 to-purple-600 text-white text-[13px] font-medium hover:brightness-110 disabled:opacity-40 transition-all"
              >
                {loraBuilding ? <Loader2 size={14} className="animate-spin" /> : loraDone ? <Check size={14} /> : <Wrench size={14} />}
                {loraBuilding ? 'Training LoRA...' : loraDone ? 'LoRA Ready' : 'Build LoRA'}
              </button>
              {loraDone && agentCard.loraConfig && (
                <span className="text-[11px] text-violet-300/60 font-mono">{agentCard.loraConfig}</span>
              )}
            </div>
            {loraBuilding && (
              <div className="mt-3 space-y-1">
                {['Loading base weights...', 'Configuring PEFT adapter...', 'Running RAG token extraction...', 'Training adapter (epoch 1/3)...', 'Saving LoRA weights...'].map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] text-white/30">
                    <div className={`w-1.5 h-1.5 rounded-full ${i < 2 ? 'bg-emerald-400/60' : 'bg-white/10'}`} />
                    {s}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setStep(4)}
              disabled={!loraDone}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-[13px] font-medium hover:brightness-110 disabled:opacity-40 transition-all"
            >
              Next <ChevronRight size={14} />
            </button>
            <button onClick={() => setStep(2)} className="text-[12px] text-white/40 hover:text-white/70 transition">Back</button>
          </div>
        </div>
      )}

      {/* Step 4: Deploy */}
      {step === 4 && agentCard && (
        <div className="space-y-4">
          <div className="p-5 rounded-xl border border-emerald-500/10 bg-emerald-500/[0.03]">
            <div className="text-[11px] uppercase tracking-wider text-emerald-300/50 mb-4 flex items-center gap-2">
              <Zap size={12} /> Deployment Summary
            </div>
            <div className="space-y-2 text-[13px]">
              <div className="flex justify-between"><span className="text-white/40">Name</span><span className="text-white/80">{agentCard.name}</span></div>
              <div className="flex justify-between"><span className="text-white/40">Role</span><span className="text-white/80">{agentCard.role}</span></div>
              <div className="flex justify-between"><span className="text-white/40">Provider</span><span className="text-white/80">{agentCard.provider}</span></div>
              <div className="flex justify-between"><span className="text-white/40">Model</span><span className="text-white/60 font-mono">{agentCard.model}</span></div>
              <div className="flex justify-between"><span className="text-white/40">LoRA</span><span className="text-white/60 font-mono">{agentCard.loraConfig || '—'}</span></div>
            </div>
            <div className="mt-4 pt-4 border-t border-white/[0.05]">
              <div className="text-[11px] text-white/30 mb-2">Trait Profile</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(traits).filter(([,v]) => v > 60).map(([k, v]) => (
                  <span key={k} className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300/60 border border-cyan-400/20">
                    {k} {v}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={deployAgent}
            disabled={deployed}
            className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-600 text-white text-[13px] font-medium hover:brightness-110 disabled:opacity-40 transition-all"
          >
            {deployed ? <Check size={14} /> : <Zap size={14} />}
            {deployed ? 'Agent Deployed to Swarm' : 'Deploy Agent to Swarm'}
          </button>

          {deployed && (
            <div className="text-center text-[12px] text-emerald-300/60">
              Agent is now live and ready to receive tasks.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
