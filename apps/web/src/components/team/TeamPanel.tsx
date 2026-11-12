'use client';

import { useState } from 'react';
import {
  Check,
  Circle,
  GitMerge,
  Loader2,
  RotateCcw,
  Users,
  XCircle,
} from 'lucide-react';
import { formatRoleLabel } from '@/lib/agentRoles';
import type { TeamPlanItem, TeamRun, TeamRunStatus } from '@/lib/team/types';
import { TeamLane, formatCost } from './TeamLane';

const RUN_STATUS: Record<TeamRunStatus, { label: string; className: string }> = {
  planning: { label: 'Planning', className: 'text-st-thinking border-st-thinking/40 bg-st-thinking/10' },
  running: { label: 'Running', className: 'text-st-running border-st-running/40 bg-st-running/10' },
  reviewing: { label: 'Reviewing', className: 'text-st-thinking border-st-thinking/40 bg-st-thinking/10' },
  completed: { label: 'Merged', className: 'text-st-done border-st-done/40 bg-st-done/10' },
  failed: { label: 'Failed', className: 'text-st-failed border-st-failed/40 bg-st-failed/10' },
  cancelled: { label: 'Cancelled', className: 'text-st-paused border-st-paused/40 bg-st-paused/10' },
};

function PlanIcon({ status }: { status: TeamPlanItem['status'] }) {
  if (status === 'merged' || status === 'passed') return <Check className="h-3.5 w-3.5 text-st-done" strokeWidth={3} />;
  if (status === 'active') return <Loader2 className="h-3.5 w-3.5 animate-spin text-st-running" />;
  if (status === 'rework') return <RotateCcw className="h-3.5 w-3.5 text-st-blocked" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 text-st-failed" />;
  return <Circle className="h-3.5 w-3.5 text-fg-4" />;
}

export function TeamPanel({ run }: { run: TeamRun }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = RUN_STATUS[run.status] ?? RUN_STATUS.running;
  const merged = run.plan.filter((t) => t.status === 'merged').length;
  const budgetPct = Math.min(100, Math.round((run.budget.tokensUsed / Math.max(1, run.budget.tokenCap)) * 100));

  const takeOver = async (agentId: string) => {
    setPending(agentId);
    setError(null);
    try {
      const res = await fetch(`/api/team/${encodeURIComponent(run.runId)}/takeover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error || `Takeover failed (${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Takeover failed');
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      data-testid="team-panel"
      aria-label="Team run"
      className="w-full rounded-r-md border border-line-2 bg-bg-1 p-3.5"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-accent" />
            <h2 className="text-body font-medium text-fg-1">Team run</h2>
            <span
              data-testid="team-run-status"
              className={`rounded-full border px-2 py-0.5 font-mono text-micro ${status.className}`}
            >
              {status.label}
            </span>
          </div>
          <p className="mt-1 line-clamp-1 text-meta text-fg-3" title={run.goal}>
            {run.goal}
          </p>
        </div>
        <dl className="flex items-center gap-4 font-mono text-micro text-fg-3">
          <div className="text-right">
            <dt className="text-fg-4">lanes</dt>
            <dd data-testid="team-lane-count">
              {run.concurrency.active}/{run.concurrency.limit}
            </dd>
          </div>
          <div className="text-right">
            <dt className="text-fg-4">merged</dt>
            <dd data-testid="team-merged-count">
              {merged}/{run.plan.length || '—'}
            </dd>
          </div>
          <div className="text-right">
            <dt className="text-fg-4">spend</dt>
            <dd data-testid="team-spend">
              {formatCost(run.budget.costUsedUsd)}
              <span className="text-fg-4"> / {formatCost(run.budget.costCapUsd)}</span>
            </dd>
          </div>
        </dl>
      </header>

      <div className="mt-3">
        <div className="flex items-center justify-between font-mono text-micro text-fg-4">
          <span>token budget</span>
          <span data-testid="team-token-budget">
            {run.budget.tokensUsed.toLocaleString()} / {run.budget.tokenCap.toLocaleString()} · {budgetPct}%
          </span>
        </div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-bg-3">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ease-out ${
              budgetPct >= 100 ? 'bg-st-failed' : budgetPct > 75 ? 'bg-st-blocked' : 'bg-accent'
            }`}
            style={{ width: `${budgetPct}%` }}
          />
        </div>
      </div>

      {run.plan.length ? (
        <div className="mt-3.5">
          <h3 className="font-mono text-micro uppercase tracking-eyebrow text-fg-4">Plan</h3>
          <ol data-testid="team-plan" className="mt-1.5 space-y-1">
            {run.plan.map((task) => (
              <li
                key={task.id}
                data-testid={`team-plan-${task.id}`}
                data-status={task.status}
                className="flex items-start gap-2 rounded-xs px-1 py-1 hover:bg-white/[0.02]"
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  <PlanIcon status={task.status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-body ${
                      task.status === 'merged' || task.status === 'passed'
                        ? 'text-fg-2'
                        : task.status === 'failed'
                          ? 'text-st-failed'
                          : 'text-fg-1'
                    }`}
                  >
                    {task.title}
                  </span>
                  <span className="block truncate font-mono text-micro text-fg-4">
                    {formatRoleLabel(task.roleId)}
                    {task.agentId ? ` · ${task.agentId}` : ''} · {task.status}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="mt-3.5">
        <h3 className="flex items-center gap-1.5 font-mono text-micro uppercase tracking-eyebrow text-fg-4">
          <GitMerge className="h-3 w-3" />
          Lanes
        </h3>
        <div data-testid="team-lanes" className="mt-1.5 grid gap-2 sm:grid-cols-2">
          {run.agents.map((lane) => (
            <TeamLane key={lane.agentId} lane={lane} onTakeOver={takeOver} takeoverPending={pending === lane.agentId} />
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-meta text-st-failed">
          {error}
        </p>
      ) : null}
      {run.error ? (
        <p data-testid="team-error" className="mt-2 text-meta text-st-blocked">
          {run.error}
        </p>
      ) : null}

      <p className="mt-3 font-mono text-micro text-fg-4">
        {run.runId} · merged files: {run.mergedFiles.length}
        {run.mergedFiles.length ? ` · ${run.mergedFiles.map((f) => f.split('/').pop()).join(', ')}` : ''}
      </p>
    </section>
  );
}