'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, Zap } from 'lucide-react';

// ═══════════════════════════════════════════════════════════
//  FleetTelemetryStrip — low-overhead live fleet telemetry rail
//
//  Single poll against /api/engine/health (the only endpoint that
//  exposes both cumulative `total_tokens` and `avg_latency_ms`).
//  Token velocity is derived from the delta between two samples so
//  the engine does not need to add a new field.
// ════════════════════════════════════════════════════════════

export type EngineHealthSample = {
  status?: string;
  active_agents?: number;
  total_agents?: number;
  tasks_queued?: number;
  tasks_running?: number;
  tasks_completed?: number;
  tasks_failed?: number;
  avg_latency_ms?: number;
  uptime_seconds?: number;
  uptime_human?: string;
  throughput?: number;
  total_tokens?: number;
  orchestrator_lifecycle?: string;
  engine_error?: string;
};

export type TokenVelocitySample = {
  totalTokens: number;
  at: number;
};

/**
 * Derives tokens/second from two cumulative-token samples.
 * Returns null when there is no prior sample, the counter went
 * backwards (engine restart), or no measurable time elapsed.
 */
export function computeTokenVelocity(
  prev: TokenVelocitySample | null,
  next: TokenVelocitySample,
): number | null {
  if (!prev) return null;
  const elapsedMs = next.at - prev.at;
  if (elapsedMs <= 0) return null;
  const delta = next.totalTokens - prev.totalTokens;
  if (delta < 0) return null;
  return (delta / elapsedMs) * 1000;
}

/** 1234567 -> "1.23M" */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export type FleetTelemetryStripProps = {
  className?: string;
  refreshIntervalMs?: number;
  /** Injectable for tests; defaults to the dashboard health proxy. */
  endpoint?: string;
};

type Metric = {
  id: string;
  label: string;
  value: string;
  title: string;
  live?: boolean;
};

export default function FleetTelemetryStrip({
  className = '',
  refreshIntervalMs = 5000,
  endpoint = '/api/engine/health',
}: FleetTelemetryStripProps) {
  const [health, setHealth] = useState<EngineHealthSample | null>(null);
  const [tokensPerSec, setTokensPerSec] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastSample = useRef<TokenVelocitySample | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(endpoint, { cache: 'no-store', signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as EngineHealthSample;
        setHealth(data);
        setError(null);

        if (typeof data.total_tokens === 'number') {
          const next: TokenVelocitySample = {
            totalTokens: data.total_tokens,
            at: Date.now(),
          };
          setTokensPerSec(computeTokenVelocity(lastSample.current, next));
          lastSample.current = next;
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Telemetry unavailable');
      } finally {
        setLoading(false);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    const id = window.setInterval(() => void load(ctl.signal), refreshIntervalMs);
    return () => {
      ctl.abort();
      window.clearInterval(id);
    };
  }, [load, refreshIntervalMs]);

  const agents = health?.active_agents ?? null;
  const totalAgents = health?.total_agents ?? null;
  const status = error ? 'offline' : (health?.status ?? 'idle');

  const metrics: Metric[] = [
    {
      id: 'velocity',
      label: 'tok/s',
      value: tokensPerSec === null ? '—' : formatCompact(tokensPerSec),
      title: 'Token velocity derived from the cumulative token delta',
      live: tokensPerSec !== null && tokensPerSec > 0,
    },
    {
      id: 'latency',
      label: 'lat',
      value: health?.avg_latency_ms != null ? `${health.avg_latency_ms}ms` : '—',
      title: 'Mean task latency',
    },
    {
      id: 'throughput',
      label: 'thru',
      value: health?.throughput != null ? `${health.throughput}/m` : '—',
      title: 'Completed tasks per minute',
    },
    {
      id: 'agents',
      label: 'agents',
      value:
        agents != null
          ? `${agents}${totalAgents != null ? `/${totalAgents}` : ''}`
          : '—',
      title: 'Healthy / total agents',
    },
    {
      id: 'queue',
      label: 'queue',
      value:
        health?.tasks_queued != null
          ? `${health.tasks_queued}${health.tasks_running ? `+${health.tasks_running}` : ''}`
          : '—',
      title: 'Queued (+ running) tasks',
    },
    {
      id: 'tokens',
      label: 'tokens',
      value: health?.total_tokens != null ? formatCompact(health.total_tokens) : '—',
      title: 'Cumulative tokens served',
    },
    {
      id: 'uptime',
      label: 'up',
      value: health?.uptime_human ?? '—',
      title: 'Engine uptime',
    },
  ];

  return (
    <section
      data-testid="fleet-telemetry-strip"
      aria-label="Fleet telemetry"
      className={`flex items-center gap-3 overflow-x-auto rounded-xl border border-white/[0.06] px-3 py-2 scrollbar-none ${className}`}
      style={{
        background: 'rgba(8, 10, 18, 0.72)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      {/* Engine status beacon */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span
            className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${
              status === 'offline' ? 'bg-rose-500' : 'animate-ping bg-emerald-400'
            }`}
          />
          <span
            className={`relative inline-flex h-2 w-2 rounded-full ${
              status === 'offline'
                ? 'bg-rose-500'
                : status === 'healthy'
                  ? 'bg-emerald-400'
                  : 'bg-amber-400'
            }`}
          />
        </span>
        <span
          data-testid="telemetry-status"
          className="text-[10px] font-mono uppercase tracking-widest text-zinc-400"
        >
          {status}
        </span>
      </div>

      <span className="h-4 w-px bg-white/10 shrink-0" aria-hidden />

      {/* Metric rail */}
      <dl className="flex items-center gap-4 min-w-0">
        {metrics.map((m) => (
          <div key={m.id} className="flex items-baseline gap-1.5 shrink-0" title={m.title}>
            <dt className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">
              {m.label}
            </dt>
            <dd
              data-testid={`metric-${m.id}`}
              className="relative text-[12px] font-mono tabular-nums text-zinc-100 min-w-[3ch]"
            >
              <motion.span
                key={m.value}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
                className="inline-block"
              >
                {m.value}
              </motion.span>
              {m.live ? (
                <Zap
                  className="absolute -right-3 top-1/2 -translate-y-1/2 h-2.5 w-2.5 text-cyan-400/80"
                  aria-hidden
                />
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <div className="ml-auto flex items-center gap-2 shrink-0">
        {error ? (
          <span
            className="text-[10px] font-mono text-rose-300/90 truncate max-w-[14rem]"
            title={error}
          >
            {error}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void load();
          }}
          className="inline-flex items-center justify-center h-6 w-6 rounded-md text-zinc-500 hover:text-cyan-200 hover:bg-white/[0.06] transition-colors"
          aria-label="Refresh fleet telemetry"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {`Engine ${status}. ${metrics.map((m) => `${m.label} ${m.value}`).join(', ')}`}
      </span>
    </section>
  );
}