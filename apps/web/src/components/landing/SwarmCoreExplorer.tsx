'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain,
  Network,
  GitMerge,
  Database,
  Coins,
  Globe,
  Cpu,
  ArrowRight,
  Terminal as TermIcon,
  Play,
  RotateCcw,
  Search,
  CheckCircle
} from 'lucide-react';

interface Aspect {
  id: string;
  title: string;
  icon: any;
  whatItIs: string;
  whyDifferent: string;
  badge: string;
  color: string;
}

const ASPECTS: Aspect[] = [
  {
    id: 'concept',
    title: 'Core Concept',
    icon: Brain,
    whatItIs: 'Give a mission and a wall-clock budget. swarmagents.codes decomposes it into a hierarchical task tree, auto-deepens until every leaf fits a small LLM worker, then executes in parallel.',
    whyDifferent: 'Trees are sized to your time budget — a 1-hour run becomes dozens to hundreds of atomic micro-tasks, not a shallow checklist.',
    badge: 'Time-budget swarms',
    color: 'from-cyan-400 to-teal-500'
  },
  {
    id: 'architecture',
    title: 'Architecture',
    icon: Network,
    whatItIs: 'Next.js console (/decomp) talking to a modular engine: decompose API, steering, sandboxes, browser CDP, and role→provider routing.',
    whyDifferent: 'You see the neon DAG, agent sandboxes, and steer directives in one place — the same surfaces operators use while the swarm runs.',
    badge: 'Console + engine',
    color: 'from-cyan-400 to-blue-500'
  },
  {
    id: 'decisions',
    title: 'Decision-Making',
    icon: GitMerge,
    whatItIs: 'Architect models plan and deepen; workers execute leaves; validators check acceptance criteria. Steering can pause, prefer, avoid, or re-decompose mid-run.',
    whyDifferent: 'Structured steer actions return applied / partial / queued — not fake acknowledgements when the engine is offline.',
    badge: 'Plan · act · steer',
    color: 'from-teal-400 to-cyan-500'
  },
  {
    id: 'memory',
    title: 'Memory & Context',
    icon: Database,
    whatItIs: 'Session trees, steer constraints, and role usage quotas persist across the run so workers stay on-mission.',
    whyDifferent: 'Prefer/avoid constraints and quality bars travel with the session — not lost between chat turns.',
    badge: 'Session context',
    color: 'from-emerald-400 to-teal-500'
  },
  {
    id: 'autonomy',
    title: 'Routing & Quotas',
    icon: Coins,
    whatItIs: 'Each agent role maps to a provider, model, RPM limit, daily $, and max concurrency — with fallback chains when primary is throttled.',
    whyDifferent: 'You decide which models do architect vs grunt work, and see live spend/RPM bars as the swarm burns quota.',
    badge: 'Role → model',
    color: 'from-amber-400 to-orange-500'
  },
  {
    id: 'browser',
    title: 'Browser Automation',
    icon: Globe,
    whatItIs: 'Chromium CDP backend for navigation, scraping, and form fills — surfaced as browser sandbox tiles under the DAG.',
    whyDifferent: 'Browser work is a first-class leaf tool alongside shell and edit, visible while agents run.',
    badge: 'CDP sandboxes',
    color: 'from-emerald-400 to-teal-500'
  },
  {
    id: 'quantum',
    title: 'Live Neon DAG',
    icon: Cpu,
    whatItIs: 'The decomposition tree renders as a live neon graph: pulse on active nodes, camera follow on the critical path, particles on edges, spawn animation on deepen.',
    whyDifferent: 'Operators watch the swarm grow and complete in real time instead of reading a static task list.',
    badge: 'Execution graph',
    color: 'from-cyan-400 to-teal-600'
  }
];

export default function SwarmCoreExplorer() {
  const [activeTab, setActiveTab] = useState<string>('concept');
  const activeAspect = ASPECTS.find(a => a.id === activeTab) || ASPECTS[0];

  // Visualizer interactive states — live engine where available
  const [decisionWeights, setDecisionWeights] = useState({ tokenCost: 35, speed: 70, precision: 80 });
  const [hamiltonianPath, setHamiltonianPath] = useState<string>('Calling engine /decide…');
  const [decideBusy, setDecideBusy] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [memories, setMemories] = useState<
    Array<{ text: string; type: string; dist: number }>
  >([]);

  const [financials, setFinancials] = useState({ balance: 0, revenue: 0, costs: 0 });
  const [isImproving, setIsImproving] = useState(false);
  const [improvementLogs, setImprovementLogs] = useState<string[]>(['Connecting to engine autonomy…']);

  const [browserUrl, setBrowserUrl] = useState('https://news.ycombinator.com');
  const [browserLogs, setBrowserLogs] = useState<string[]>(['Waiting for engine browser status…']);
  const [isBrowserRunning, setIsBrowserRunning] = useState(false);

  const [temp, setTemp] = useState(100);
  const [energy, setEnergy] = useState(8.43);
  const [quantumState, setQuantumState] = useState('idle');

  // Pull live memory / autonomy / quantum / browser on mount + poll
  useEffect(() => {
    let cancelled = false;

    const parseMoney = (v: unknown): number => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    };

    const refresh = async () => {
      try {
        const [ep, sem, work, fin, imp, q, br] = await Promise.all([
          fetch('/api/memory?tier=episodic', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
          fetch('/api/memory?tier=semantic', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
          fetch('/api/memory?tier=working', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
          fetch('/api/autonomy?view=financial', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
          fetch('/api/autonomy?view=improvement', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
          fetch('/api/quantum', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
          fetch('/api/browser', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
        ]);
        if (cancelled) return;

        const rows: Array<{ text: string; type: string; dist: number }> = [];
        for (const e of ep.entries || []) {
          const text =
            typeof e === 'string'
              ? e
              : String(e?.content || e?.text || e?.summary || JSON.stringify(e));
          rows.push({ text, type: 'episodic', dist: 0.1 });
        }
        for (const e of sem.results || sem.entries || []) {
          const text =
            typeof e === 'string'
              ? e
              : String(e?.content || e?.text || e?.fact || JSON.stringify(e));
          rows.push({ text, type: 'semantic', dist: Number(e?.score) || 0.3 });
        }
        if (work.context && typeof work.context === 'object') {
          for (const [k, v] of Object.entries(work.context)) {
            rows.push({
              text: `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
              type: 'working',
              dist: 0.05,
            });
          }
        }
        if (rows.length) setMemories(rows);
        else if (ep.note || sem.note || work.note) {
          setMemories([
            {
              text: String(ep.note || sem.note || work.note),
              type: 'working',
              dist: 0,
            },
          ]);
        }

        setFinancials({
          balance: parseMoney(fin.current_balance ?? fin.balance),
          revenue: parseMoney(fin.revenue_streams ?? fin.revenue),
          costs: parseMoney(fin.cost_centers ?? fin.costs),
        });

        const logs: string[] = [];
        if (imp.pending || imp.log || imp.entries) {
          const src = imp.pending || imp.log || imp.entries;
          if (Array.isArray(src)) {
            for (const item of src.slice(0, 8)) {
              logs.push(typeof item === 'string' ? item : JSON.stringify(item));
            }
          } else if (typeof src === 'string') logs.push(src);
        }
        if (imp.note) logs.push(String(imp.note));
        if (logs.length) setImprovementLogs(logs);

        if (q.status || q.state) {
          setQuantumState(String(q.status || q.state || 'idle'));
          if (q.temperature != null) setTemp(Number(q.temperature));
          if (q.energy != null) setEnergy(Number(q.energy));
        }

        if (br.cdp_connected != null || br.status) {
          setBrowserLogs((prev) => [
            `CDP: ${br.cdp_connected ? 'connected' : 'disconnected'} · ${br.status || 'idle'} · tasks=${br.task_count ?? 0}`,
            ...prev.slice(0, 6),
          ]);
        }
      } catch {
        /* keep last known */
      }
    };

    refresh();
    const id = setInterval(refresh, 12_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Debounced /decide when weights change
  useEffect(() => {
    const t = setTimeout(async () => {
      setDecideBusy(true);
      try {
        const res = await fetch('/api/hamiltonian/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            current_state: `weights cost=${decisionWeights.tokenCost} speed=${decisionWeights.speed} precision=${decisionWeights.precision}`,
            goal_state: 'maximize mission success under budget',
            available_actions: [
              'direct_api_dispatch',
              'parallel_fleet_routing',
              'multi_day_deep_reasoning',
              'query_memory',
              'spawn_workers',
            ],
            momentum: ['cost_aware', 'latency_sensitive', 'precision_first'],
          }),
        });
        const data = await res.json();
        if (data.optimal_action || data.success) {
          setHamiltonianPath(
            `${data.optimal_action || '—'}${data.rationale ? ` — ${String(data.rationale).slice(0, 80)}` : ''}`,
          );
        } else {
          const costFactor = decisionWeights.tokenCost * 0.4;
          const precisionFactor = (100 - decisionWeights.precision) * 0.5;
          const speedFactor = (100 - decisionWeights.speed) * 0.2;
          const hVal = (costFactor + precisionFactor + speedFactor).toFixed(2);
          setHamiltonianPath(`Local H=${hVal} (engine: ${data.error || 'offline'})`);
        }
      } catch {
        setHamiltonianPath('Engine /decide unreachable');
      } finally {
        setDecideBusy(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [decisionWeights]);

  const runSelfImprovement = async () => {
    if (isImproving) return;
    setIsImproving(true);
    setImprovementLogs((prev) => ['Requesting autonomy improvement status…', ...prev]);
    try {
      const res = await fetch('/api/autonomy?view=improvement', { cache: 'no-store' });
      const data = await res.json();
      const line =
        data.note ||
        (Array.isArray(data.log) ? data.log[0] : null) ||
        JSON.stringify(data).slice(0, 120);
      setImprovementLogs((prev) => [String(line), ...prev].slice(0, 12));
      const fin = await fetch('/api/autonomy?view=financial', { cache: 'no-store' }).then((r) =>
        r.json(),
      );
      const parseMoney = (v: unknown): number => {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          const n = parseFloat(v.replace(/[^0-9.-]/g, ''));
          return Number.isFinite(n) ? n : 0;
        }
        return 0;
      };
      setFinancials({
        balance: parseMoney(fin.current_balance ?? fin.balance),
        revenue: parseMoney(fin.revenue_streams ?? fin.revenue),
        costs: parseMoney(fin.cost_centers ?? fin.costs),
      });
    } catch (e: unknown) {
      setImprovementLogs((prev) => [
        e instanceof Error ? e.message : String(e),
        ...prev,
      ]);
    } finally {
      setIsImproving(false);
    }
  };

  const runBrowserAction = async () => {
    if (isBrowserRunning) return;
    setIsBrowserRunning(true);
    setBrowserLogs((prev) => [`Engine browser execute → ${browserUrl}`, ...prev]);
    try {
      const res = await fetch('/api/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scrape', url: browserUrl }),
      });
      const data = await res.json();
      setBrowserLogs((prev) => [
        typeof data === 'string' ? data : JSON.stringify(data).slice(0, 200),
        ...prev,
      ].slice(0, 10));
    } catch (e: unknown) {
      setBrowserLogs((prev) => [
        e instanceof Error ? e.message : String(e),
        ...prev,
      ]);
    } finally {
      setIsBrowserRunning(false);
    }
  };

  // Poll quantum while running
  useEffect(() => {
    if (quantumState !== 'running') return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/quantum', { cache: 'no-store' });
        const data = await res.json();
        if (data.temperature != null) setTemp(Number(data.temperature));
        if (data.energy != null) setEnergy(Number(data.energy));
        const st = String(data.status || data.state || 'running');
        setQuantumState(st);
      } catch {
        /* keep */
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [quantumState]);

  const startQuantumAnnealing = async () => {
    setQuantumState('running');
    try {
      const res = await fetch('/api/quantum', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const data = await res.json();
      if (data.temperature != null) setTemp(Number(data.temperature));
      if (data.energy != null) setEnergy(Number(data.energy));
      if (data.status) setQuantumState(String(data.status));
    } catch {
      setQuantumState('idle');
    }
  };

  return (
    <section className="w-full max-w-5xl mx-auto py-12 px-6 relative z-10">
      <div className="text-center mb-12">
        <div className="badge-pulse border-cyan-500/20 bg-cyan-500/5 text-cyan-300/80 mb-4 mx-auto w-fit">
          System surfaces
        </div>
        <h2 className="text-3xl md:text-5xl font-bold mb-4 tracking-tight text-white">
          Inside the <span className="text-cyan-300">swarm console</span>
        </h2>
        <p className="text-white/40 max-w-2xl mx-auto text-base">
          Explore the pieces that power mission → tree → workers → steer. Select a module for a quick dry-run.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch min-h-[580px]">
        {/* Left Side: Dynamic vertical selector */}
        <div className="lg:col-span-4 flex flex-col gap-2 bg-[#06061a]/40 border border-white/[0.04] p-4 rounded-2xl backdrop-blur-xl">
          <div className="text-[10px] font-mono tracking-widest text-white/30 uppercase px-2 mb-3">
            Core Engine Subsystems
          </div>
          {ASPECTS.map(aspect => {
            const Icon = aspect.icon;
            const isActive = activeTab === aspect.id;
            return (
              <button
                key={aspect.id}
                onClick={() => setActiveTab(aspect.id)}
                className={`tactile w-full flex items-center justify-between text-left p-3.5 rounded-xl group border ${
                  isActive
                    ? 'bg-gradient-to-r from-cyan-950/40 to-teal-950/20 border-cyan-500/30 text-white shadow-lg shadow-cyan-500/10'
                    : 'bg-transparent border-transparent text-white/50 hover:text-white/85 hover:bg-white/[0.03] hover:border-cyan-500/15'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg transition-all duration-150 ${
                    isActive
                      ? 'bg-cyan-500/20 text-cyan-400 scale-105'
                      : 'bg-white/5 text-white/50 group-hover:text-cyan-300 group-hover:bg-cyan-500/10 group-hover:scale-105'
                  }`}>
                    <Icon size={18} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold tracking-wide">{aspect.title}</div>
                    <div className="text-[10px] text-white/30 font-mono mt-0.5">{aspect.badge}</div>
                  </div>
                </div>
                <ArrowRight size={14} className={`opacity-0 -translate-x-2 transition-all ${
                  isActive ? 'opacity-100 translate-x-0 text-cyan-400' : 'group-hover:opacity-40 group-hover:translate-x-0'
                }`} />
              </button>
            );
          })}
        </div>

        {/* Right Side: Showcase panel with simulated interactions */}
        <div className="lg:col-span-8 flex flex-col bg-[#07071f]/60 border border-white/[0.06] rounded-3xl overflow-hidden shadow-2xl relative">
          {/* Top glow */}
          <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${activeAspect.color} opacity-80`} />

          {/* Header section */}
          <div className="p-6 md:p-8 border-b border-white/[0.04]">
            <div className="flex items-center gap-3 mb-3">
              <span className={`text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-md bg-white/[0.03] border border-white/[0.05] text-cyan-400`}>
                {activeAspect.badge}
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live Mock Engine Hooked
              </span>
            </div>
            <h3 className="text-xl md:text-2xl font-bold tracking-tight text-white mb-2">{activeAspect.title}</h3>
            <p className="text-sm text-white/70 leading-relaxed mb-4">{activeAspect.whatItIs}</p>

            <div className="p-4 rounded-xl bg-white/[0.02] border border-white/[0.04] text-xs">
              <span className="font-semibold text-white/90 block mb-1">Why it’s different:</span>
              <span className="text-white/40 leading-relaxed">{activeAspect.whyDifferent}</span>
            </div>
          </div>

          {/* Interactive Playground area */}
          <div className="p-6 md:p-8 flex-1 bg-black/30 flex flex-col justify-center min-h-[280px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="w-full h-full flex flex-col justify-center"
              >
                {/* 1. Core Concept visualization */}
                {activeTab === 'concept' && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between text-xs font-mono text-white/40">
                      <span>LLM Router</span>
                      <span className="text-cyan-400">DeepSeek v4 Routing Layer</span>
                      <span>Provably Optimal Target</span>
                    </div>
                    <div className="relative h-28 bg-[#090920] border border-cyan-500/10 rounded-2xl flex items-center justify-around overflow-hidden">
                      {/* Grid background */}
                      <div className="absolute inset-0 cyber-grid-overlay opacity-30" />
                      <div className="relative flex flex-col items-center z-10">
                        <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/40 flex items-center justify-center text-purple-400 font-mono text-xs font-bold animate-pulse">
                          DS
                        </div>
                        <span className="text-[10px] text-white/50 mt-1 font-mono">Input Goal</span>
                      </div>
                      <div className="flex-1 h-px bg-gradient-to-r from-purple-500/50 via-cyan-500 to-emerald-500/50 mx-2 relative">
                        <div className="absolute top-1/2 left-0 w-2 h-2 rounded-full bg-cyan-400 -translate-y-1/2 animate-ping" style={{ animationDuration: '2s' }} />
                        <div className="absolute top-1/2 right-1/4 w-1.5 h-1.5 rounded-full bg-emerald-400 -translate-y-1/2 animate-ping" style={{ animationDuration: '1.5s' }} />
                      </div>
                      <div className="relative flex flex-col items-center z-10">
                        <div className="w-10 h-10 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-400 font-mono text-xs font-bold">
                          H(x)
                        </div>
                        <span className="text-[10px] text-white/50 mt-1 font-mono">Hamiltonian</span>
                      </div>
                      <div className="flex-1 h-px bg-gradient-to-r from-cyan-500/50 to-emerald-500/50 mx-2" />
                      <div className="relative flex flex-col items-center z-10">
                        <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                          <CheckCircle size={18} />
                        </div>
                        <span className="text-[10px] text-white/50 mt-1 font-mono">Success</span>
                      </div>
                    </div>
                    <div className="text-[10px] font-mono text-white/40 text-center">
                      Click aspects on the left to simulate operational characteristics.
                    </div>
                  </div>
                )}

                {/* 2. Architecture visualization */}
                {activeTab === 'architecture' && (
                  <div className="space-y-4">
                    <div className="flex justify-between items-center text-xs font-mono text-white/40">
                      <span>Host: localhost:8400</span>
                      <span className="text-cyan-400">Auto-Loaded Subsystems</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { name: 'Memory Module', status: 'Idle', loaded: true },
                        { name: 'Quantum Optimizer', status: 'Sleeping', loaded: false },
                        { name: 'CDP Substrate', status: 'Ready', loaded: true },
                        { name: 'Consciousness Model', status: 'Loaded', loaded: true },
                        { name: 'Autonomy Drives', status: 'Active', loaded: true },
                        { name: 'Hive Graph Runtime', status: 'Sleeping', loaded: false }
                      ].map((sub, i) => (
                        <div key={i} className={`p-3 rounded-xl border font-mono text-xs flex flex-col justify-between h-16 transition-all ${
                          sub.loaded 
                            ? 'bg-cyan-950/20 border-cyan-500/20 text-cyan-200' 
                            : 'bg-white/[0.01] border-white/[0.04] text-white/30'
                        }`}>
                          <span className="font-semibold block truncate">{sub.name}</span>
                          <span className={`text-[9px] uppercase tracking-wider ${sub.loaded ? 'text-cyan-400' : 'text-white/20'}`}>
                            {sub.loaded ? '● ' + sub.status : '○ Standby'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 3. Decision-making visualization */}
                {activeTab === 'decisions' && (
                  <div className="space-y-4">
                    <div className="text-xs font-mono text-white/50 mb-2">
                      Adjust parameters to recalculate Hamiltonian state projection (/decide):
                    </div>
                    <div className="space-y-3 bg-[#090920] p-4 rounded-xl border border-white/[0.05]">
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs font-mono text-white/40">
                          <span>Token Budget Cost Weight</span>
                          <span className="text-cyan-400">{decisionWeights.tokenCost}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={decisionWeights.tokenCost}
                          onChange={(e) => setDecisionWeights(prev => ({ ...prev, tokenCost: +e.target.value }))}
                          className="w-full accent-cyan-400 h-1 bg-white/10 rounded-lg cursor-pointer"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs font-mono text-white/40">
                          <span>Speed/Throughput Weight</span>
                          <span className="text-cyan-400">{decisionWeights.speed}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={decisionWeights.speed}
                          onChange={(e) => setDecisionWeights(prev => ({ ...prev, speed: +e.target.value }))}
                          className="w-full accent-cyan-400 h-1 bg-white/10 rounded-lg cursor-pointer"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs font-mono text-white/40">
                          <span>Precision & Validation Constraint</span>
                          <span className="text-cyan-400">{decisionWeights.precision}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={decisionWeights.precision}
                          onChange={(e) => setDecisionWeights(prev => ({ ...prev, precision: +e.target.value }))}
                          className="w-full accent-cyan-400 h-1 bg-white/10 rounded-lg cursor-pointer"
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 p-3 bg-black/40 border border-cyan-500/10 rounded-lg font-mono text-xs">
                      <TermIcon size={14} className="text-cyan-400" />
                      <span className="text-white/40">Optimal Step:</span>
                      <span className="text-cyan-300 font-semibold">
                        {decideBusy ? 'Deciding…' : hamiltonianPath}
                      </span>
                    </div>
                  </div>
                )}

                {/* 4. Memory visualization */}
                {activeTab === 'memory' && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 bg-[#090920] border border-white/[0.08] px-3 py-2 rounded-xl">
                      <Search size={14} className="text-white/30" />
                      <input
                        type="text"
                        placeholder="Search semantic / episodic memory store..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="bg-transparent border-none outline-none text-xs text-white placeholder-white/30 w-full"
                      />
                    </div>
                    <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                      {memories
                        .filter(m => searchQuery === '' || m.text.toLowerCase().includes(searchQuery.toLowerCase()))
                        .map((mem, i) => (
                          <div key={i} className="flex justify-between items-center p-2 rounded bg-white/[0.02] border border-white/[0.04] text-xs font-mono">
                            <div className="flex items-center gap-2 truncate">
                              <span className={`text-[9px] uppercase px-1.5 py-0.5 rounded ${
                                mem.type === 'working' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                                mem.type === 'semantic' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' :
                                'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                              }`}>
                                {mem.type}
                              </span>
                              <span className="text-white/70 truncate">{mem.text}</span>
                            </div>
                            <span className="text-[10px] text-white/30 ml-2">dist: {mem.dist}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {/* 5. Autonomy visualization */}
                {activeTab === 'autonomy' && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.04] text-center font-mono">
                        <div className="text-[9px] text-white/40 uppercase">VIRTUAL BALANCE</div>
                        <div className="text-lg font-bold text-amber-400">${financials.balance.toFixed(2)}</div>
                      </div>
                      <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.04] text-center font-mono">
                        <div className="text-[9px] text-white/40 uppercase">REVENUE DEPLOYED</div>
                        <div className="text-lg font-bold text-emerald-400">${financials.revenue.toFixed(2)}</div>
                      </div>
                      <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.04] text-center font-mono">
                        <div className="text-[9px] text-white/40 uppercase">COMPUTE COSTS</div>
                        <div className="text-lg font-bold text-rose-400">${financials.costs.toFixed(2)}</div>
                      </div>
                    </div>

                    <div className="flex items-stretch gap-3">
                      <button
                        onClick={runSelfImprovement}
                        disabled={isImproving}
                        className="flex items-center justify-center gap-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:shadow-lg hover:shadow-amber-500/20 text-black font-semibold text-xs px-4 rounded-xl transition-all min-h-[44px]"
                      >
                        {isImproving ? (
                          <>
                            <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                            Refactoring...
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5" />
                            Force Self-Improvement
                          </>
                        )}
                      </button>
                      <div className="flex-1 p-2 rounded-xl bg-[#090920] border border-white/[0.05] font-mono text-[10px] text-white/40 max-h-11 overflow-y-auto">
                        <span className="text-amber-400 font-bold block uppercase tracking-wider text-[8px] mb-0.5">DRIVE ACTIVITY LOGGER</span>
                        {improvementLogs[0]}
                      </div>
                    </div>
                  </div>
                )}

                {/* 6. Browser visualization */}
                {activeTab === 'browser' && (
                  <div className="space-y-4">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={browserUrl}
                        onChange={(e) => setBrowserUrl(e.target.value)}
                        placeholder="Target URL..."
                        className="flex-1 bg-[#090920] border border-white/[0.08] px-3 py-2 rounded-xl text-xs font-mono text-white outline-none"
                      />
                      <button
                        onClick={runBrowserAction}
                        disabled={isBrowserRunning}
                        className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black text-xs font-semibold px-4 rounded-xl transition-colors flex items-center gap-1.5"
                      >
                        {isBrowserRunning ? 'Scraping...' : 'Request Navigation'}
                      </button>
                    </div>
                    <div className="bg-black/40 border border-white/[0.06] rounded-xl p-3 h-28 overflow-y-auto font-mono text-[11px] text-white/50 space-y-1">
                      {browserLogs.map((log, i) => (
                        <div key={i} className="flex gap-1.5">
                          <span className="text-cyan-400/60">&gt;</span>
                          <span>{log}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 7. Quantum visualization */}
                {activeTab === 'quantum' && (
                  <div className="space-y-4">
                    <div className="flex justify-between items-center text-xs font-mono text-white/40">
                      <span>Subsystem: HIERARCHICAL_NEON_DAG</span>
                      <span className="text-cyan-400">Cognitive Singleton Arbitrator</span>
                    </div>

                    <div className="relative bg-[#06070a]/80 p-4 rounded-2xl border border-cyan-500/10 flex justify-center items-center overflow-hidden">
                      <svg viewBox="0 0 900 500" width="100%" className="max-h-[320px] select-none">
                        {/* CSS variables definition */}
                        <defs>
                          <style>{`
                            .node-chip { 
                              fill: rgba(19,23,32,0.72); 
                              stroke: rgba(201,162,39,0.28); 
                              stroke-width: 1.2; 
                              transition: all 0.3s ease;
                            }
                            .node-chip:hover {
                              stroke: #C9A227;
                              fill: rgba(30,35,48,0.85);
                            }
                            .node-label { 
                              fill: #E8E6DF; 
                              font-size: 13px; 
                              font-weight: 600; 
                              font-family: 'IBM Plex Mono', monospace;
                            }
                            .node-sub { 
                              fill: #565F6E; 
                              font-size: 9.5px; 
                              letter-spacing: 0.08em; 
                              font-family: 'IBM Plex Mono', monospace;
                            }
                            .trace { 
                              fill: none; 
                              stroke: rgba(201,162,39,0.28); 
                              stroke-width: 1.4; 
                            }
                            .hub { 
                              fill: rgba(19,23,32,0.72); 
                              stroke: #C9A227; 
                              stroke-width: 1.6; 
                            }
                            .hub-label { 
                              fill: #E8B94D; 
                              font-size: 14px; 
                              font-weight: 600; 
                              font-family: 'IBM Plex Mono', monospace;
                            }
                            .hub-sub { 
                              fill: #565F6E; 
                              font-size: 9px; 
                              letter-spacing: 0.1em; 
                              font-family: 'IBM Plex Mono', monospace;
                            }
                            .pulse { 
                              fill: #E8B94D; 
                              filter: drop-shadow(0 0 4px #E8B94D); 
                            }
                            .pulse.blue { 
                              fill: #4FA8C9; 
                              filter: drop-shadow(0 0 4px #4FA8C9); 
                            }
                          `}</style>
                        </defs>

                        {/* traces */}
                        <path className="trace" d="M450,60 L450,155 L450,155 L450,250" />
                        <path className="trace" d="M614.5,155 L614.5,202.5 L450,202.5 L450,250" />
                        <path className="trace" d="M614.5,345 L614.5,297.5 L450,297.5 L450,250" />
                        <path className="trace" d="M450,440 L450,345 L450,345 L450,250" />
                        <path className="trace" d="M285.5,345 L285.5,297.5 L450,297.5 L450,250" />
                        <path className="trace" d="M285.5,155 L285.5,202.5 L450,202.5 L450,250" />

                        {/* pulses traveling node -> hub */}
                        <circle className="pulse" r="3.4">
                          <animateMotion dur="2.6s" repeatCount="indefinite" begin="0s" path="M450,60 L450,155 L450,155 L450,250" />
                        </circle>
                        <circle className="pulse blue" r="3.4">
                          <animateMotion dur="3s" repeatCount="indefinite" begin="0.4s" path="M614.5,155 L614.5,202.5 L450,202.5 L450,250" />
                        </circle>
                        <circle className="pulse" r="3.4">
                          <animateMotion dur="2.8s" repeatCount="indefinite" begin="1.1s" path="M614.5,345 L614.5,297.5 L450,297.5 L450,250" />
                        </circle>
                        <circle className="pulse blue" r="3.4">
                          <animateMotion dur="3.2s" repeatCount="indefinite" begin="0.7s" path="M450,440 L450,345 L450,345 L450,250" />
                        </circle>
                        <circle className="pulse" r="3.4">
                          <animateMotion dur="2.4s" repeatCount="indefinite" begin="1.6s" path="M285.5,345 L285.5,297.5 L450,297.5 L450,250" />
                        </circle>
                        <circle className="pulse blue" r="3.4">
                          <animateMotion dur="2.9s" repeatCount="indefinite" begin="0.2s" path="M285.5,155 L285.5,202.5 L450,202.5 L450,250" />
                        </circle>

                        {/* pulses hub -> node (dispatch), slower/sparser */}
                        <circle className="pulse blue" r="2.6" opacity="0.8">
                          <animateMotion dur="4s" repeatCount="indefinite" begin="1.8s" path="M450,250 L450,155 L450,155 L450,60" />
                        </circle>
                        <circle className="pulse" r="2.6" opacity="0.8">
                          <animateMotion dur="4.4s" repeatCount="indefinite" begin="2.4s" path="M450,250 L450,297.5 L285.5,297.5 L285.5,345" />
                        </circle>

                        {/* nodes */}
                        {/* top: Researcher */}
                        <g>
                          <rect className="node-chip" x="414" y="24" width="72" height="72" rx="10"/>
                          <text className="node-label" x="450" y="56" text-anchor="middle">R1</text>
                          <text className="node-sub" x="450" y="72" text-anchor="middle">RESEARCHER</text>
                        </g>
                        {/* upper right: Planner */}
                        <g>
                          <rect className="node-chip" x="578.5" y="119" width="72" height="72" rx="10"/>
                          <text className="node-label" x="614.5" y="151" text-anchor="middle">P1</text>
                          <text className="node-sub" x="614.5" y="167" text-anchor="middle">PLANNER</text>
                        </g>
                        {/* lower right: Coder */}
                        <g>
                          <rect className="node-chip" x="578.5" y="309" width="72" height="72" rx="10"/>
                          <text className="node-label" x="614.5" y="341" text-anchor="middle">C1</text>
                          <text className="node-sub" x="614.5" y="357" text-anchor="middle">CODER</text>
                        </g>
                        {/* bottom: Grunt */}
                        <g>
                          <rect className="node-chip" x="414" y="404" width="72" height="72" rx="10"/>
                          <text className="node-label" x="450" y="436" text-anchor="middle">G1</text>
                          <text className="node-sub" x="450" y="452" text-anchor="middle">GRUNT</text>
                        </g>
                        {/* lower left: Reviewer */}
                        <g>
                          <rect className="node-chip" x="249.5" y="309" width="72" height="72" rx="10"/>
                          <text className="node-label" x="285.5" y="341" text-anchor="middle">V1</text>
                          <text className="node-sub" x="285.5" y="357" text-anchor="middle">REVIEWER</text>
                        </g>
                        {/* upper left: Debug */}
                        <g>
                          <rect className="node-chip" x="249.5" y="119" width="72" height="72" rx="10"/>
                          <text className="node-label" x="285.5" y="151" text-anchor="middle">D1</text>
                          <text className="node-sub" x="285.5" y="167" text-anchor="middle">DEBUG</text>
                        </g>

                        {/* hub */}
                        <rect className="hub" x="382" y="200" width="136" height="100" rx="14"/>
                        <text className="hub-label" x="450" y="240" text-anchor="middle">U1 · AGENT O</text>
                        <text className="hub-sub" x="450" y="258" text-anchor="middle">COGNITIVE SINGLETON</text>
                        <text className="hub-sub" x="450" y="273" text-anchor="middle" fill="#8891A0">ARBITRATES ALL CLAIMS</text>
                      </svg>
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
