'use client';

import { useEffect, useState } from 'react';

// ════════════════════════════════════════════════════════════
//  useSwarmTelemetry — polls live engine state (real endpoints)
//
//  Sources of truth (verified):
//  - /api/swarm/status  -> JSON OBJECT { status, agentCount,
//    activeTasks, queuedTasks, completedTasks, collectiveHealth,
//    lifecycle, throughput, ... }  (NOT a worker array)
//  - /api/engine/health -> { status, active_agents, total_agents,
//    tasks_queued/running/completed/failed, total_tokens,
//    avg_latency_ms, ... } (proxy to :8400 with in-process fallback)
//  NOTE: /api/telemetry is SSE-only (text/event-stream) — never
//  fetch().json() it. Journal/phase come from swarm status +
//  engine health instead.
// ════════════════════════════════════════════════════════════

export interface LiveWorker {
  id: string;
  provider: string;
  model: string;
  status: 'ready' | 'busy' | 'cooldown' | 'error';
  avg_tps: number;
  total_tokens: number;
}

export interface FleetCounts {
  agents: number;
  activeTasks: number;
  queuedTasks: number;
  completedTasks: number;
  totalTokens: number | null;
  avgLatencyMs: number | null;
  throughput: number | null;
  health: number | null;
}

export interface LiveTelemetry {
  workers: LiveWorker[];
  journal: string[];
  phase: 'idle' | 'reasoning' | 'executing' | 'reviewing' | 'planning' | 'sleep';
  engineReachable: boolean;
  lastUpdate: number;
  counts: FleetCounts;
}

const EMPTY_COUNTS: FleetCounts = {
  agents: 0,
  activeTasks: 0,
  queuedTasks: 0,
  completedTasks: 0,
  totalTokens: null,
  avgLatencyMs: null,
  throughput: null,
  health: null,
};

const DEFAULT: LiveTelemetry = {
  workers: [],
  journal: [],
  phase: 'idle',
  engineReachable: false,
  lastUpdate: 0,
  counts: EMPTY_COUNTS,
};

function phaseFromLifecycle(lifecycle: unknown, activeTasks: number): LiveTelemetry['phase'] {
  if (typeof lifecycle === 'string') {
    const c = lifecycle.toLowerCase();
    if (c.includes('degrad')) return 'reviewing';
    if (c.includes('active') || c.includes('run')) return activeTasks > 0 ? 'executing' : 'reasoning';
    if (c.includes('idle')) return 'idle';
    if (c.includes('sleep')) return 'sleep';
  }
  return activeTasks > 0 ? 'executing' : 'idle';
}

export function useSwarmTelemetry(pollMs: number = 5000): LiveTelemetry {
  const [state, setState] = useState<LiveTelemetry>(DEFAULT);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const [swarmRes, healthRes] = await Promise.allSettled([
          fetch('/api/swarm/status', { cache: 'no-store' }),
          fetch('/api/engine/health', { cache: 'no-store' }),
        ]);

        let counts: FleetCounts = { ...EMPTY_COUNTS };
        let engineReachable = false;
        let phase: LiveTelemetry['phase'] = 'idle';
        const journal: string[] = [];

        if (swarmRes.status === 'fulfilled' && swarmRes.value.ok) {
          const data = await swarmRes.value.json().catch(() => null);
          if (data && typeof data === 'object') {
            engineReachable = !data.error;
            const active = Number(data.activeTasks ?? 0) || 0;
            counts = {
              ...counts,
              agents: Number(data.agentCount ?? 0) || 0,
              activeTasks: active,
              queuedTasks: Number(data.queuedTasks ?? 0) || 0,
              completedTasks: Number(data.completedTasks ?? 0) || 0,
              health: typeof data.collectiveHealth === 'number' ? data.collectiveHealth : null,
              throughput: typeof data.throughput === 'number' ? data.throughput : null,
            };
            phase = phaseFromLifecycle(data.lifecycle ?? data.status, active);
            journal.push(
              `swarm ${String(data.status ?? 'unknown')} · ${counts.agents} agents · ${active} active / ${counts.queuedTasks} queued`,
            );
          }
        }

        if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
          const data = await healthRes.value.json().catch(() => null);
          if (data && typeof data === 'object' && !data.engine_error) {
            engineReachable = true;
            counts = {
              ...counts,
              agents: Number(data.active_agents ?? data.total_agents ?? counts.agents) || counts.agents,
              queuedTasks: Number(data.tasks_queued ?? counts.queuedTasks) || counts.queuedTasks,
              activeTasks: Number(data.tasks_running ?? counts.activeTasks) || counts.activeTasks,
              completedTasks: Number(data.tasks_completed ?? counts.completedTasks) || counts.completedTasks,
              totalTokens: typeof data.total_tokens === 'number' ? data.total_tokens : counts.totalTokens,
              avgLatencyMs: typeof data.avg_latency_ms === 'number' ? data.avg_latency_ms : counts.avgLatencyMs,
            };
            if (phase === 'idle' && counts.activeTasks > 0) phase = 'executing';
            journal.push(
              `engine ${String(data.status ?? 'ok')} · ${counts.completedTasks} done · ${counts.totalTokens ?? '—'} tokens`,
            );
          }
        }

        if (!cancelled) {
          setState({
            workers: [],
            journal: journal.slice(0, 8),
            phase,
            engineReachable,
            lastUpdate: Date.now(),
            counts,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setState(prev => ({ ...prev, engineReachable: false }));
        }
      }
    };

    poll();
    const iv = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [pollMs]);

  return state;
}
