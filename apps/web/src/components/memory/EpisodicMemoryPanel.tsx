'use client';

import { useEffect, useState } from 'react';
import { BookOpen, RefreshCw, Target } from 'lucide-react';
import { fetchEpisodicMemory, type EpisodicEntry } from '@/lib/memoryApi';

export default function EpisodicMemoryPanel() {
  const [entries, setEntries] = useState<EpisodicEntry[]>([]);
  const [activeGoal, setActiveGoal] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchEpisodicMemory()
      .then((data) => {
        setEntries(data.entries ?? []);
        setActiveGoal(data.active_goal ?? null);
      })
      .catch((e: Error) => {
        if (e.message.includes('502') || e.message.includes('503') || e.message.includes('504')) {
          setError('Memory engine is temporarily unavailable (backend offline). Lessons will reappear once the engine reconnects.');
        } else {
          setError(e.message);
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <section
      className="rounded-xl border border-white/[0.06] overflow-hidden"
      style={{ background: 'rgba(8,8,18,0.72)', backdropFilter: 'blur(12px)' }}
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
        <BookOpen className="w-4 h-4 text-violet-400" />
        <h2 className="text-sm font-medium text-zinc-100">Episodic Memory</h2>
        <button
          type="button"
          onClick={load}
          className="ml-auto p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/5"
          aria-label="Refresh episodic memory"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {activeGoal && (
        <div className="px-4 py-2 border-b border-white/[0.04] bg-cyan-500/5 text-[11px] text-cyan-200/80 flex items-center gap-2">
          <Target className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate font-mono">
            {(activeGoal.goal_id as string) || (activeGoal.info as string) || 'active trajectory'}
          </span>
        </div>
      )}

      <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
        {loading && <p className="text-xs text-zinc-500">Loading lessons…</p>}
        <p className="text-xs text-rose-400/80">{error}</p>
        {!loading && !error && entries.length === 0 && (
          <p className="text-xs text-zinc-500">No episodic lessons recorded yet.</p>
        )}
        {entries.map((entry, i) => (
          <article
            key={entry.lesson_id ?? `ep-${i}`}
            className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2"
          >
            <p className="text-[12px] text-zinc-200 leading-relaxed">{entry.lesson_text}</p>
            <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-zinc-500 font-mono">
              {entry.lesson_type && <span>{entry.lesson_type}</span>}
              {entry.related_file && <span>{entry.related_file}</span>}
              {entry.occurrences != null && <span>×{entry.occurrences}</span>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
