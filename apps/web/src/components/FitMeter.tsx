'use client';

import type { FitMeter as FitMeterData, FitStatus } from '@/lib/timeBudget';
import { formatMinutes } from '@/lib/timeBudget';

const STATUS_STYLE: Record<
  FitStatus,
  { bar: string; text: string; border: string; bg: string; label: string }
> = {
  fit: {
    bar: 'bg-emerald-400',
    text: 'text-emerald-400/90',
    border: 'border-emerald-500/20',
    bg: 'bg-emerald-500/10',
    label: 'FIT',
  },
  under: {
    bar: 'bg-amber-400',
    text: 'text-amber-400/90',
    border: 'border-amber-500/20',
    bg: 'bg-amber-500/10',
    label: 'UNDER',
  },
  over: {
    bar: 'bg-rose-400',
    text: 'text-rose-400/90',
    border: 'border-rose-500/20',
    bg: 'bg-rose-500/10',
    label: 'OVER',
  },
  unknown: {
    bar: 'bg-zinc-500',
    text: 'text-zinc-400',
    border: 'border-[#232326]',
    bg: 'bg-white/[0.03]',
    label: '—',
  },
};

interface FitMeterProps {
  fit: FitMeterData | null | undefined;
  compact?: boolean;
  className?: string;
}

export default function FitMeter({ fit, compact = false, className = '' }: FitMeterProps) {
  if (!fit) return null;
  const style = STATUS_STYLE[fit.status] || STATUS_STYLE.unknown;
  const fillPct = Math.min(100, Math.max(4, fit.ratio * 100));

  if (compact) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <span className={`text-[9px] font-mono uppercase tracking-wider ${style.text}`}>
          {style.label}
        </span>
        <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden min-w-[48px]">
          <div
            className={`h-full rounded-full transition-all duration-700 ${style.bar}`}
            style={{ width: `${fillPct}%` }}
          />
        </div>
        <span className="text-[9px] font-mono text-zinc-500">
          {fit.leafCount}/{fit.targetLeaves}
        </span>
      </div>
    );
  }

  return (
    <div className={`rounded-md border ${style.border} ${style.bg} px-3 py-2.5 space-y-2 ${className}`}>
      <div className="flex items-center justify-between">
        <span className={`text-[11px] font-semibold tracking-wide ${style.text}`}>
          Budget fit · {style.label}
        </span>
        <span className="text-[10px] font-mono text-zinc-500">
          {fit.leafCount} leaves · target {fit.targetLeaves}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden relative">
        <div className="absolute inset-y-0 left-[70%] w-px bg-white/15" />
        <div
          className={`h-full rounded-full transition-all duration-700 ${style.bar}`}
          style={{ width: `${fillPct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
        <span>
          {formatMinutes(fit.estimatedMinutes)} serial / {fit.label} wall
        </span>
        <span>{Math.round(fit.ratio * 100)}% of target load</span>
      </div>
      <p className={`text-[12px] leading-snug ${style.text}`}>{fit.message}</p>
    </div>
  );
}
