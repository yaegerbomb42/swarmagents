'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  RefreshCw,
  LayoutGrid,
  Compass,
  Search,
  Shield,
  Cpu,
  Zap,
  Filter,
  CheckCircle2,
  History,
} from 'lucide-react';
import type { AgentSandbox } from '@/lib/sandboxTypes';
import { readActiveDecompSessionId } from '@/lib/decompPersistence';
import RequireAuth from '@/components/auth/RequireAuth';
import ConsoleShell from '@/components/ConsoleShell';
import UnifiedAgentSandbox from '@/components/sandbox/UnifiedAgentSandbox';
import InfiniteSandboxCanvas from '@/components/sandbox/InfiniteSandboxCanvas';
import TraceReplayDebugger from '@/components/trace/TraceReplayDebugger';
import StatusDot from '@/components/status/StatusDot';
import { toCanonical, type CanonicalStatus } from '@/lib/status';

type RosterFilter = 'all' | 'running' | 'paused' | 'done' | 'failed';
const ROSTER_FILTERS: RosterFilter[] = ['all', 'running', 'paused', 'done', 'failed'];

function matchesFilter(status: CanonicalStatus, f: RosterFilter): boolean {
  if (f === 'all') return true;
  if (f === 'running') return status === 'running' || status === 'thinking' || status === 'planning' || status === 'validating';
  return status === f;
}

function fmtCount(n?: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default function LiveSandboxesPage() {
  const [sandboxes, setSandboxes] = useState<AgentSandbox[]>([]);
  const [browserOnline, setBrowserOnline] = useState(false);
  const [engineOnline, setEngineOnline] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'canvas' | 'replay'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<RosterFilter>('all');
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const sessionId = readActiveDecompSessionId();
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (sessionId) qs.set('sessionId', sessionId);
      const res = await fetch(`/api/tasks/sandboxes?${qs}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setSandboxes(data.sandboxes || []);
      setBrowserOnline(Boolean(data.browserOnline));
      setEngineOnline(Boolean(data.engineOnline));
      setLastUpdated(Date.now());
    } catch {
      /* keep last state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const filteredSandboxes = useMemo(() => {
    return sandboxes.filter((s) => {
      const matchQuery =
        !searchQuery.trim() ||
        s.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.archetype && s.archetype.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (s.model && s.model.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchStatus = matchesFilter(toCanonical(s.status), statusFilter);
      return matchQuery && matchStatus;
    });
  }, [sandboxes, searchQuery, statusFilter]);

  const activeSandbox = useMemo(() => {
    if (selectedAgentId) {
      return sandboxes.find((s) => s.id === selectedAgentId) || filteredSandboxes[0] || sandboxes[0];
    }
    return filteredSandboxes[0] || sandboxes[0];
  }, [sandboxes, filteredSandboxes, selectedAgentId]);

  return (
    <RequireAuth>
      <ConsoleShell>
        <main className="mx-auto max-w-[1800px] px-4 py-6 lg:px-8 flex-1 min-h-0 overflow-auto font-mono">

          {/* Header bar */}
          <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
            <div>
              <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                Agents
              </h1>
              <p className="text-[12px] text-zinc-400 mt-0.5">
                What each agent is doing right now ·{' '}
                <Link href="/decomp" className="text-cyan-400 hover:text-cyan-300">
                  open graph console
                </Link>
                {' · '}
                <Link href="/live/run" className="text-cyan-400 hover:text-cyan-300">
                  harness runs
                </Link>
              </p>
            </div>

            <div className="flex items-center gap-3">
              {/* View Mode Toggle */}
              <div className="flex items-center bg-[#141414] border border-[#1e1e1e] rounded-md p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-cyan-500/20 text-cyan-300 font-medium'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <LayoutGrid size={12} /> Sandbox View
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('canvas')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] transition-colors ${
                    viewMode === 'canvas'
                      ? 'bg-cyan-500/20 text-cyan-300 font-medium'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <Compass size={12} /> Spatial Canvas
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('replay')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] transition-colors ${
                    viewMode === 'replay'
                      ? 'bg-cyan-500/20 text-cyan-300 font-medium'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <History size={12} /> Trace Replay
                </button>
              </div>

              <button
                type="button"
                onClick={refresh}
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
                title="Refresh"
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          {viewMode === 'replay' ? (
            <div className="max-w-4xl mx-auto w-full">
              <TraceReplayDebugger
                currentAgentLabel={activeSandbox ? activeSandbox.label : '—'}
              />
            </div>
          ) : viewMode === 'canvas' ? (
            <div className="h-[calc(100vh-12rem)] min-h-[580px] rounded-2xl border border-[#1a1a1a] bg-[#09090b] overflow-hidden">
              <InfiniteSandboxCanvas
                sandboxes={sandboxes}
                onSandboxUpdate={(agentId, patch) => {
                  setSandboxes((prev) =>
                    prev.map((s) => (s.id === agentId || s.agentId === agentId ? { ...s, ...patch } : s))
                  );
                }}
              />
            </div>
          ) : (
            <div className="flex flex-col lg:flex-row gap-6 items-start justify-center">
              {/* Primary Interactive Sandbox matching prototype */}
              {activeSandbox ? (
                <div className="w-full max-w-[580px] shrink-0">
                  <UnifiedAgentSandbox
                    sandbox={activeSandbox}
                    onUpdate={(patch) => {
                      setSandboxes((prev) =>
                        prev.map((s) => (s.id === activeSandbox.id ? { ...s, ...patch } : s))
                      );
                    }}
                  />
                </div>
              ) : (
                <div className="w-full max-w-[580px] p-12 text-center rounded-2xl border border-[#1a1a1a] bg-[#0F0F0F] text-zinc-500 text-xs">
                  {engineOnline ? 'No active agents.' : 'No active agents — engine not reachable.'}
                </div>
              )}

              {/* Fleet Roster List */}
              {sandboxes.length > 0 && (
                <div className="flex-1 min-w-[280px] max-w-[520px] rounded-2xl border border-[#1a1a1a] bg-[#0F0F0F] p-4 flex flex-col gap-3">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 flex items-center justify-between pb-2 border-b border-[#1a1a1a]">
                    <span className="flex items-center gap-1.5 font-semibold text-zinc-300">
                      <Shield size={12} className="text-cyan-400" />
                      Swarm Agent Roster
                    </span>
                    <span className="font-mono text-zinc-400">
                      {filteredSandboxes.length}/{sandboxes.length} shown
                    </span>
                  </div>

                  {/* Search and Status Filters */}
                  <div className="flex flex-col gap-2">
                    <div className="relative">
                      <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search by agent name, role, model…"
                        className="w-full pl-7 pr-3 py-1.5 bg-[#141414] border border-[#222] rounded-lg text-[11px] text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-500/50 transition-colors"
                      />
                    </div>
                    <div className="flex items-center gap-1 overflow-x-auto pb-0.5 text-[10px]">
                      {ROSTER_FILTERS.map((st) => (
                        <button
                          key={st}
                          type="button"
                          onClick={() => setStatusFilter(st)}
                          className={`px-2 py-0.5 rounded capitalize transition-colors ${
                            statusFilter === st
                              ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/30'
                              : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                          }`}
                        >
                          {st}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2 overflow-y-auto max-h-[520px] pr-1">
                    {filteredSandboxes.length === 0 ? (
                      <div className="p-6 text-center text-[11px] text-zinc-400 border border-dashed border-[#222] rounded-xl">
                        {searchQuery.trim() ? <>No agents match &quot;{searchQuery}&quot;</> : `No ${statusFilter} agents`}
                      </div>
                    ) : (
                      filteredSandboxes.map((sb) => {
                        const isCurrent = activeSandbox?.id === sb.id;
                        return (
                          <div
                            key={sb.id}
                            onClick={() => setSelectedAgentId(sb.id)}
                            className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                              isCurrent
                                ? 'bg-[#161616] border-cyan-400/40 shadow-[0_0_12px_rgba(0,245,255,0.1)]'
                                : 'bg-[#0a0a0a] border-[#161616] hover:border-[#222]'
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <StatusDot status={sb.status} size={8} />
                              <div className="min-w-0">
                                <div className="text-[11px] text-zinc-200 font-medium truncate">
                                  {sb.label}
                                </div>
                                <div className="text-[9px] text-zinc-500 truncate">
                                  {sb.archetype || sb.agentClass || '—'} · {sb.model || '—'}
                                </div>
                              </div>
                            </div>

                            <div className="text-right text-[10px] text-zinc-400 shrink-0 font-mono tabular-nums">
                              <div>{fmtCount(sb.tokensIn)}/{fmtCount(sb.tokensOut)}</div>
                              <div className="text-cyan-400 font-medium">
                                {typeof sb.contextPct === 'number' ? `${Math.round(sb.contextPct)}% ctx` : '— ctx'}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </ConsoleShell>
    </RequireAuth>
  );
}
