'use client';

import { useEffect, useState } from 'react';
import { engineApiUrl } from '@/lib/auth';

type Meter = {
  verified_solutions: number;
  discarded_failures: number;
  intelligence: number;
  blackboard?: string;
  lambo_pool?: { in_flight?: number; max_seats?: number; model?: string } | null;
};

export default function HivemindIntelligenceMeter() {
  const [meter, setMeter] = useState<Meter | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(engineApiUrl('/api/hivemind/meter'), { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as Meter;
        if (!cancelled) setMeter(data);
      } catch {
        /* engine offline */
      }
    };
    void load();
    const id = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const intel = meter?.intelligence ?? 0;
  const verified = meter?.verified_solutions ?? 0;
  const discarded = meter?.discarded_failures ?? 0;
  const seats = meter?.lambo_pool;

  return (
    <div className="rounded-xl border border-[#d8dee8] bg-[#f7f9fc] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-[#5b6b7c]">
          Hivemind intelligence
        </span>
        <span className="text-[11px] font-mono text-[#0f172a]">{intel.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-[#e8edf3] overflow-hidden">
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
          style={{ width: `${Math.min(100, intel)}%` }}
        />
      </div>
      <p className="mt-1.5 text-[10px] text-[#8b98a8]">
        {verified} verified local proofs · {discarded} failed runs discarded
        {seats?.max_seats != null && (
          <>
            {' '}
            · LAMBO {seats.in_flight ?? 0}/{seats.max_seats} seats
          </>
        )}
      </p>
    </div>
  );
}
