'use client';

/**
 * HoloStatusBar — hyper-modern live fleet pulse strip.
 * Animated aurora gradient shell, real-time UTC clock, and live fleet
 * telemetry from the canonical /api/v1/fleet/status snapshot.
 */

import { useCallback, useEffect, useState } from 'react';
import { Activity, Lock, Radar, Sparkles } from 'lucide-react';
import { unifiedApi } from '@/lib/api_client';

type FleetStatus = {
  ok: boolean;
  mode: string;
  counts: { pending: number; completed: number; blocked: number };
  active_locks: Array<{ file_path: string; worker_id: string }>;
};

export type HoloStatusBarProps = {
  refreshIntervalMs?: number;
  className?: string;
};

function formatUtc(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:` +
    `${pad(now.getUTCSeconds())} UTC`
  );
}

export default function HoloStatusBar({
  refreshIntervalMs = 10000,
  className = '',
}: HoloStatusBarProps) {
  const [clock, setClock] = useState<string>('--:--:-- UTC');
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setClock(formatUtc(new Date()));
    const id = setInterval(() => setClock(formatUtc(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  const poll = useCallback(async () => {
    try {
      const snap = await unifiedApi.fleetStatus();
      setStatus(snap);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), refreshIntervalMs);
    return () => clearInterval(id);
  }, [poll, refreshIntervalMs]);

  const pending = status?.counts.pending ?? 0;
  const completed = status?.counts.completed ?? 0;
  const blocked = status?.counts.blocked ?? 0;
  const locks = status?.active_locks.length ?? 0;

  const stats: Array<{ icon: typeof Activity; label: string; value: number | string; tone: string }> = [
    { icon: Radar, label: 'pending', value: pending, tone: 'text-cyan-300' },
    { icon: Sparkles, label: 'shipped', value: completed, tone: 'text-emerald-300' },
    { icon: Activity, label: 'blocked', value: blocked, tone: 'text-amber-300' },
    { icon: Lock, label: 'locks', value: locks, tone: 'text-fuchsia-300' },
  ];

  return (
    <section
      data-testid="holo-status-bar"
      aria-label="Live fleet pulse"
      className={`holo-aurora relative overflow-hidden rounded-xl border border-white/10 px-3 py-2 flex items-center gap-3 ${className}`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${
          offline ? 'bg-rose-400' : 'bg-emerald-400 animate-pulse'
        } shadow-[0_0_8px_2px_rgba(52,211,153,0.6)]`}
      />
      <span className="shrink-0 font-mono text-[11px] tracking-widest text-white/90 tabular-nums">
        {clock}
      </span>
      <span className="h-4 w-px shrink-0 bg-white/10" aria-hidden />
      <div className="flex flex-1 items-center gap-3 overflow-hidden">
        {stats.map(({ icon: Icon, label, value, tone }) => (
          <span
            key={label}
            data-testid={`holo-stat-${label}`}
            className="flex items-center gap-1 text-[10px] font-mono whitespace-nowrap"
          >
            <Icon className={`h-3 w-3 ${tone}`} aria-hidden />
            <span className={tone}>{value}</span>
            <span className="text-zinc-500">{label}</span>
          </span>
        ))}
      </div>
      <span className="shrink-0 text-[9px] font-mono uppercase tracking-[0.2em] text-zinc-500">
        {offline ? 'fleet offline' : `mode: ${status?.mode ?? 'syncing'}`}
      </span>
    </section>
  );
}
