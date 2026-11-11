'use client';

import { useCallback, useEffect, useState } from 'react';

export default function OrchestrationDetail() {
  const [optimization, setOptimization] = useState<Record<string, unknown> | null>(null);
  const [agents, setAgents] = useState<unknown[]>([]);
  const [tasks, setTasks] = useState<unknown[]>([]);
  const [telemetry, setTelemetry] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [optRes, agentsRes, tasksRes, telRes] = await Promise.all([
        fetch('/api/engine/orchestration/optimization', { cache: 'no-store' }),
        fetch('/api/agents', { cache: 'no-store' }),
        fetch('/api/engine/tasks', { cache: 'no-store' }),
        fetch('/api/telemetry', { cache: 'no-store' }),
      ]);

      if (optRes.ok) setOptimization(await optRes.json());
      if (agentsRes.ok) {
        const a = await agentsRes.json();
        setAgents(a.agents || a || []);
      }
      if (tasksRes.ok) {
        const t = await tasksRes.json();
        setTasks(t.tasks || t || []);
      }
      if (telRes.ok) setTelemetry(await telRes.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 8_000);
    return () => clearInterval(id);
  }, [load]);

  const agentList = Array.isArray(agents) ? agents : [];
  const taskList = Array.isArray(tasks) ? tasks : [];

  return (
    <div className="h-full flex flex-col bg-black/20 rounded-xl border border-white/[0.06] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">🎯</span>
          <span className="text-sm font-medium text-white/80">Orchestration</span>
        </div>
        <button
          type="button"
          onClick={load}
          className="text-[10px] uppercase text-white/40 hover:text-white/70"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading && <p className="text-xs text-white/40">Loading engine orchestration…</p>}
        {error && <p className="text-xs text-rose-300 font-mono">{error}</p>}

        <section>
          <div className="text-[10px] uppercase text-white/40 mb-2">Optimization module</div>
          <pre className="text-[11px] font-mono text-white/70 p-3 rounded-lg bg-black/40 border border-white/[0.06] whitespace-pre-wrap">
            {optimization ? JSON.stringify(optimization, null, 2) : '—'}
          </pre>
        </section>

        <section className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="text-[10px] uppercase text-white/40">Agents</div>
            <div className="text-xl font-mono text-cyan-300">{agentList.length}</div>
          </div>
          <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="text-[10px] uppercase text-white/40">Tasks</div>
            <div className="text-xl font-mono text-teal-300">{taskList.length}</div>
          </div>
        </section>

        <section>
          <div className="text-[10px] uppercase text-white/40 mb-2">Recent tasks</div>
          <div className="space-y-1.5 max-h-40 overflow-auto">
            {taskList.slice(0, 12).map((t, i) => {
              const o = (t && typeof t === 'object' ? t : { title: String(t) }) as Record<
                string,
                unknown
              >;
              return (
                <div
                  key={String(o.id || i)}
                  className="flex justify-between gap-2 text-xs font-mono p-2 rounded bg-black/30 border border-white/[0.04]"
                >
                  <span className="text-white/70 truncate">
                    {String(o.title || o.description || o.id || 'task')}
                  </span>
                  <span className="text-white/30 shrink-0">{String(o.status || '—')}</span>
                </div>
              );
            })}
            {!taskList.length && <p className="text-xs text-white/40">No tasks from engine</p>}
          </div>
        </section>

        {telemetry && (
          <section>
            <div className="text-[10px] uppercase text-white/40 mb-2">Telemetry</div>
            <pre className="text-[11px] font-mono text-white/60 p-3 rounded-lg bg-black/40 border border-white/[0.06] whitespace-pre-wrap max-h-36 overflow-auto">
              {JSON.stringify(telemetry, null, 2)}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
