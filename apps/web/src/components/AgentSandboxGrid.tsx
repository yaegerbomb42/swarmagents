'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Terminal,
  Globe,
  FileCode,
  Layers,
  Maximize2,
  Minimize2,
  RefreshCw,
  Circle,
  Brain,
  LayoutGrid,
  Compass,
} from 'lucide-react';
import type { AgentSandbox, SandboxMode } from '@/lib/sandboxTypes';
import StatusDot from './status/StatusDot';
import UnifiedAgentSandbox from './sandbox/UnifiedAgentSandbox';
import InfiniteSandboxCanvas from './sandbox/InfiniteSandboxCanvas';

interface AgentSandboxGridProps {
  sessionId?: string | null;
  projectId?: string | null;
  focusNodeId?: string | null;
  onFocusNode?: (nodeId: string) => void;
  onOpenFile?: (path: string) => void;
  pollMs?: number;
  className?: string;
}

const MODE_ICON: Record<SandboxMode, React.ElementType> = {
  shell: Terminal,
  browser: Globe,
  edit: FileCode,
  mixed: Layers,
};

function fmtCount(n?: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function CompactSandboxCard({
  sandbox,
  onFocus,
  onOpenDetailed,
}: {
  sandbox: AgentSandbox;
  onFocus: () => void;
  onOpenDetailed: () => void;
}) {
  const Icon = MODE_ICON[sandbox.mode] || Terminal;
  const isRunning = sandbox.status === 'running';

  return (
    <div
      onClick={onFocus}
      className={`group relative flex flex-col rounded-xl border bg-[#0F0F0F] p-3 cursor-pointer transition-all hover:bg-[#141414] font-mono ${
        sandbox.focused
          ? 'border-cyan-500/80 shadow-[0_0_15px_rgba(0,245,255,0.2)]'
          : 'border-[#1a1a1a] hover:border-[#2a2a2a]'
      }`}
    >
      {/* Top row: Role, model badge, expand button */}
      <div className="flex items-center justify-between gap-1 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <StatusDot status={sandbox.status} size={7} />
          <span className="text-[10px] text-zinc-100 font-semibold uppercase tracking-wider truncate">
            {sandbox.archetype || sandbox.agentClass || 'agent'}
          </span>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDetailed();
          }}
          className="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-cyan-400 transition-opacity"
          title="Open interactive sandbox console"
        >
          <Maximize2 size={11} />
        </button>
      </div>

      {/* Title / Task */}
      <div className="text-[11px] text-white font-medium truncate mb-1" title={sandbox.label}>
        {sandbox.label}
      </div>
      <div className="text-[10px] text-[var(--fg-3)] truncate mb-2.5">
        {sandbox.taskLabel || '—'}
      </div>

      {/* Metrics Row */}
      <div className="mt-auto pt-2 border-t border-[#161616] flex items-center justify-between text-[10px] text-zinc-400">
        <span>tokens: {fmtCount(sandbox.tokensIn)}/{fmtCount(sandbox.tokensOut)}</span>
        <span className="text-cyan-400 font-medium">
          {typeof sandbox.contextPct === 'number' ? `${Math.round(sandbox.contextPct)}%` : '—'}
        </span>
      </div>
    </div>
  );
}

export default function AgentSandboxGrid({
  sessionId,
  projectId,
  focusNodeId,
  onFocusNode,
  onOpenFile,
  pollMs = 3000,
  className = '',
}: AgentSandboxGridProps) {
  const [sandboxes, setSandboxes] = useState<AgentSandbox[]>([]);
  const [browserOnline, setBrowserOnline] = useState(false);
  const [engineOnline, setEngineOnline] = useState(false);
  const [activeModalId, setActiveModalId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'canvas'>('grid');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId && !projectId) {
      setSandboxes([]);
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (sessionId) qs.set('sessionId', sessionId);
      if (projectId) qs.set('project_id', projectId);
      if (focusNodeId) qs.set('focusNodeId', focusNodeId);
      const res = await fetch(`/api/tasks/sandboxes?${qs}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      setSandboxes(data.sandboxes || []);
      setBrowserOnline(Boolean(data.browserOnline));
      setEngineOnline(Boolean(data.engineOnline));
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }, [sessionId, projectId, focusNodeId]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  const visible = useMemo(() => {
    const focused = sandboxes.filter((s) => s.focused || s.nodeId === focusNodeId);
    const rest = sandboxes.filter((s) => !focused.includes(s));
    return [...focused, ...rest].slice(0, 20);
  }, [sandboxes, focusNodeId]);

  const focusedSandbox = useMemo(() => {
    if (activeModalId) {
      return sandboxes.find((s) => s.id === activeModalId) || sandboxes[0];
    }
    if (focusNodeId) {
      return sandboxes.find((s) => s.nodeId === focusNodeId || s.id === focusNodeId);
    }
    return sandboxes[0];
  }, [sandboxes, activeModalId, focusNodeId]);

  if (!sessionId && !projectId) {
    return (
      <div className={`rounded-xl border border-[#1a1a1a] bg-[#0F0F0F] px-4 py-10 text-center font-mono ${className}`}>
        <Layers className="w-5 h-5 text-zinc-600 mx-auto mb-2" />
        <p className="text-[12px] text-zinc-500">
          Agents appear here when the swarm runs.
        </p>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-[#1a1a1a] bg-[#0F0F0F] overflow-hidden font-mono ${className}`}>
      {/* Header bar with View Mode Switch */}
      <div className="flex items-center justify-between px-3.5 h-10 border-b border-[#1a1a1a] bg-[#0c0c0c]">
        <div className="flex items-center gap-2.5 text-[12px] font-medium text-zinc-100">
          <Layers size={13} className="text-cyan-400" />
          <span>Active Agent Sandboxes</span>
          <span className="text-[10px] text-zinc-600">live agents</span>
        </div>

        <div className="flex items-center gap-2 text-[10px]">
          {/* View Mode Toggle */}
          <div className="flex items-center bg-[#141414] border border-[#1e1e1e] rounded-md p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                viewMode === 'grid'
                  ? 'bg-cyan-500/20 text-cyan-300 font-medium'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <LayoutGrid size={11} /> Grid
            </button>
            <button
              type="button"
              onClick={() => setViewMode('canvas')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                viewMode === 'canvas'
                  ? 'bg-cyan-500/20 text-cyan-300 font-medium'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Compass size={11} /> Spatial Canvas
            </button>
          </div>

          <button
            type="button"
            onClick={refresh}
            className="p-1 text-zinc-500 hover:text-zinc-200"
            title="Refresh"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-zinc-600">
          No agents yet — tiles open as leaves start running.
        </div>
      ) : viewMode === 'canvas' ? (
        <div className="h-[520px] relative bg-[#09090b]">
          <InfiniteSandboxCanvas
            sandboxes={sandboxes}
            fleetReview
            sessionId={sessionId}
            onSandboxUpdate={(agentId, patch) => {
              setSandboxes((prev) =>
                prev.map((s) => (s.id === agentId || s.agentId === agentId ? { ...s, ...patch } : s))
              );
            }}
          />
        </div>
      ) : (
        <div className="p-3.5 flex flex-col gap-4">
          {/* Primary Featured Sandbox matching prototype */}
          {focusedSandbox && (
            <div className="w-full max-w-[620px] mx-auto">
              <UnifiedAgentSandbox
                sandbox={focusedSandbox}
                fleetReview
                sessionId={sessionId}
                onUpdate={(patch) => {
                  setSandboxes((prev) =>
                    prev.map((s) => (s.id === focusedSandbox.id ? { ...s, ...patch } : s))
                  );
                }}
              />
            </div>
          )}

          {/* Grid of Other Live Agents */}
          {visible.length > 1 && (
            <div className="mt-2 pt-3 border-t border-[#1a1a1a]">
              <div className="text-[10px] text-[var(--fg-3)] uppercase tracking-wider mb-2.5 px-1">
                Other Swarm Agents ({visible.length - 1})
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                {visible
                  .filter((s) => s.id !== focusedSandbox?.id)
                  .map((sb) => (
                    <CompactSandboxCard
                      key={sb.id}
                      sandbox={sb}
                      onFocus={() => {
                        onFocusNode?.(sb.nodeId);
                        setActiveModalId(sb.id);
                      }}
                      onOpenDetailed={() => setActiveModalId(sb.id)}
                    />
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

