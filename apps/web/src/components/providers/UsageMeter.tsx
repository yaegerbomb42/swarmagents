'use client';

import React from 'react';

interface UsageMeterProps {
  label: string;
  value: number; // 0-100
}

const COLOR_MAP: Record<string, string> = {
  low: 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.4)]',
  mid: 'bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.4)]',
  high: 'bg-rose-400 shadow-[0_0_12px_rgba(251,113,133,0.4)]',
};

function band(v: number): string {
  if (v < 50) return 'low';
  if (v < 85) return 'mid';
  return 'high';
}

export default function UsageMeter({ label, value }: UsageMeterProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const color = COLOR_MAP[band(clamped)];

  return (
    <div className="space-y-1.5" data-testid="usage-meter">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-white/60">{label}</span>
        <span className="text-[11px] font-mono font-semibold text-white/80">{clamped}%</span>
      </div>
      <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${clamped}%` }}
          data-value={clamped}
        />
      </div>
    </div>
  );
}
