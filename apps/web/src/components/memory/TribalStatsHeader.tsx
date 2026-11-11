'use client';

import { Activity, Brain, Database, RefreshCw } from 'lucide-react';
import type { TribalStats } from '@/lib/tribal';

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-cyan-400/10 bg-white/[0.02] px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-cyan-100/40">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-cyan-100">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-cyan-100/35">{hint}</div>}
    </div>
  );
}

export default function TribalStatsHeader({ stats }: { stats: TribalStats | null }) {
  if (!stats) return null;

  const cadence =
    stats.flush_every != null
      ? stats.tasks_since_flush != null
        ? `every ${stats.flush_every} tasks · ${stats.tasks_since_flush} since last`
        : `every ${stats.flush_every} tasks`
      : 'unknown';

  const lastFlush = stats.last_flush_at
    ? new Date(stats.last_flush_at).toLocaleString()
    : stats.available
      ? 'pending first flush'
      : 'n/a';

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat icon={Brain} label="Total Rules" value={String(stats.total_rules)} hint={`${stats.learned_rules} learned · ${stats.static_rules} static`} />
      <Stat icon={Activity} label="Learned" value={String(stats.learned_rules)} hint="from task executions" />
      <Stat icon={RefreshCw} label="Flush Cadence" value={stats.flush_every != null ? `${stats.flush_every}` : '—'} hint={cadence} />
      <Stat icon={Database} label="Last Flush" value={stats.available ? (stats.last_flush_at ? '✓' : '—') : 'off'} hint={lastFlush} />
    </div>
  );
}
