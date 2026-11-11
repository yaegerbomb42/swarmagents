'use client';

// ════════════════════════════════════════════════════════════
//  AgentHealthMatrixCard
//
//  A compact Linear/Cursor-dark agent health matrix.
//  Each 10×10 cell represents one agent, colour-coded by status.
//  Live data from GET /api/swarm/agents; honest empty/unavailable states.
//  Supplemented by useSwarmTelemetry for aggregate phase / health.
// ════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Grid2X2, RefreshCw } from 'lucide-react';
import { useSwarmTelemetry } from '@/hooks/useSwarmTelemetry';
import { statusMeta, toCanonical, type CanonicalStatus } from '@/lib/status';

// ─── Types ────────────────────────────────────────────────────

export type AgentStatus = 'healthy' | 'busy' | 'cooldown' | 'error' | 'idle';

export interface AgentRecord {
  id: string;
  status: AgentStatus;
  model?: string;
  role?: string;
}

export interface AgentHealthMatrixCardProps {
  /** Engine health endpoint (default: '/api/engine/health') */
  endpoint?: string;
  className?: string;
  /** Poll interval in ms (default: 4000) */
  refreshMs?: number;
  onSelectAgent?: (agentId: string) => void;
}

// ─── Constants ────────────────────────────────────────────────

// Canonical status mapping (lib/status.ts). 'healthy' = ready/available → queued.
const CANONICAL: Record<AgentStatus, CanonicalStatus> = {
  healthy:  'queued',
  busy:     'running',
  cooldown: 'paused',
  error:    'failed',
  idle:     'offline',
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  healthy:  statusMeta(CANONICAL.healthy).colorVar,
  busy:     statusMeta(CANONICAL.busy).colorVar,
  cooldown: statusMeta(CANONICAL.cooldown).colorVar,
  error:    statusMeta(CANONICAL.error).colorVar,
  idle:     statusMeta(CANONICAL.idle).colorVar,
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  healthy:  'Ready',
  busy:     statusMeta(CANONICAL.busy).label,
  cooldown: statusMeta(CANONICAL.cooldown).label,
  error:    statusMeta(CANONICAL.error).label,
  idle:     statusMeta(CANONICAL.idle).label,
};

const LEGEND_ORDER: AgentStatus[] = ['healthy', 'busy', 'cooldown', 'error', 'idle'];

// ─── Helpers ──────────────────────────────────────────────────

function formatTimestamp(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusCounts(agents: AgentRecord[]): Record<AgentStatus, number> {
  const out: Record<AgentStatus, number> = { healthy: 0, busy: 0, cooldown: 0, error: 0, idle: 0 };
  for (const a of agents) out[a.status] = (out[a.status] ?? 0) + 1;
  return out;
}

// ─── API layer ────────────────────────────────────────────────

interface SwarmAgent {
  id?: string;
  agent_id?: string;
  status?: string;
  model?: string;
  role?: string;
}

function normaliseAgents(raw: SwarmAgent[]): AgentRecord[] {
  const VALID_STATUSES = new Set<AgentStatus>(['healthy', 'busy', 'cooldown', 'error', 'idle']);
  return raw.map((a, i): AgentRecord => {
    const rawStatus = (a.status ?? 'idle').toLowerCase();
    let status: AgentStatus;
    if (VALID_STATUSES.has(rawStatus as AgentStatus)) {
      status = rawStatus as AgentStatus;
    } else {
      // Map any other vocabulary through the canonical system.
      const c = toCanonical(rawStatus);
      status =
        c === 'running' || c === 'thinking' || c === 'planning' || c === 'validating' ? 'busy'
        : c === 'queued' ? 'healthy'
        : c === 'paused' || c === 'blocked' ? 'cooldown'
        : c === 'failed' ? 'error'
        : 'idle';
    }
    return {
      id:     a.id ?? a.agent_id ?? `agent-${i}`,
      status,
      model:  a.model,
      role:   a.role,
    };
  });
}

// ─── Component ────────────────────────────────────────────────

export default function AgentHealthMatrixCard({
  endpoint = '/api/engine/health',
  className = '',
  refreshMs = 4000,
  onSelectAgent,
}: AgentHealthMatrixCardProps) {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isMounted = useRef(true);

  // Supplement with aggregate telemetry for phase label
  const telemetry = useSwarmTelemetry(refreshMs);
  const phase = telemetry.phase;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch('/api/swarm/agents', { cache: 'no-store', signal });
      if (res.ok) {
        const data = (await res.json()) as SwarmAgent[] | { agents?: SwarmAgent[] };
        const list: SwarmAgent[] = Array.isArray(data) ? data : (data.agents ?? []);
        if (isMounted.current) {
          setAgents(normaliseAgents(list));
          setUnavailable(false);
        }
      } else if (isMounted.current) {
        // Non-OK: say so rather than showing stale or invented agents.
        setUnavailable(true);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (isMounted.current) setUnavailable(true);
    } finally {
      if (isMounted.current) {
        setLoading(false);
        setLastUpdate(Date.now());
      }
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    const ctl = new AbortController();
    void load(ctl.signal);
    const iv = window.setInterval(() => void load(ctl.signal), refreshMs);
    return () => {
      isMounted.current = false;
      ctl.abort();
      window.clearInterval(iv);
    };
  }, [load, refreshMs]);

  // Also use telemetry lastUpdate to timestamp more accurately
  const displayTs = telemetry.lastUpdate || lastUpdate;

  const counts = statusCounts(agents);
  const total = agents.length;

  const handleCellClick = useCallback(
    (id: string) => {
      setSelectedId(prev => (prev === id ? null : id));
      onSelectAgent?.(id);
    },
    [onSelectAgent],
  );

  const handleCellKeyDown = useCallback(
    (e: React.KeyboardEvent, id: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleCellClick(id);
      }
    },
    [handleCellClick],
  );

  return (
    <section
      data-testid="agent-health-matrix-card"
      aria-label={`Agent health matrix — ${total} agents`}
      className={`rounded-xl border p-3 space-y-2.5 ${className}`}
      style={{
        background: 'rgba(8, 10, 18, 0.72)',
        borderColor: 'rgba(255, 255, 255, 0.06)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      {/* ── Header ─────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Grid2X2 className="w-3.5 h-3.5 text-cyan-400/70" aria-hidden />
          <span className="text-[11px] font-semibold text-zinc-100 tracking-tight">
            Agent Matrix
          </span>
          {/* Agent count badge */}
          <span
            data-testid="agent-count-badge"
            className="inline-flex items-center justify-center rounded-full bg-white/[0.06] border border-white/[0.08] px-1.5 h-4 text-[9px] font-mono tabular-nums text-cyan-300/80"
            aria-label={`${total} agents`}
          >
            {total}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Phase pill */}
          <span
            data-testid="phase-label"
            className="text-[9px] font-mono uppercase tracking-widest text-zinc-500"
            aria-label={`Phase: ${phase}`}
          >
            {phase}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center justify-center h-5 w-5 rounded-md text-zinc-600 hover:text-cyan-300 hover:bg-white/[0.06] transition-colors"
            aria-label="Refresh agent matrix"
          >
            <RefreshCw
              className={`h-2.5 w-2.5 ${loading ? 'animate-spin text-cyan-400' : ''}`}
              aria-hidden
            />
          </button>
        </div>
      </div>

      {total === 0 && (
        <p data-testid="agent-matrix-empty" className="text-[11px] text-zinc-400">
          {unavailable ? 'Agent data unavailable — engine not reachable.' : loading && !lastUpdate ? 'Loading agents…' : 'No agents reported.'}
        </p>
      )}

      {/* ── Cell grid ──────────────────────────────── */}
      <div
        role="grid"
        aria-label="Agent status cells"
        aria-rowcount={Math.ceil(total / Math.ceil(Math.sqrt(total || 1)))}
        className="flex flex-wrap"
        style={{ gap: '1px' }}
      >
        <AnimatePresence initial={false} mode="sync">
          {agents.map((agent, i) => {
            const color = STATUS_COLOR[agent.status];
            const isSelected = selectedId === agent.id;
            const label = `${agent.role ?? 'Agent'} ${agent.id} — ${STATUS_LABEL[agent.status]}${agent.model ? ` (${agent.model})` : ''}`;

            return (
              <motion.button
                key={agent.id}
                role="gridcell"
                type="button"
                data-testid={`agent-cell-${agent.id}`}
                aria-label={label}
                aria-pressed={isSelected}
                title={label}
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.3 }}
                transition={{
                  duration: 0.18,
                  delay: i * 0.02, // 20ms stagger
                  ease: 'easeOut',
                }}
                onClick={() => handleCellClick(agent.id)}
                onKeyDown={(e) => handleCellKeyDown(e, agent.id)}
                className="relative rounded-[1px] focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent transition-transform hover:scale-[1.4] hover:z-10"
                style={{
                  width: '10px',
                  height: '10px',
                  backgroundColor: color,
                  opacity: isSelected ? 1 : 0.82,
                  boxShadow: isSelected
                    ? `0 0 0 1.5px ${color}, 0 0 6px ${color}60`
                    : undefined,
                }}
              />
            );
          })}
        </AnimatePresence>
      </div>

      {/* ── Selected agent tooltip ────────────────── */}
      <AnimatePresence>
        {selectedId && (() => {
          const agent = agents.find(a => a.id === selectedId);
          if (!agent) return null;
          return (
            <motion.div
              key="tooltip"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
              data-testid="agent-tooltip"
              className="flex items-center gap-2 rounded-lg border border-white/[0.08] px-2 py-1.5"
              style={{ background: 'rgba(8,10,18,0.9)' }}
            >
              <span
                className="inline-block w-2 h-2 rounded-[1px] shrink-0"
                style={{ backgroundColor: STATUS_COLOR[agent.status] }}
                aria-hidden
              />
              <span className="text-[10px] font-mono text-zinc-200 truncate">
                <span className="text-zinc-400">{agent.role ?? 'Agent'}</span>
                {' '}
                <span className="text-cyan-300">{agent.id}</span>
                {agent.model ? (
                  <span className="text-zinc-500"> · {agent.model}</span>
                ) : null}
              </span>
              <span
                className="ml-auto text-[9px] font-mono uppercase tracking-widest shrink-0"
                style={{ color: STATUS_COLOR[agent.status] }}
              >
                {agent.status}
              </span>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* ── Status bar / legend ────────────────────── */}
      <div
        data-testid="status-legend"
        className="flex items-center gap-3 pt-1 border-t border-white/[0.04]"
      >
        {LEGEND_ORDER.map(s => {
          const count = counts[s];
          if (count === 0) return null;
          return (
            <div
              key={s}
              className="flex items-center gap-1"
              title={`${count} ${STATUS_LABEL[s]}`}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-[1px]"
                style={{ backgroundColor: STATUS_COLOR[s] }}
                aria-hidden
              />
              <span className="text-[9px] font-mono tabular-nums text-zinc-500">
                {count}
                <span className="text-zinc-400 ml-0.5 text-[10px]">
                  {' '}{STATUS_LABEL[s].toLowerCase()}
                </span>
              </span>
            </div>
          );
        })}

        <span className="ml-auto text-[9px] font-mono tabular-nums text-zinc-700" aria-label="Last updated">
          {displayTs ? formatTimestamp(displayTs) : '—'}
        </span>
      </div>

      {/* Live region for assistive tech */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic>
        {`${total} agents — ${counts.healthy} ready, ${counts.busy} busy, ${counts.error} error. Phase: ${phase}.`}
      </span>
    </section>
  );
}
