"use client";

import { useState, useEffect } from 'react';
import { Activity, Cpu, HardDrive, Clock, Server, Zap } from 'lucide-react';

interface HealthData {
  status: string;
  active_agents: number;
  total_agents: number;
  tasks_queued: number;
  tasks_running: number;
  tasks_completed: number;
  tasks_failed: number;
  avg_latency_ms: number;
  uptime_human: string;
  llm_local_calls: number;
  llm_cloud_calls: number;
  models_available: string[];
  engine_error?: string;
  orchestrator_lifecycle?: string;
  throughput?: number;
  total_cost?: number;
  total_tokens?: number;
}

export default function SystemHealthPanel() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/engine/health', { cache: 'no-store' });
        const data = await res.json();
        setHealth(data);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6">
        <h2 className="text-sm font-semibold text-red-400 mb-2">Engine Offline</h2>
        <p className="text-xs text-red-300/70">{error}</p>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="rounded-xl border border-white/[0.04] bg-[#06061a] p-6">
        <div className="text-xs text-white/30 font-mono">Loading health data...</div>
      </div>
    );
  }

  const statusColor = health.status === 'healthy'
    ? 'text-emerald-400'
    : health.status === 'idle'
      ? 'text-cyan-400'
      : 'text-amber-400';

  const metrics = [
    { label: 'Status', value: health.status, icon: Activity, color: statusColor },
    { label: 'Agents', value: `${health.active_agents}/${health.total_agents}`, icon: Server, color: 'text-cyan-400' },
    { label: 'Tasks Queued', value: health.tasks_queued, icon: HardDrive, color: 'text-purple-400' },
    { label: 'Tasks Running', value: health.tasks_running, icon: Zap, color: 'text-amber-400' },
    { label: 'Completed', value: health.tasks_completed, icon: Cpu, color: 'text-emerald-400' },
    { label: 'Failed', value: health.tasks_failed, icon: Activity, color: 'text-red-400' },
    { label: 'Avg Latency', value: `${health.avg_latency_ms}ms`, icon: Clock, color: 'text-blue-400' },
    { label: 'Uptime', value: health.uptime_human, icon: Clock, color: 'text-white/60' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white/80">System Health</h2>
        <span className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-full border ${health.status === 'healthy' ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10' : 'border-amber-500/30 text-amber-400 bg-amber-500/10'}`}>
          {health.status}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <m.icon size={12} className={m.color} />
              <span className="text-[10px] uppercase tracking-wider text-white/40">{m.label}</span>
            </div>
            <div className={`text-sm font-semibold ${m.color}`}>{m.value}</div>
          </div>
        ))}
      </div>
      {health.orchestrator_lifecycle && (
        <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-white/40">Orchestrator</div>
            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border border-purple-500/30 text-purple-400 bg-purple-500/10">
              {health.orchestrator_lifecycle}
            </span>
          </div>
          {health.throughput !== undefined && (
            <div className="mt-2 text-xs text-white/50">
              Throughput: <span className="text-cyan-400 font-mono">{health.throughput}</span> tasks/min
            </div>
          )}
        </div>
      )}
      <div className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3">
        <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2">Models Available</div>
        <div className="flex flex-wrap gap-2">
          {(health.models_available || []).map((model) => (
            <span key={model} className="text-[10px] px-2 py-1 rounded-full border border-cyan-500/20 text-cyan-300 bg-cyan-500/10">
              {model}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
