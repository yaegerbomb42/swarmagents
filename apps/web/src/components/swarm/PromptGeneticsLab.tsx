"use client";

import { useState, useEffect } from "react";
import {
  Users, Zap, Trophy, Dna, Target, Plus, Play,
  Activity, TrendingUp, Sparkles, GitMerge,
  RefreshCw, Lock, Unlock, CheckCircle2, XCircle,
  Clock, Cpu, ShieldCheck, ArrowRight, Layers
} from "lucide-react";
import type {
  TunedAgent,
  BenchmarkChallenge,
  BenchmarkRun,
  SynthesizedRole
} from "@/lib/lab/agentEvolution";
import { AGENT_ROLES, defaultDirectiveForRole, getAgentRoleById } from "@/lib/agentRoles";
import AgentRolesCatalog from "@/components/AgentRolesCatalog";

export default function PromptGeneticsLab({ embedded }: { embedded?: boolean }) {
  const [agents, setAgents] = useState<TunedAgent[]>([]);
  const [challenges, setChallenges] = useState<BenchmarkChallenge[]>([]);
  const [customRoles, setCustomRoles] = useState<SynthesizedRole[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"arena" | "tuner" | "lineage" | "roles">("arena");
  
  // Benchmark execution state
  const [selectedChallengeId, setSelectedChallengeId] = useState<string>("bench-decomp-auth");
  const [benchmarking, setBenchmarking] = useState(false);
  const [lastBenchmark, setLastBenchmark] = useState<BenchmarkRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tuner form state
  const [tunerName, setTunerName] = useState("");
  const [tunerRole, setTunerRole] = useState("architect");
  const [tunerProvider, setTunerProvider] = useState("deepseek");
  const [tunerModel, setTunerModel] = useState("DeepSeek-V4-Flash-batch");
  const [tunerEndpoint, setTunerEndpoint] = useState("");
  const [tunerDirective, setTunerDirective] = useState("You are a deterministic systems architect. Decompose complex goals into verifiable atomic DAG tasks.");
  const [tunerTone, setTunerTone] = useState("Analytical, concise, and uncompromising on correctness.");
  const [tunerRules, setTunerRules] = useState("Every leaf must name a real file path\nNever use vague placeholder labels\nSpecify measurable done checks");
  const [tunerKnowledge, setTunerKnowledge] = useState("Distributed Systems, API Design, Security Auditing");
  const [tunerTemp, setTunerTemp] = useState(0.2);

  // Role Synthesis state
  const [domainInput, setDomainInput] = useState("");
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthesizedRole, setSynthesizedRole] = useState<SynthesizedRole | null>(null);

  // Breeding state
  const [parentAId, setParentAId] = useState<string>("");
  const [parentBId, setParentBId] = useState<string>("");
  const [breeding, setBreeding] = useState(false);

  const fetchLabData = async () => {
    try {
      const [agentsRes, benchRes, rolesRes] = await Promise.all([
        fetch("/api/lab/agents"),
        fetch("/api/lab/benchmark"),
        fetch("/api/lab/roles"),
      ]);

      const agentsData = await agentsRes.json();
      const benchData = await benchRes.json();
      const rolesData = await rolesRes.json();

      if (agentsData.ok && Array.isArray(agentsData.agents)) {
        setAgents(agentsData.agents);
        if (!selectedAgentId && agentsData.agents.length > 0) {
          setSelectedAgentId(agentsData.agents[0].id);
        }
      }
      if (benchData.ok && Array.isArray(benchData.challenges)) {
        setChallenges(benchData.challenges);
      }
      if (rolesData.ok && Array.isArray(rolesData.roles)) {
        setCustomRoles(rolesData.roles);
      }
    } catch (e) {
      console.error("Failed to load lab data:", e);
    }
  };

  useEffect(() => {
    fetchLabData();
  }, []);

  useEffect(() => {
    const role = getAgentRoleById(tunerRole);
    if (!role) return;
    setTunerDirective(defaultDirectiveForRole(tunerRole));
    setTunerKnowledge(role.tools.join(', '));
  }, [tunerRole]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];

  const handleRunBenchmark = async () => {
    if (!selectedAgent) return;
    setBenchmarking(true);
    setError(null);
    try {
      const res = await fetch("/api/lab/benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgent.id,
          challengeId: selectedChallengeId,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Benchmark failed");
      setLastBenchmark(data.benchmark);
      await fetchLabData();
    } catch (err: any) {
      setError(err?.message || "Benchmark failed");
    } finally {
      setBenchmarking(false);
    }
  };

  const handleCreateAgent = async (lockImmediately = false) => {
    try {
      const res = await fetch("/api/lab/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: tunerName || `Agent-${tunerRole.toUpperCase()}-Gen0`,
          role: tunerRole,
          llmConfig: {
            provider: tunerProvider,
            model: tunerModel,
            temperature: tunerTemp,
            maxTokens: 4096,
            endpoint: tunerEndpoint || undefined,
          },
          contextDna: {
            systemDirective: tunerDirective,
            personaTone: tunerTone,
            reasoningRules: tunerRules.split("\n").map((r) => r.trim()).filter(Boolean),
            outputConstraints: ["Strict output formatting."],
            specializedKnowledge: tunerKnowledge.split(",").map((k) => k.trim()).filter(Boolean),
            temperature: tunerTemp,
          },
          locked: lockImmediately,
        }),
      });
      const data = await res.json();
      if (data.ok && data.agent) {
        await fetchLabData();
        setSelectedAgentId(data.agent.id);
        setActiveTab("arena");
      }
    } catch (err) {
      console.error("Failed to create agent:", err);
    }
  };

  const handleLockDna = async (agentId: string) => {
    try {
      const res = await fetch("/api/lab/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, action: "lock" }),
      });
      if (res.ok) fetchLabData();
    } catch (err) {
      console.error("Failed to lock DNA:", err);
    }
  };

  const handleBreed = async () => {
    if (!parentAId || !parentBId || parentAId === parentBId) return;
    setBreeding(true);
    try {
      const res = await fetch("/api/lab/evolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentAId, parentBId }),
      });
      const data = await res.json();
      if (data.ok && data.child) {
        await fetchLabData();
        setSelectedAgentId(data.child.id);
        setActiveTab("arena");
      }
    } catch (err) {
      console.error("Failed to breed agents:", err);
    } finally {
      setBreeding(false);
    }
  };

  const handleSynthesizeRole = async () => {
    if (!domainInput.trim()) return;
    setSynthesizing(true);
    try {
      const res = await fetch("/api/lab/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainDescription: domainInput }),
      });
      const data = await res.json();
      if (data.ok && data.role) {
        setSynthesizedRole(data.role);
        await fetchLabData();
      }
    } catch (err) {
      console.error("Failed to synthesize role:", err);
    } finally {
      setSynthesizing(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#060614] text-zinc-100 overflow-y-auto">
      {/* Top Header */}
      <div className="p-4 border-b border-white/[0.06] bg-[#0c0c1e] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Dna className="w-5 h-5 text-violet-400" />
          <div>
            <h2 className="text-[14px] font-semibold text-white">Agent Tuning & Generational Evolution Lab</h2>
            <p className="text-[11px] text-zinc-400">
              Tune prompt contexts across any LLM, lock generational DNA, and measure real task benchmarks.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {[
            { id: "arena" as const, label: "Benchmark Arena", icon: Target },
            { id: "tuner" as const, label: "Context Tuner", icon: Cpu },
            { id: "lineage" as const, label: "Generations & Breeding", icon: GitMerge },
            { id: "roles" as const, label: "Role Synthesizer", icon: Sparkles },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeTab === tab.id
                  ? "bg-violet-600/30 text-violet-200 border border-violet-500/40 shadow-xs"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
              }`}
            >
              <tab.icon size={13} />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 p-4 max-w-7xl w-full mx-auto space-y-6">
        {/* ── TAB 1: REAL BENCHMARK ARENA ───────────────────────────────── */}
        {activeTab === "arena" && (
          <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
            {/* Agent Selector & Profile Sidebar */}
            <div className="space-y-4">
              <div className="rounded-xl border border-white/[0.08] bg-[#0d0d24] p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">Active Fleet</span>
                  <span className="text-[10px] text-zinc-500">{agents.length} tuned agents</span>
                </div>
                <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                  {agents.map((ag) => (
                    <button
                      key={ag.id}
                      type="button"
                      onClick={() => setSelectedAgentId(ag.id)}
                      className={`w-full text-left p-2.5 rounded-lg border transition ${
                        selectedAgent?.id === ag.id
                          ? "bg-violet-500/15 border-violet-500/50 text-white"
                          : "bg-white/[0.02] border-white/[0.04] text-zinc-400 hover:border-white/[0.1]"
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-semibold">
                        <span className="truncate">{ag.name}</span>
                        <span className="text-[10px] font-mono text-violet-300">Gen {ag.generation}</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-500 mt-1">
                        <span>Role: {getAgentRoleById(ag.role)?.name ?? ag.role}</span>
                        <span className="text-emerald-400 font-mono">{ag.avgScore ? `${ag.avgScore} pts` : "Unrated"}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {selectedAgent && (
                <div className="rounded-xl border border-white/[0.08] bg-[#0d0d24] p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">Locked DNA</span>
                    {selectedAgent.locked ? (
                      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        <Lock size={10} /> Locked
                      </span>
                    ) : (
                      <button
                        onClick={() => handleLockDna(selectedAgent.id)}
                        className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 transition"
                      >
                        <Unlock size={10} /> Lock DNA
                      </button>
                    )}
                  </div>
                  <div className="text-xs text-zinc-300 leading-relaxed font-mono p-2 rounded bg-black/30 border border-white/[0.04]">
                    {selectedAgent.contextDna.systemDirective}
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    <span className="text-zinc-500">Tone: </span>
                    {selectedAgent.contextDna.personaTone}
                  </div>
                  <div className="text-[10px] text-zinc-500 font-mono">
                    Provider: {selectedAgent.llmConfig.provider} · Model: {selectedAgent.llmConfig.model}
                  </div>
                </div>
              )}
            </div>

            {/* Benchmark Execution Panel */}
            <div className="space-y-4">
              <div className="rounded-xl border border-white/[0.08] bg-[#0d0d24] p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Live Benchmark Challenge</h3>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Executes real prompt completions against {selectedAgent?.name} and scores output criteria.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleRunBenchmark}
                    disabled={benchmarking || !selectedAgent}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold transition disabled:opacity-40 shadow-sm"
                  >
                    {benchmarking ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
                    {benchmarking ? "Executing Model…" : "Run Live Challenge"}
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  {challenges.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedChallengeId(c.id)}
                      className={`text-left p-2.5 rounded-lg border transition ${
                        selectedChallengeId === c.id
                          ? "bg-violet-500/20 border-violet-500/60 text-white"
                          : "bg-white/[0.02] border-white/[0.04] text-zinc-400 hover:border-white/[0.1]"
                      }`}
                    >
                      <div className="text-xs font-semibold truncate">{c.title}</div>
                      <div className="text-[10px] text-zinc-500 mt-1 capitalize">
                        {c.category} · {c.difficulty}
                      </div>
                    </button>
                  ))}
                </div>

                {error && (
                  <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs font-mono">
                    {error}
                  </div>
                )}

                {/* Benchmark Output Card */}
                {lastBenchmark && (
                  <div className="rounded-xl border border-white/[0.08] bg-black/40 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
                      <div>
                        <span className="text-xs font-semibold text-white">{lastBenchmark.taskTitle}</span>
                        <div className="text-[10px] text-zinc-500 font-mono mt-0.5">
                          Latency: {lastBenchmark.latencyMs}ms · Est Tokens: {lastBenchmark.tokensUsed}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-zinc-400">Score:</span>
                        <span className="text-base font-bold font-mono text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded border border-emerald-500/20">
                          {lastBenchmark.score} / 100
                        </span>
                      </div>
                    </div>

                    {/* Gates Validation */}
                    <div className="space-y-1.5">
                      <div className="text-[10px] font-mono uppercase text-zinc-500">Criteria Gates</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {lastBenchmark.passedGates.map((gate, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-xs text-emerald-300 bg-emerald-500/10 px-2.5 py-1 rounded border border-emerald-500/20">
                            <CheckCircle2 size={12} className="shrink-0" />
                            <span className="truncate">{gate}</span>
                          </div>
                        ))}
                        {lastBenchmark.failedGates.map((gate, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-xs text-rose-300 bg-rose-500/10 px-2.5 py-1 rounded border border-rose-500/20">
                            <XCircle size={12} className="shrink-0" />
                            <span className="truncate">{gate}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Model Raw Output */}
                    <div className="space-y-1.5">
                      <div className="text-[10px] font-mono uppercase text-zinc-500">Live Model Output</div>
                      <pre className="p-3 rounded-lg bg-[#05050f] border border-white/[0.06] text-xs font-mono text-zinc-200 overflow-x-auto max-h-60 leading-relaxed whitespace-pre-wrap">
                        {lastBenchmark.modelOutput}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 2: CONTEXT TUNER & DNA LOCKER ─────────────────────────── */}
        {activeTab === "tuner" && (
          <div className="rounded-xl border border-white/[0.08] bg-[#0d0d24] p-5 space-y-4 max-w-3xl mx-auto">
            <div>
              <h3 className="text-sm font-semibold text-white">Tune Agent Context & Personality</h3>
              <p className="text-xs text-zinc-400 mt-0.5">
                Configure deterministic system directives, reasoning invariants, and model parameters before locking DNA.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-zinc-400">Agent Name</label>
                <input
                  value={tunerName}
                  onChange={(e) => setTunerName(e.target.value)}
                  placeholder="e.g. Apex-Architect-V1"
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-500"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-zinc-400">Role Base</label>
                <select
                  value={tunerRole}
                  onChange={(e) => setTunerRole(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white focus:outline-none focus:border-violet-500"
                >
                  {AGENT_ROLES.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name} · {role.model_tier}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-zinc-400">Provider</label>
                <select
                  value={tunerProvider}
                  onChange={(e) => setTunerProvider(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white focus:outline-none focus:border-violet-500"
                >
                  <option value="deepseek">DeepSeek (Platform/Azure)</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="groq">Groq</option>
                  <option value="ollama">Ollama (Local)</option>
                  <option value="vllm">vLLM / Custom</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-zinc-400">Model</label>
                <input
                  value={tunerModel}
                  onChange={(e) => setTunerModel(e.target.value)}
                  placeholder="e.g. gpt-4o, llama3.3, claude-3-5-sonnet"
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-500"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-zinc-400">Temperature ({tunerTemp})</label>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.05"
                  value={tunerTemp}
                  onChange={(e) => setTunerTemp(parseFloat(e.target.value))}
                  className="w-full mt-2 accent-violet-500"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-mono text-zinc-400">System Directives (Core Prompt)</label>
              <textarea
                rows={3}
                value={tunerDirective}
                onChange={(e) => setTunerDirective(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-500 leading-relaxed font-mono"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-zinc-400">Persona & Tone Directives</label>
                <input
                  value={tunerTone}
                  onChange={(e) => setTunerTone(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-500"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-zinc-400">Domain Knowledge Tags</label>
                <input
                  value={tunerKnowledge}
                  onChange={(e) => setTunerKnowledge(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-500"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-mono text-zinc-400">Reasoning Invariants (1 rule per line)</label>
              <textarea
                rows={3}
                value={tunerRules}
                onChange={(e) => setTunerRules(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-500 font-mono"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => handleCreateAgent(false)}
                className="px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-xs font-medium text-zinc-300 transition"
              >
                Save Draft
              </button>
              <button
                type="button"
                onClick={() => handleCreateAgent(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition shadow-sm"
              >
                <Lock size={12} /> Lock DNA & Save Profile
              </button>
            </div>
          </div>
        )}

        {/* ── TAB 3: GENERATIONAL PEDIGREE & BREEDING ───────────────────── */}
        {activeTab === "lineage" && (
          <div className="space-y-6">
            <div className="rounded-xl border border-white/[0.08] bg-[#0d0d24] p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">Cross-Generational Breeding</h3>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Select two top-performing agents to combine their context directives and spawn a hybrid generation.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleBreed}
                  disabled={breeding || !parentAId || !parentBId || parentAId === parentBId}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-pink-600 to-violet-600 hover:brightness-110 text-xs font-semibold text-white transition disabled:opacity-40 shadow-sm"
                >
                  {breeding ? <RefreshCw size={13} className="animate-spin" /> : <GitMerge size={13} />}
                  {breeding ? "Breeding Generation…" : "Breed Next Gen"}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-mono text-zinc-400">Parent Agent A</label>
                  <select
                    value={parentAId}
                    onChange={(e) => setParentAId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white focus:outline-none focus:border-violet-500"
                  >
                    <option value="">Select Parent A</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} (Gen {a.generation} · {a.avgScore || 0} pts)
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-mono text-zinc-400">Parent Agent B</label>
                  <select
                    value={parentBId}
                    onChange={(e) => setParentBId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white focus:outline-none focus:border-violet-500"
                  >
                    <option value="">Select Parent B</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} (Gen {a.generation} · {a.avgScore || 0} pts)
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Generational Tree View */}
            <div className="space-y-3">
              <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">Lineage Progression</span>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {agents.map((ag) => (
                  <div key={ag.id} className="rounded-xl border border-white/[0.06] bg-black/30 p-4 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white truncate">{ag.name}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
                        Gen {ag.generation}
                      </span>
                    </div>
                    <div className="text-[11px] text-zinc-400 font-mono truncate">
                      Parents: {ag.parentIds.length ? ag.parentIds.join(", ") : "Genesis Archetype"}
                    </div>
                    <div className="flex items-center justify-between text-xs pt-1 border-t border-white/[0.04]">
                      <span className="text-zinc-500">Benchmarks: {ag.tasksCompleted}</span>
                      <span className="text-emerald-400 font-mono font-bold">{ag.avgScore} pts</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 4: AUTONOMOUS ROLE SYNTHESIZER ────────────────────────── */}
        {activeTab === "roles" && (
          <div className="space-y-6">
            <div className="rounded-xl border border-white/[0.08] bg-[#0d0d24] p-5">
              <AgentRolesCatalog
                selectedId={tunerRole}
                onSelect={(role) => {
                  setTunerRole(role.id);
                  setActiveTab('tuner');
                }}
              />
            </div>

            <div className="rounded-xl border border-white/[0.08] bg-[#0d0d24] p-5 space-y-4 max-w-3xl mx-auto">
              <div>
                <h3 className="text-sm font-semibold text-white">Autonomous Domain Role Synthesizer</h3>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Describe any mission, product domain, or technical requirement. The Swarm will generate a customized, specialized Agent Role complete with locked prompt context and tool bindings.
                </p>
              </div>

              <div className="flex gap-2">
                <input
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !synthesizing) handleSynthesizeRole();
                  }}
                  placeholder="e.g. Distributed Cassandra Query Optimizer, Hawaiian Travel Itinerary Specialist, Rust Crypto Auditor..."
                  className="flex-1 px-3.5 py-2.5 rounded-lg bg-black/30 border border-white/[0.08] text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-violet-500"
                />
                <button
                  type="button"
                  onClick={handleSynthesizeRole}
                  disabled={synthesizing || !domainInput.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white transition disabled:opacity-40 shadow-sm whitespace-nowrap"
                >
                  {synthesizing ? <RefreshCw size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  {synthesizing ? "Synthesizing…" : "Synthesize Role"}
                </button>
              </div>
            </div>

            {/* Synthesized Output Display */}
            {synthesizedRole && (
              <div className="rounded-xl border border-violet-500/40 bg-violet-500/[0.04] p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-violet-500/20 pb-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-violet-400" />
                    <span className="text-sm font-bold text-white">{synthesizedRole.name}</span>
                  </div>
                  <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
                    Tier: {synthesizedRole.recommendedModelTier}
                  </span>
                </div>
                <div className="text-xs text-zinc-300 leading-relaxed">
                  {synthesizedRole.description}
                </div>
                <div className="text-xs text-zinc-400">
                  <span className="text-zinc-500 font-mono">Tools: </span>
                  {synthesizedRole.suggestedTools.join(", ")}
                </div>
                <div className="p-3 rounded-lg bg-black/40 border border-white/[0.06] text-xs font-mono text-zinc-200">
                  {synthesizedRole.contextDna.systemDirective}
                </div>
              </div>
            )}

            {/* Catalog of Custom Roles */}
            {customRoles.length > 0 && (
              <div className="space-y-3">
                <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400">Synthesized Swarm Roles</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {customRoles.map((r) => (
                    <div key={r.roleId} className="rounded-xl border border-white/[0.06] bg-black/30 p-4 space-y-2">
                      <div className="flex items-center justify-between text-xs font-semibold text-white">
                        <span>{r.name}</span>
                        <span className="text-[10px] font-mono text-zinc-500">{r.roleId}</span>
                      </div>
                      <div className="text-[11px] text-zinc-400 leading-relaxed">{r.description}</div>
                      <div className="text-[10px] text-zinc-500 font-mono">
                        Tools: {r.suggestedTools.join(", ")}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
