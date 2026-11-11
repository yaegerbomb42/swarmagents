'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import { AGENT_ROLES } from '@/lib/agentRoles';
import { normalizeBindings, type RoleBinding } from '@/lib/roleBindings';
import type { StoredProvider } from '@/lib/providerStore';
import { readActiveDecompSessionId } from '@/lib/decompPersistence';
import { useAgentTelemetry } from '@/hooks/useAgentTelemetry';
import { buildSwarmHierarchy, mergeOrgSeats, type OrgSeat } from '@/lib/swarmHierarchy';
import { computeSpatialLayout } from '@/lib/spatialLayout';
import type { SpatialEdge, SpatialNode } from '@/lib/spatialLayout';
import SwarmCanvas3D from '../topology/SwarmCanvas3D';
import { authHeaders } from '@/lib/auth';

const NODE_W = 220;
const NODE_H = 108;

const ACTIVITY_STYLES: Record<
  NonNullable<SpatialNode['activity']>,
  { ring: string; glow: string; label: string }
> = {
  idle: { ring: 'rgba(255,255,255,0.12)', glow: 'transparent', label: 'Idle' },
  working: { ring: 'rgba(52,211,153,0.85)', glow: 'rgba(52,211,153,0.35)', label: 'Working' },
  communicating: { ring: 'rgba(34,211,238,0.95)', glow: 'rgba(34,211,238,0.45)', label: 'Communicating' },
};

function roleAccent(roleId: string): string {
  const role = AGENT_ROLES.find((r) => r.id === roleId);
  if (!role) return '#60a5fa';
  if (role.color.includes('cyan')) return '#22d3ee';
  if (role.color.includes('emerald')) return '#34d399';
  if (role.color.includes('violet') || role.color.includes('purple')) return '#a78bfa';
  if (role.color.includes('amber') || role.color.includes('orange')) return '#fbbf24';
  return '#60a5fa';
}

export default function SwarmHierarchyPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 640 });
  const [bindings, setBindings] = useState<RoleBinding[]>([]);
  const [providers, setProviders] = useState<StoredProvider[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(0.9);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [tick, setTick] = useState(0);
  const [viewMode, setViewMode] = useState<'2d' | 'webgl'>('2d');
  const [orgSeats, setOrgSeats] = useState<OrgSeat[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const { sandboxes, connected } = useAgentTelemetry({
    sessionId,
    enabled: Boolean(sessionId),
    pollFallbackMs: 2500,
  });

  useEffect(() => {
    setSessionId(readActiveDecompSessionId());
    const id = setInterval(() => setSessionId(readActiveDecompSessionId()), 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/providers/config', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setBindings(normalizeBindings(data.roleBindings));
        setProviders(Array.isArray(data.providers) ? data.providers : []);
      } catch {
        /* offline */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setOrgSeats([]);
      return;
    }
    let cancelled = false;
    const loadSeats = async () => {
      try {
        const res = await fetch(
          `/api/tasks/decompose?session=${encodeURIComponent(sessionId)}`,
          { headers: authHeaders(), cache: 'no-store' },
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const seats = Array.isArray(data.session?.seats) ? data.session.seats : [];
        if (cancelled) return;
        setOrgSeats(
          seats
            .filter((s: { status?: string }) => s.status !== 'retired')
            .map((s: OrgSeat & { ownsPaths?: string[]; leafIds?: string[] }) => ({
              id: String(s.id),
              title: String(s.title || s.id),
              status: String(s.status || 'idle'),
              ownsPaths: s.ownsPaths,
              leafIds: s.leafIds,
            })),
        );
      } catch {
        /* offline */
      }
    };
    void loadSeats();
    const id = setInterval(() => void loadSeats(), 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(id);
  }, []);

  const hierarchy = useMemo(
    () => mergeOrgSeats(buildSwarmHierarchy(bindings, providers, sandboxes), orgSeats),
    [bindings, providers, sandboxes, orgSeats, tick],
  );

  const layout = useMemo(
    () =>
      computeSpatialLayout(hierarchy, {
        nodeWidth: NODE_W,
        nodeHeight: NODE_H,
        peerGapX: 48,
        peerGapY: 56,
        subagentGapX: 28,
        subagentGapY: 140,
      }),
    [hierarchy],
  );

  const offset = useMemo(() => {
    const pad = 48;
    const cx = (layout.bounds.minX + layout.bounds.maxX) / 2;
    const cy = (layout.bounds.minY + layout.bounds.maxY) / 2;
    return {
      x: size.w / 2 - cx * zoom + pan.x,
      y: pad - layout.bounds.minY * zoom + pan.y,
    };
  }, [layout.bounds, size, zoom, pan]);

  const fitView = useCallback(() => {
    if (!layout.nodes.length) return;
    const pad = 80;
    const contentW = Math.max(layout.bounds.width, NODE_W);
    const contentH = Math.max(layout.bounds.height, NODE_H);
    const zx = (size.w - pad * 2) / contentW;
    const zy = (size.h - pad * 2) / contentH;
    setZoom(Math.min(1.15, Math.max(0.45, Math.min(zx, zy))));
    setPan({ x: 0, y: 0 });
  }, [layout, size]);

  useEffect(() => {
    fitView();
  }, [fitView, hierarchy.length]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom((z) => Math.min(3.5, Math.max(0.15, z * factor)));
  };

  const activeCount = hierarchy.filter((a) => a.activity !== 'idle').length;
  const liveCount = hierarchy.filter((a) => a.live).length;

  if (viewMode === 'webgl') {
    return (
      <div ref={containerRef} className="relative w-full h-full min-h-[520px] bg-[#040414] overflow-hidden">
        <SwarmCanvas3D
          agents={hierarchy}
          connected={connected}
          className="h-full"
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
        />
        <div className="absolute top-3 right-3 z-20 flex gap-1">
          <button
            type="button"
            onClick={() => setViewMode('2d')}
            className="rounded-md border border-white/10 bg-[#06061a]/90 px-2.5 py-1 text-[10px] font-mono uppercase text-zinc-400 hover:text-zinc-100"
          >
            2D Map
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[520px] bg-[#040414] overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            activeCount > 0
              ? 'radial-gradient(circle at 50% 20%, rgba(6,182,212,0.12) 0%, transparent 55%)'
              : 'radial-gradient(circle at 50% 20%, rgba(99,102,241,0.08) 0%, transparent 55%)',
        }}
      />

      <div className="absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-[#06061a]/90 px-2 py-1 text-[10px] font-mono text-zinc-300">
          {connected ? <Wifi className="w-3 h-3 text-cyan-400" /> : <WifiOff className="w-3 h-3 text-zinc-500" />}
          {connected ? 'telemetry live' : 'polling'}
        </span>
        <span className="rounded-md border border-white/[0.08] bg-[#06061a]/90 px-2 py-1 text-[10px] font-mono text-zinc-400">
          {hierarchy.length} agents · {liveCount} live · {activeCount} active
          {orgSeats.length > 0 ? ` · ${orgSeats.length} org` : ''}
        </span>
      </div>

      <div className="absolute top-3 right-3 z-20 flex gap-1">
        <button
          type="button"
          onClick={() => setViewMode('webgl')}
          className="rounded-md border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-mono uppercase text-cyan-300 hover:bg-cyan-500/20"
        >
          WebGL
        </button>
        <button
          type="button"
          onClick={fitView}
          className="rounded-md border border-white/10 bg-[#06061a]/90 px-2.5 py-1 text-[10px] font-mono uppercase text-zinc-400 hover:text-zinc-100"
        >
          Fit
        </button>
      </div>

      <svg
        className="absolute inset-0 z-10 cursor-grab active:cursor-grabbing"
        width={size.w}
        height={size.h}
        onWheel={onWheel}
        onMouseDown={(e) => setDrag({ x: e.clientX - pan.x, y: e.clientY - pan.y })}
        onMouseMove={(e) => {
          if (!drag) return;
          setPan({ x: e.clientX - drag.x, y: e.clientY - drag.y });
        }}
        onMouseUp={() => setDrag(null)}
        onMouseLeave={() => setDrag(null)}
      >
        <defs>
          <filter id="swarm-glow">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g transform={`translate(${offset.x} ${offset.y}) scale(${zoom})`}>
          {layout.edges.map((edge) => (
            <HierarchyEdge key={edge.id} edge={edge} tick={tick} nodes={layout.nodes} />
          ))}

          {layout.nodes.map((node) => (
            <HierarchyNode key={node.id} node={node} />
          ))}
        </g>
      </svg>

      <div className="absolute bottom-3 left-3 z-20 flex flex-wrap gap-2">
        {(['idle', 'working', 'communicating'] as const).map((state) => (
          <span
            key={state}
            className="inline-flex items-center gap-1 rounded border border-white/[0.06] bg-[#06061a]/85 px-2 py-0.5 text-[9px] font-mono text-zinc-500"
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: ACTIVITY_STYLES[state].ring, boxShadow: `0 0 8px ${ACTIVITY_STYLES[state].glow}` }}
            />
            {ACTIVITY_STYLES[state].label}
          </span>
        ))}
      </div>

      {!sessionId && (
        <div className="absolute inset-x-0 bottom-14 z-20 flex justify-center pointer-events-none">
          <p className="rounded-lg border border-amber-500/20 bg-amber-950/30 px-3 py-1.5 text-[10px] font-mono text-amber-200/80">
            Start a decomposition in Console to attach live sub-agent telemetry
          </p>
        </div>
      )}
    </div>
  );
}

function HierarchyEdge({
  edge,
  tick,
  nodes,
}: {
  edge: SpatialEdge;
  tick: number;
  nodes: SpatialNode[];
}) {
  const target = nodes.find((n) => n.id === edge.target);
  const active = target?.activity === 'communicating' || target?.activity === 'working';
  const pulseT = (tick % 60) / 60;

  return (
    <g>
      <path
        d={edge.path}
        fill="none"
        stroke={active ? 'rgba(34,211,238,0.55)' : 'rgba(255,255,255,0.08)'}
        strokeWidth={active ? 2.2 : 1.2}
        strokeDasharray={active ? undefined : '4 6'}
      />
      {active && (
        <circle r={3.5} fill="#22d3ee" filter="url(#swarm-glow)">
          <animateMotion dur={`${2.2 / edge.particleSpeed}s`} repeatCount="indefinite" path={edge.path} />
          <animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" repeatCount="indefinite" begin={`${pulseT}s`} />
        </circle>
      )}
    </g>
  );
}

function HierarchyNode({ node }: { node: SpatialNode }) {
  const accent = roleAccent(node.roleId);
  const activity = node.activity || 'idle';
  const style = ACTIVITY_STYLES[activity];
  const pulse = activity !== 'idle';
  const model = node.assignedModel || '—';
  const tier = node.modelTier || '—';

  return (
    <g transform={`translate(${node.x} ${node.y})`}>
      {pulse && (
        <rect
          x={-4}
          y={-4}
          width={node.width + 8}
          height={node.height + 8}
          rx={14}
          fill="none"
          stroke={style.ring}
          strokeWidth={2}
          opacity={0.85}
          filter="url(#swarm-glow)"
        >
          <animate attributeName="opacity" values="0.45;0.95;0.45" dur="1.6s" repeatCount="indefinite" />
        </rect>
      )}

      <rect
        x={0}
        y={0}
        width={node.width}
        height={node.height}
        rx={10}
        fill="#0a0a18"
        stroke={pulse ? style.ring : 'rgba(255,255,255,0.1)'}
        strokeWidth={1.5}
      />

      <rect x={0} y={0} width={4} height={node.height} rx={2} fill={accent} />

      <text x={12} y={18} fill="#e4e4e7" fontSize={11} fontFamily="ui-monospace, monospace" fontWeight={600}>
        {node.label.length > 22 ? `${node.label.slice(0, 22)}…` : node.label}
      </text>

      <text x={12} y={34} fill="#71717a" fontSize={9} fontFamily="ui-monospace, monospace">
        {node.roleId} · {tier}
      </text>

      <text x={12} y={58} fill="#a1a1aa" fontSize={9} fontFamily="ui-monospace, monospace">
        {model.length > 28 ? `${model.slice(0, 28)}…` : model}
      </text>

      {node.providerName && (
        <text x={12} y={72} fill="#52525b" fontSize={8} fontFamily="ui-monospace, monospace">
          {node.providerName.length > 32 ? `${node.providerName.slice(0, 32)}…` : node.providerName}
        </text>
      )}

      <g transform={`translate(${node.width - 72} 12)`}>
        <rect
          x={0}
          y={0}
          width={60}
          height={18}
          rx={4}
          fill={
            node.status === 'running'
              ? 'rgba(52,211,153,0.15)'
              : node.status === 'error'
                ? 'rgba(239,68,68,0.15)'
                : 'rgba(255,255,255,0.04)'
          }
          stroke={
            node.status === 'running'
              ? 'rgba(52,211,153,0.35)'
              : node.status === 'error'
                ? 'rgba(239,68,68,0.35)'
                : 'rgba(255,255,255,0.08)'
          }
        />
        <text x={30} y={12} textAnchor="middle" fill="#d4d4d8" fontSize={8} fontFamily="ui-monospace, monospace">
          {node.status}
        </text>
      </g>

      {activity === 'communicating' && (
        <g transform={`translate(${node.width - 20} ${node.height - 20})`}>
          <circle cx={6} cy={6} r={4} fill="#22d3ee" />
          <circle cx={6} cy={6} r={8} fill="none" stroke="#22d3ee" strokeWidth={1}>
            <animate attributeName="r" values="6;11;6" dur="1.4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.9;0.2;0.9" dur="1.4s" repeatCount="indefinite" />
          </circle>
        </g>
      )}

      {activity === 'working' && (
        <g transform={`translate(${node.width - 20} ${node.height - 20})`} stroke="#34d399" strokeWidth={1.5} fill="none">
          <polyline points="0,8 3,3 6,8 9,1 12,8" />
        </g>
      )}
    </g>
  );
}
