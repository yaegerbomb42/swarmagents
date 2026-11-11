'use client';

import { Loader2 } from 'lucide-react';

export interface DecompProgress {
  phase: 'initial' | 'deepening' | 'done' | 'error';
  round?: number;
  deepenCalls?: number;
  leafCount?: number;
  targetLeaves?: number;
  message?: string;
}

interface DecompProgressBannerProps {
  progress: DecompProgress | null;
  className?: string;
}

export default function DecompProgressBanner({
  progress,
  className = '',
}: DecompProgressBannerProps) {
  if (!progress || progress.phase === 'done') return null;

  const target = progress.targetLeaves || 1;
  const leaves = progress.leafCount || 0;
  const pct = Math.min(99, Math.round((leaves / target) * 100));

  return (
    <div
      className={`rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 space-y-1.5 ${className}`}
    >
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-zinc-300 flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin text-zinc-400" />
          {progress.message || 'Decomposing…'}
        </span>
        <span className="text-zinc-600 font-mono text-[10px]">
          {leaves}/{target} · r{progress.round ?? 0}
        </span>
      </div>
      <div className="h-1 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-zinc-200 transition-all duration-500"
          style={{ width: `${Math.max(4, pct)}%` }}
        />
      </div>
    </div>
  );
}
