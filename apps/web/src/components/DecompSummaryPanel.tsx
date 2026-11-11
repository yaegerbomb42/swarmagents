'use client';

import type { DecompTreeSummary } from '@/stores/swarmStore';
import { formatMinutes } from '@/lib/timeBudget';
import { GitBranch, Layers, Timer, Waypoints, DollarSign, Wrench } from 'lucide-react';

interface DecompSummaryPanelProps {
  summary: DecompTreeSummary | null | undefined;
  className?: string;
}

export default function DecompSummaryPanel({ summary, className = '' }: DecompSummaryPanelProps) {
  if (!summary) return null;

  const metrics = [
    { label: 'Leaves', value: summary.leafCount, icon: GitBranch },
    { label: 'Areas', value: summary.areaCount, icon: Layers },
    { label: 'Critical path', value: formatMinutes(summary.criticalPathMinutes), icon: Timer },
    { label: 'Parallel', value: `×${summary.parallelWidth}`, icon: Waypoints },
    { label: 'Est. cost', value: `$${summary.costEstimateUsd.toFixed(2)}`, icon: DollarSign },
  ];

  const classes = Object.entries(summary.byAgentClass).sort((a, b) => b[1] - a[1]);
  const tools = Object.entries(summary.byTool).sort((a, b) => b[1] - a[1]);

  return (
    <div className={`rounded-lg border border-[#27272a] bg-[#141416] p-3 space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">
          Summary
        </span>
        <span className="text-[9px] text-zinc-600">
          {summary.withAcceptance}/{summary.leafCount} w/ criteria · {summary.withDeps} deps
        </span>
      </div>

      <div className="grid grid-cols-5 gap-1.5">
        {metrics.map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="rounded border border-[#27272a] bg-[#1a1a1d] px-1.5 py-1.5 text-center"
          >
            <Icon className="w-3 h-3 mx-auto text-zinc-500 mb-0.5" />
            <div className="text-[11px] text-zinc-100 font-medium">{value}</div>
            <div className="text-[8px] uppercase tracking-wider text-zinc-600">{label}</div>
          </div>
        ))}
      </div>

      {(classes.length > 0 || tools.length > 0) && (
        <div className="flex flex-wrap gap-3 text-[9px] font-mono">
          {classes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-white/25 mr-0.5">roles</span>
              {classes.map(([cls, n]) => (
                <span
                  key={cls}
                  className="px-1.5 py-0.5 rounded border border-[#27272a] text-zinc-400 bg-[#1a1a1d]"
                >
                  {cls} {n}
                </span>
              ))}
            </div>
          )}
          {tools.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <Wrench className="w-2.5 h-2.5 text-white/25" />
              {tools.map(([tool, n]) => (
                <span
                  key={tool}
                  className="px-1.5 py-0.5 rounded border border-white/10 text-white/45 bg-white/[0.02]"
                >
                  {tool} {n}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
