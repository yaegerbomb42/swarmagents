'use client';

import { useCallback, useEffect, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';

export type FleetTask = {
  id: string;
  title: string;
  priority: number;
};

export type FleetTaskTreeProps = {
  className?: string;
  refreshIntervalMs?: number;
};

export default function FleetTaskTree({
  className = '',
  refreshIntervalMs = 12000,
}: FleetTaskTreeProps) {
  const [tasks, setTasks] = useState<FleetTask[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const status = await unifiedApi.fleetStatus();
      const pending = (status.next_pending ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
      }));
      setTasks(pending);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fleet tasks unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs]);

  const persistOrder = useCallback(async (ordered: FleetTask[]) => {
    if (!ordered.length) return;
    setSaving(true);
    setError(null);
    try {
      await unifiedApi.reorderTasks(
        ordered.map((t) => t.id),
        100,
      );
      setTasks(ordered);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reorder failed');
      await load();
    } finally {
      setSaving(false);
    }
  }, [load]);

  const onDrop = useCallback(
    (targetId: string) => {
      if (!dragId || dragId === targetId) return;
      const from = tasks.findIndex((t) => t.id === dragId);
      const to = tasks.findIndex((t) => t.id === targetId);
      if (from < 0 || to < 0) return;
      const next = [...tasks];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setDragId(null);
      void persistOrder(next);
    },
    [dragId, persistOrder, tasks],
  );

  return (
    <section
      data-testid="fleet-task-tree"
      className={`rounded-lg border border-white/10 bg-black/30 overflow-hidden ${className}`}
    >
      <header className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <h3 className="text-[11px] font-medium text-zinc-200">Task Queue</h3>
        <span className="text-[10px] font-mono text-zinc-500">
          {saving ? 'saving…' : `${tasks.length} pending`}
        </span>
      </header>
      <ul className="divide-y divide-white/5 max-h-48 overflow-y-auto">
        {error ? (
          <li className="px-3 py-2 text-[10px] text-rose-300">{error}</li>
        ) : tasks.length === 0 ? (
          <li className="px-3 py-2 text-[10px] text-zinc-500">No pending orchestrator tasks.</li>
        ) : (
          tasks.map((task) => (
            <li
              key={task.id}
              draggable
              onDragStart={() => setDragId(task.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(task.id)}
              className="flex items-center gap-2 px-3 py-2 text-[10px] text-zinc-300 hover:bg-white/[0.03] cursor-grab active:cursor-grabbing"
            >
              <GripVertical className="h-3 w-3 text-zinc-600 shrink-0" aria-hidden />
              <span className="font-mono text-zinc-500 w-8 shrink-0">p{task.priority}</span>
              <span className="truncate">{task.title}</span>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
