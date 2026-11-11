'use client';

import { useCallback, useEffect, useState } from 'react';

type MemoryTier = 'episodic' | 'semantic' | 'working';

type MemoryRow = {
  text: string;
  tier: MemoryTier;
  meta?: string;
};

function normalizeEntries(tier: MemoryTier, data: Record<string, unknown>): MemoryRow[] {
  if (tier === 'episodic') {
    const entries = (data.entries as unknown[]) || [];
    return entries.map((e) => {
      if (typeof e === 'string') return { text: e, tier };
      if (e && typeof e === 'object') {
        const o = e as Record<string, unknown>;
        return {
          text: String(o.content || o.text || o.summary || JSON.stringify(o)),
          tier,
          meta: o.timestamp ? String(o.timestamp) : undefined,
        };
      }
      return { text: String(e), tier };
    });
  }
  if (tier === 'semantic') {
    const results = (data.results as unknown[]) || (data.entries as unknown[]) || [];
    return results.map((e) => {
      if (typeof e === 'string') return { text: e, tier };
      if (e && typeof e === 'object') {
        const o = e as Record<string, unknown>;
        return {
          text: String(o.content || o.text || o.fact || JSON.stringify(o)),
          tier,
          meta: o.score != null ? `score ${o.score}` : undefined,
        };
      }
      return { text: String(e), tier };
    });
  }
  const ctx = data.context;
  if (ctx && typeof ctx === 'object') {
    return Object.entries(ctx as Record<string, unknown>).map(([k, v]) => ({
      text: `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
      tier,
    }));
  }
  if (data.note) return [{ text: String(data.note), tier, meta: 'note' }];
  return [];
}

export default function MemoryDetail() {
  const [tier, setTier] = useState<MemoryTier>('episodic');
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async (t: MemoryTier) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/memory?tier=${t}`, { cache: 'no-store' });
      const data = await res.json();
      setRows(normalizeEntries(t, data));
      if (data.note && !(data.entries?.length || data.results?.length || data.context)) {
        setError(String(data.note));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(tier);
    const id = setInterval(() => load(tier), 10_000);
    return () => clearInterval(id);
  }, [tier, load]);

  const filtered = rows.filter(
    (r) => !query || r.text.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="h-full flex flex-col bg-black/20 rounded-xl border border-white/[0.06] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm">💾</span>
          <span className="text-sm font-medium text-white/80">Memory</span>
        </div>
        <div className="flex gap-1">
          {(['episodic', 'semantic', 'working'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTier(t)}
              className={`text-[10px] uppercase px-2 py-1 rounded ${
                tier === t
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 py-2 border-b border-white/[0.04]">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter entries…"
          className="w-full text-xs bg-black/40 border border-white/[0.08] rounded-lg px-3 py-1.5 text-white placeholder-white/30 outline-none"
        />
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2">
        {loading && <p className="text-xs text-white/40">Loading engine memory…</p>}
        {error && !filtered.length && (
          <p className="text-xs text-amber-300/80 font-mono">{error}</p>
        )}
        {!loading &&
          filtered.map((r, i) => (
            <div
              key={`${r.tier}-${i}`}
              className="flex justify-between gap-2 p-2 rounded bg-white/[0.02] border border-white/[0.04] text-xs font-mono"
            >
              <div className="flex items-start gap-2 min-w-0">
                <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shrink-0">
                  {r.tier}
                </span>
                <span className="text-white/70 break-words">{r.text}</span>
              </div>
              {r.meta && <span className="text-[10px] text-white/30 shrink-0">{r.meta}</span>}
            </div>
          ))}
        {!loading && !filtered.length && !error && (
          <p className="text-xs text-white/40 text-center py-8">No {tier} entries from engine</p>
        )}
      </div>
    </div>
  );
}
