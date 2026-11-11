'use client';

import { useEffect, useMemo, useState } from 'react';

const BASE_ITEMS = [
  'NEURAL ROUTER ONLINE',
  'BLACKBOARD SYNC',
  'HIERARCHY DEPTH 7',
  'CONSENSUS LAYER ACTIVE',
  'FLEET MODE: PARALLEL',
  'HAMILTONIAN PLANNER',
  'AGENT SPAWNER READY',
  'CONTEXT WINDOW SHARED',
  'MODAL INFERENCE POOL',
  'TRAJECTORY TIMELINE',
];

function randomHex(len = 4) {
  return Math.floor(Math.random() * 16 ** len)
    .toString(16)
    .padStart(len, '0')
    .toUpperCase();
}

export interface SystemDataTickerProps {
  className?: string;
}

export default function SystemDataTicker({ className = '' }: SystemDataTickerProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 3200);
    return () => window.clearInterval(id);
  }, []);

  const items = useMemo(() => {
    const live = BASE_ITEMS.map((label, i) => {
      const suffix =
        i % 3 === 0
          ? `0x${randomHex(4)}`
          : i % 3 === 1
            ? `${(Math.random() * 99 + 1).toFixed(1)}ms`
            : `${Math.floor(Math.random() * 900 + 100)} tok/s`;
      return `${label} · ${suffix}`;
    });
    return [...live, ...live];
  }, [tick]);

  return (
    <div
      className={`relative overflow-hidden border-y border-cyan-500/10 bg-black/40 backdrop-blur-md ${className}`}
      aria-hidden
    >
      <div className="absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-[#09090b] to-transparent z-10" />
      <div className="absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[#09090b] to-transparent z-10" />
      <div className="flex animate-ticker-scroll whitespace-nowrap py-2">
        {items.map((item, i) => (
          <span
            key={`${tick}-${i}`}
            className="inline-flex items-center gap-2 px-6 text-[10px] font-mono tracking-[0.18em] uppercase text-cyan-400/50"
          >
            <span className="h-1 w-1 rounded-full bg-cyan-400/60 shadow-[0_0_6px_rgba(0,245,255,0.8)]" />
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
