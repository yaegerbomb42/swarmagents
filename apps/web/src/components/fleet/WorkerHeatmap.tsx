'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';

export type WorkerActivity = {
  worker_id: string;
  lock_count: number;
  files: string[];
  intensity: number;
};

function aggregateWorkerActivity(
  locks: Array<{ file_path: string; worker_id: string }>,
): WorkerActivity[] {
  const byWorker = new Map<string, string[]>();
  for (const row of locks) {
    const list = byWorker.get(row.worker_id) ?? [];
    list.push(row.file_path);
    byWorker.set(row.worker_id, list);
  }
  const maxLocks = Math.max(1, ...[...byWorker.values()].map((f) => f.length));
  return [...byWorker.entries()]
    .map(([worker_id, files]) => ({
      worker_id,
      lock_count: files.length,
      files,
      intensity: files.length / maxLocks,
    }))
    .sort((a, b) => b.lock_count - a.lock_count);
}

function heatColor(intensity: number): string {
  if (intensity >= 0.75) return 'rgba(248, 113, 113, 0.85)';
  if (intensity >= 0.5) return 'rgba(251, 191, 36, 0.8)';
  if (intensity >= 0.25) return 'rgba(52, 211, 153, 0.75)';
  return 'rgba(34, 211, 238, 0.55)';
}

export type WorkerHeatmapProps = {
  refreshIntervalMs?: number;
  className?: string;
};

export default function WorkerHeatmap({
  refreshIntervalMs = 8000,
  className = '',
}: WorkerHeatmapProps) {
  const [workers, setWorkers] = useState<WorkerActivity[]>([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const status = await unifiedApi.fleetStatus();
      setWorkers(aggregateWorkerActivity(status.active_locks ?? []));
      setPending(status.counts?.pending ?? 0);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fleet status unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs]);

  const gridCols = useMemo(() => {
    const n = Math.max(workers.length, 1);
    return Math.min(6, Math.ceil(Math.sqrt(n)));
  }, [workers.length]);

  return (
    <section
      data-testid="worker-heatmap"
      className={`rounded-xl border border-white/[0.06] p-3 space-y-3 ${className}`}
      style={{
        background: 'rgba(8, 10, 18, 0.72)',
        backdropFilter: 'blur(12px)',
      }}
      aria-label="Worker activity heatmap"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-300" aria-hidden />
          <div>
            <h3 className="text-xs font-semibold text-white/90">Worker Activity</h3>
            <p className="text-[10px] font-mono text-white/35">
              {workers.length} active · {pending} tasks pending
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="text-[10px] font-mono text-cyan-300/70 hover:text-cyan-200"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-[10px] text-zinc-500">Loading fleet locks…</p>
      ) : error ? (
        <p className="text-[10px] text-rose-300">{error}</p>
      ) : workers.length === 0 ? (
        <p className="text-[10px] text-zinc-500">No active file leases</p>
      ) : (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
        >
          {workers.map((w) => (
            <div
              key={w.worker_id}
              data-testid={`worker-cell-${w.worker_id}`}
              title={w.files.join('\n')}
              className="rounded-lg border border-white/5 p-2 min-h-[3.5rem] flex flex-col justify-between"
              style={{
                background: `linear-gradient(135deg, ${heatColor(w.intensity)} 0%, rgba(8,10,18,0.9) 100%)`,
              }}
            >
              <span className="text-[9px] font-mono text-white/80 truncate">{w.worker_id}</span>
              <span className="text-[10px] font-mono text-white/50 tabular-nums">
                {w.lock_count} lock{w.lock_count === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
