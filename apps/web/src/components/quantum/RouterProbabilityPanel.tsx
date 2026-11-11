'use client';

import { useCallback, useEffect, useState } from 'react';
import { Brain, RefreshCw } from 'lucide-react';

type BranchProbabilities = {
  actions: Record<string, number>;
  thinking_styles: Record<string, number>;
};

type RouterMetricsResponse = {
  total_decisions?: number;
  current_accuracy?: number;
  branch_probabilities?: BranchProbabilities;
};

function ProbabilityBar({
  label,
  probability,
  color,
}: {
  label: string;
  probability: number;
  color: string;
}) {
  const pct = Math.round(probability * 1000) / 10;
  return (
    <div className="space-y-1" data-testid={`branch-${label}`}>
      <div className="flex justify-between text-[9px] font-mono text-white/40">
        <span className="truncate pr-2">{label}</span>
        <span className="text-cyan-300/80 shrink-0">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${color}`}
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
        />
      </div>
    </div>
  );
}

function BranchSection({
  title,
  branches,
  colors,
}: {
  title: string;
  branches: Record<string, number>;
  colors: string[];
}) {
  const entries = Object.entries(branches).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    return (
      <div className="text-[10px] font-mono text-white/25 py-2">
        No {title.toLowerCase()} samples yet
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-[9px] font-mono uppercase text-white/30">{title}</div>
      {entries.map(([name, prob], i) => (
        <ProbabilityBar
          key={name}
          label={name}
          probability={prob}
          color={colors[i % colors.length]}
        />
      ))}
    </div>
  );
}

const ACTION_COLORS = ['bg-purple-400', 'bg-cyan-400', 'bg-amber-400', 'bg-emerald-400'];
const STYLE_COLORS = ['bg-fuchsia-400', 'bg-sky-400', 'bg-rose-400', 'bg-lime-400'];

export interface RouterProbabilityPanelProps {
  treeId?: string;
  refreshIntervalMs?: number;
  className?: string;
}

export default function RouterProbabilityPanel({
  treeId,
  refreshIntervalMs = 2000,
  className = '',
}: RouterProbabilityPanelProps) {
  const [metrics, setMetrics] = useState<RouterMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const qs = treeId ? `?tree_id=${encodeURIComponent(treeId)}` : '';
      const res = await fetch(`/api/quantum/router/metrics${qs}`, { cache: 'no-store' });
      if (res.ok) {
        setMetrics((await res.json()) as RouterMetricsResponse);
      }
    } finally {
      setLoading(false);
    }
  }, [treeId]);

  useEffect(() => {
    load();
    const id = setInterval(load, refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs]);

  const branches = metrics?.branch_probabilities ?? { actions: {}, thinking_styles: {} };

  return (
    <div
      className={`rounded-xl border border-white/[0.06] p-4 space-y-4 ${className}`}
      style={{
        background: 'rgba(8, 10, 18, 0.72)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
      data-testid="router-probability-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-purple-300 uppercase tracking-wide flex items-center gap-2">
            <Brain className="w-4 h-4" /> Branch Probabilities
          </h2>
          <p className="text-[10px] font-mono text-white/35 mt-1">
            Live quantum router action + thinking-style distribution
            {metrics?.total_decisions != null && (
              <span className="text-cyan-300/70"> · {metrics.total_decisions} decisions</span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="tactile-ghost p-2 text-purple-300/70"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BranchSection title="Action branches" branches={branches.actions} colors={ACTION_COLORS} />
        <BranchSection
          title="Thinking-style branches"
          branches={branches.thinking_styles}
          colors={STYLE_COLORS}
        />
      </div>
    </div>
  );
}
