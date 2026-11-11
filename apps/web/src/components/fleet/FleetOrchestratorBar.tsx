"use client";

import { useCallback, useEffect, useState } from "react";
import { unifiedApi } from "@/lib/api_client";

type FleetStatus = {
  ok: boolean;
  mode: string;
  counts: { pending: number; completed: number; blocked: number };
  next_pending: Array<{ id: string; title: string; priority: number }>;
  active_locks: Array<{ file_path: string; worker_id: string }>;
};

export default function FleetOrchestratorBar() {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await unifiedApi.fleetStatus();
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fleet status unavailable");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await load();
    };
    void tick();
    const id = setInterval(() => void tick(), 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [load]);

  const persistOrder = useCallback(
    async (ordered: Array<{ id: string; title: string; priority: number }>) => {
      if (ordered.length < 2) return;
      setReordering(true);
      try {
        const basePriority = Math.max(...ordered.map((t) => t.priority), 100);
        await unifiedApi.reorderTasks(
          ordered.map((t) => t.id),
          basePriority,
        );
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "reorder failed");
      } finally {
        setReordering(false);
      }
    },
    [load],
  );

  const onDropOn = useCallback(
    (targetId: string) => {
      if (!dragId || dragId === targetId || !status) return;
      const pending = [...status.next_pending];
      const from = pending.findIndex((t) => t.id === dragId);
      const to = pending.findIndex((t) => t.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = pending.splice(from, 1);
      pending.splice(to, 0, moved);
      setStatus({ ...status, next_pending: pending });
      void persistOrder(pending);
      setDragId(null);
    },
    [dragId, persistOrder, status],
  );

  if (error) {
    return (
      <div className="text-[10px] text-amber-500/80 px-1 pb-2 shrink-0">
        Fleet orchestrator: {error}
      </div>
    );
  }

  if (!status) return null;

  const queue = status.next_pending.slice(0, 6);

  return (
    <div className="flex flex-col gap-1 px-1 pb-2 shrink-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
        <span className="text-zinc-400 font-medium">Fleet</span>
        <span>{status.mode.replace("_", " ")}</span>
        <span>pending {status.counts.pending}</span>
        <span>done {status.counts.completed}</span>
        <span>locks {status.active_locks.length}</span>
        {reordering ? <span className="text-cyan-500/80">reordering…</span> : null}
      </div>
      {queue.length > 0 ? (
        <ul className="flex flex-col gap-0.5" aria-label="Pending fleet tasks (drag to reorder)">
          {queue.map((task) => (
            <li
              key={task.id}
              draggable={!reordering}
              onDragStart={() => setDragId(task.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDropOn(task.id)}
              className={`flex items-center gap-2 rounded px-1 py-0.5 text-[10px] cursor-grab active:cursor-grabbing ${
                dragId === task.id ? "bg-cyan-500/10 text-cyan-200" : "text-zinc-600 hover:bg-white/5"
              }`}
              title={task.title}
            >
              <span className="text-zinc-500 tabular-nums">p{task.priority}</span>
              <span className="truncate">{task.id}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
