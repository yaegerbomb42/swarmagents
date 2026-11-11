'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { world, useWorld } from './worldStore';

const BRAINS = [
  { id: 'reflex',       label: 'Reflex',           sub: 'utility AI · instant · no network' },
  { id: 'hamiltonian',  label: 'LLM Brain',         sub: 'DeepSeek v4 Flash or any provider · watch emergent behavior' },
  { id: 'random',       label: 'Chaos',            sub: 'random valid action — chaos demo' },
];

// Provider presets — each preset auto-fills endpoint + a starter model.
// The chosen model drives ALL agent behavior. No hardcoded behavior maps.
// Smaller / dumber models produce shorter, more reactive sequences (e.g. wander).
// Larger / fine-tuned models reason about multi-step plans (e.g. throw cup -> shatter glass -> escape).
const PROVIDER_PRESETS = [
  {
    id: 'ollama-local',
    label: 'Ollama (local)',
    sub: 'localhost · your Mac · any model you pulled',
    endpoint: 'http://localhost:11434/api/generate',
    model: 'deepseek-r1-0528-qwen3:8b',
    needsKey: false,
    suggested: ['deepseek-r1-0528-qwen3:8b', 'qwen2.5:3b', 'qwen2.5:7b', 'llama3.2:3b', 'gemma-4-12b', 'qwen3:30b-a3b'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    sub: 'GPT-4o · GPT-4o-mini · GPT-3.5',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    needsKey: true,
    suggested: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini', 'o4-mini'],
  },
  {
    id: 'groq',
    label: 'Groq',
    sub: 'ultra-fast inference · LPU',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    needsKey: true,
    suggested: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-qwq-32b', 'mixtral-8x7b-32768'],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    sub: 'wafer-scale inference · fastest',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    model: 'llama3.1-70b',
    needsKey: true,
    suggested: ['llama3.1-8b', 'llama3.1-70b', 'llama-3.3-70b'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    sub: 'Claude · strong reasoning',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: 'claude-3-5-haiku-20241022',
    needsKey: true,
    suggested: ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-20241022'],
  },
  {
    id: 'custom',
    label: 'Custom',
    sub: 'paste any OpenAI-compatible endpoint',
    endpoint: 'https://your-endpoint.example/v1/chat/completions',
    model: 'your-model',
    needsKey: true,
    suggested: [],
  },
];

export function ArenaHUD() {
  const provider = useWorld(s => s.brainProviderId);
  const cameraMode = useWorld(s => s.cameraMode);
  const timeScale = useWorld(s => s.timeScale);
  const selectedId = useWorld(s => s.selectedAgentId);
  const agents = useWorld(s => s.agents);
  const thoughts = useWorld(s => s.thoughts);
  const endpoint = useWorld(s => s.hamiltonianEndpoint);
  const model = useWorld(s => s.hamiltonianModel);
  const apiKey = useWorld(s => s.hamiltonianApiKey);
  const presetId = useWorld(s => s.hamiltonianPresetId);
  const preset = PROVIDER_PRESETS.find(p => p.id === presetId) ?? PROVIDER_PRESETS[0];
  const [showSettings, setShowSettings] = useState(false);

  const latest = thoughts.find(t => t.agentId === selectedId);
  const selectedAgent = selectedId ? agents[selectedId] : null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 text-white">
      {/* Top bar */}
      <div className="pointer-events-auto absolute left-4 top-4 flex items-center gap-3">
        <div className="rounded-full border border-cyan-500/30 bg-[#0a1224]/80 px-4 py-1.5 backdrop-blur">
          <div className="text-[9px] uppercase tracking-[0.2em] text-cyan-400/70">Arena</div>
          <div className="font-mono text-xs text-cyan-100">swarmagents.codes / studio / arena</div>
        </div>
        <button
          onClick={() => setShowSettings(s => !s)}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 backdrop-blur"
        >
          {showSettings ? 'Close' : 'Settings'}
        </button>
      </div>

      {/* Top-right brain selector */}
      <div className="pointer-events-auto absolute right-4 top-4 w-80">
        <div className="rounded-2xl border border-cyan-500/15 bg-[#0a1224]/85 p-3 backdrop-blur-xl shadow-2xl shadow-cyan-500/10">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-400/80">Brain Provider</div>
            <span className="text-[9px] text-white/40">all agents</span>
          </div>
          <div className="space-y-1">
            {BRAINS.map(b => (
              <button
                key={b.id}
                onClick={() => world.setBrainProvider(b.id)}
                className={`block w-full rounded-lg border px-3 py-2 text-left text-xs transition ${
                  provider === b.id
                    ? 'border-cyan-400/50 bg-cyan-500/10 text-cyan-100'
                    : 'border-white/5 bg-white/5 text-white/70 hover:bg-white/10'
                }`}
              >
                <div className="font-medium">{b.label}</div>
                <div className="mt-0.5 text-[10px] text-white/40">{b.sub}</div>
              </button>
            ))}
          </div>
          {provider === 'hamiltonian' && (
            <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
              <label className="block text-[10px] uppercase tracking-wider text-white/40">Provider</label>
              <select
                value={presetId}
                onChange={(e) => {
                  const p = PROVIDER_PRESETS.find(x => x.id === e.target.value);
                  if (p) world.setHamiltonianPreset(p.id, p.endpoint, p.model);
                }}
                className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white"
              >
                {PROVIDER_PRESETS.map(p => (
                  <option key={p.id} value={p.id} className="bg-[#0a1224]">{p.label} — {p.sub}</option>
                ))}
              </select>

              <label className="block text-[10px] uppercase tracking-wider text-white/40">Model</label>
              {preset.suggested.length > 0 ? (
                <div className="flex gap-1 flex-wrap mb-1">
                  {preset.suggested.map(m => (
                    <button
                      key={m}
                      onClick={() => world.setHamiltonianModel(m)}
                      className={`rounded border px-1.5 py-0.5 text-[9px] font-mono ${
                        model === m
                          ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                          : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                value={model}
                onChange={e => world.setHamiltonianModel(e.target.value)}
                placeholder="or type a model name"
                className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono text-[10px] text-white"
              />

              <label className="block text-[10px] uppercase tracking-wider text-white/40">Endpoint</label>
              <input
                value={endpoint}
                onChange={e => world.setHamiltonianEndpoint(e.target.value)}
                className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono text-[10px] text-white"
              />

              {preset.needsKey && (
                <>
                  <label className="block text-[10px] uppercase tracking-wider text-white/40">API key</label>
                  <input
                    value={apiKey}
                    onChange={e => world.setHamiltonianApiKey(e.target.value)}
                    type="password"
                    placeholder={`${preset.label} API key…`}
                    className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono text-[10px] text-white"
                  />
                  <div className="text-[9px] text-amber-300/60">Sent to /api/hamiltonian/decide only — never logged or stored server-side.</div>
                </>
              )}

              <div className="text-[9px] text-white/40">
                Same scene, different model = different intelligence. <a className="text-cyan-400 underline" href="#help-modelfile">Setup guide</a>
              </div>
            </div>
          )}
        </div>

        {/* Time + camera controls */}
        <div className="mt-3 rounded-2xl border border-cyan-500/15 bg-[#0a1224]/85 p-3 backdrop-blur-xl">
          <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-cyan-400/80">Time</div>
          <div className="flex gap-1">
            {[0, 0.5, 1, 2, 4].map(s => (
              <button
                key={s}
                onClick={() => world.setTimeScale(s)}
                className={`flex-1 rounded-md border px-2 py-1 text-[10px] font-medium ${
                  timeScale === s
                    ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                    : 'border-white/5 bg-white/5 text-white/60 hover:bg-white/10'
                }`}
              >
                {s === 0 ? '⏸' : `${s}x`}
              </button>
            ))}
          </div>
          <div className="mt-3 mb-2 text-[10px] uppercase tracking-[0.2em] text-cyan-400/80">Camera</div>
          <div className="grid grid-cols-2 gap-1">
            {(['orbit', 'pov', 'over-shoulder', 'cinematic'] as const).map(m => (
              <button
                key={m}
                onClick={() => world.setCameraMode(m)}
                className={`rounded-md border px-2 py-1 text-[10px] font-medium capitalize ${
                  cameraMode === m
                    ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                    : 'border-white/5 bg-white/5 text-white/60 hover:bg-white/10'
                }`}
              >
                {m.replace('-', ' ')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom-left: agent select */}
      <div className="pointer-events-auto absolute bottom-4 left-4 flex gap-2">
        {Object.values(agents).map(a => (
          <button
            key={a.id}
            onClick={() => world.setSelected(a.id)}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
              selectedId === a.id
                ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
            } backdrop-blur`}
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: a.color }} />
            <span className="font-medium">{a.label}</span>
            <span className="text-[10px] text-white/40">{a.mood}</span>
            <span className="font-mono text-[10px] text-white/30">e:{a.energy.toFixed(2)}</span>
          </button>
        ))}
      </div>

      {/* Bottom-right: live thought (JSON in/out) */}
      <div className="pointer-events-auto absolute bottom-4 right-4 w-[380px] max-h-[40vh] overflow-hidden rounded-2xl border border-cyan-500/15 bg-[#0a1224]/85 backdrop-blur-xl">
        <div className="border-b border-white/5 p-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-400/80">
            Live decision · {selectedAgent?.label ?? '—'}
          </div>
          {latest && (
            <div className="mt-1 text-xs text-white">
              <span className="font-mono text-cyan-200">{latest.action.type}</span>
              {latest.action.target_id && <span className="ml-1 font-mono text-cyan-400/70">→ {latest.action.target_id}</span>}
            </div>
          )}
          {latest?.action.rationale && (
            <div className="mt-1 text-[11px] italic text-white/70">"{latest.action.rationale}"</div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-px bg-white/5 text-[9px]">
          <div className="bg-[#0a1224]/90 p-2">
            <div className="mb-1 uppercase tracking-wider text-cyan-400/60">Input</div>
            <pre className="max-h-32 overflow-auto font-mono text-[9px] leading-tight text-cyan-100/80">
              {latest ? JSON.stringify({ S_t: latest.perception.S_t, S_g: latest.perception.S_g, momentum: latest.perception.momentum }, null, 2) : '—'}
            </pre>
          </div>
          <div className="bg-[#0a1224]/90 p-2">
            <div className="mb-1 uppercase tracking-wider text-emerald-400/60">Output</div>
            <pre className="max-h-32 overflow-auto font-mono text-[9px] leading-tight text-emerald-200/90">
              {latest ? JSON.stringify({ optimal_action: latest.action.target_id ? `${latest.action.type}:${latest.action.target_id}` : latest.action.type, rationale: latest.action.rationale }, null, 2) : '—'}
            </pre>
          </div>
        </div>
      </div>

      {/* Center settings sheet */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="pointer-events-auto absolute left-1/2 top-20 -translate-x-1/2 w-[480px] rounded-2xl border border-cyan-500/15 bg-[#0a1224]/95 p-5 shadow-2xl shadow-cyan-500/10 backdrop-blur-xl"
            id="help-modelfile"
          >
            <div className="text-sm font-semibold text-cyan-100">Pick any model. Watch agents reason.</div>
            <p className="mt-2 text-[11px] text-white/60">
              Every brain call shape-shifts to the upstream API and forwards your key. Same scene, different
              model = visibly different intelligence. <span className="text-cyan-300">Smaller models</span> tend
              to wander; <span className="text-cyan-300">larger / fine-tuned models</span> chain actions (pick up
              cup &rarr; throw at glass &rarr; escape).
            </p>

            <div className="mt-3 text-[10px] uppercase tracking-wider text-cyan-400/70">Cloud (just paste a key)</div>
            <ul className="mt-1 space-y-1 pl-4 text-[11px] text-white/70 list-disc">
              <li>OpenAI &middot; Groq (fastest) &middot; Cerebras (wafer-scale) &middot; Anthropic</li>
              <li>Custom OpenAI-compatible: paste any /v1/chat/completions URL</li>
            </ul>

            <div className="mt-3 text-[10px] uppercase tracking-wider text-cyan-400/70">Local (free, your hardware)</div>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-[11px] text-white/70">
              <li><code className="rounded bg-white/10 px-1 py-0.5 text-cyan-200">brew install ollama && ollama serve</code></li>
              <li><code className="rounded bg-white/10 px-1 py-0.5 text-cyan-200">ollama pull qwen2.5:3b</code> (or any model you want)</li>
              <li>Choose &quot;Ollama (local)&quot; above, type the model name.</li>
            </ol>

            <div className="mt-3 text-[10px] uppercase tracking-wider text-cyan-400/70">Headline: our Hamiltonian LoRA (coming)</div>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-[11px] text-white/70">
              <li>
                <code className="rounded bg-white/10 px-1 py-0.5 text-cyan-200">
                  huggingface-cli download yaegerbomb42/qwen3-30b-a3b-hamiltonian-lora-gguf qwen3_30b_a3b_hamiltonian.q4_k_m.gguf Modelfile
                </code>
              </li>
              <li><code className="rounded bg-white/10 px-1 py-0.5 text-cyan-200">ollama create swarmagents-hamiltonian -f Modelfile</code></li>
              <li>Pick &quot;Ollama (local)&quot; + model &quot;swarmagents-hamiltonian&quot;.</li>
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
