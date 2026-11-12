'use client';

import { getAgentRoleById } from '@/lib/agentRoles';
import type { TeamAgentLane, TeamAgentStatus } from '@/lib/team/types';
import { Hand, Loader2 } from 'lucide-react';

const STATUS: Record<TeamAgentStatus, { label: string; dot: string; text: string }> = {
  queued: { label: 'Queued', dot: 'bg-fg-4', text: 'text-fg-3' },
  running: { label: 'Running', dot: 'bg-st-running animate-pulse', text: 'text-st-running' },
  review: { label: 'In review', dot: 'bg-st-thinking animate-pulse', text: 'text-st-thinking' },
  rework: { label: 'Rework', dot: 'bg-st-blocked', text: 'text-st-blocked' },
  merged: { label: 'Merged', dot: 'bg-st-done', text: 'text-st-done' },
  failed: { label: 'Failed', dot: 'bg-st-failed', text: 'text-st-failed' },
  paused: { label: 'Paused', dot: 'bg-st-paused', text: 'text-st-paused' },
};

const KIND_LABEL: Record<TeamAgentLane['kind'], string> = {
  planner: 'Planner',
  worker: 'Sub-agent',
  reviewer: 'Reviewer',
};

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function TeamLane({
  lane,
  onTakeOver,
  takeoverPending,
}: {
  lane: TeamAgentLane;
  onTakeOver?: (agentId: string) => void;
  takeoverPending?: boolean;
}) {
  const role = getAgentRoleById(lane.roleId);
  const Icon = role?.icon;
  const status = STATUS[lane.status] ?? STATUS.queued;
  const closable = lane.takenOver || lane.status === 'merged' || lane.status === 'failed';

  return (
    <article
      data-testid={`team-lane-${lane.agentId}`}
      data-status={lane.status}
      className="flex flex-col gap-2.5 rounded-r-md border border-line-2 bg-bg-1 p-3"
    >
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xs bg-gradient-to-br ${
            role?.color ?? 'from-zinc-500 to-zinc-700'
          } text-zinc-950`}
        >
          {Icon ? <Icon className="h-4 w-4" strokeWidth={2.2} /> : <span className="text-title font-semibold">{lane.glyph}</span>}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-medium text-fg-1">
            {lane.roleName}
            {lane.takenOver ? <span className="ml-1.5 text-micro text-accent">· you</span> : null}
          </p>
          <p className="font-mono text-micro text-fg-4">
            {KIND_LABEL[lane.kind]} · {lane.agentId}
            {lane.taskId ? ` · ${lane.taskId}` : ''}
          </p>
        </div>
        <span
          data-testid={`team-lane-status-${lane.agentId}`}
          className={`inline-flex shrink-0 items-center gap-1.5 font-mono text-micro ${status.text}`}
        >
          {lane.status === 'running' || lane.status === 'review' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          )}
          {status.label}
        </span>
      </header>

      <p
        data-testid={`team-lane-action-${lane.agentId}`}
        className="line-clamp-2 min-h-[32px] font-mono text-micro leading-4 text-fg-2"
        title={lane.currentAction}
      >
        {lane.currentAction}
      </p>

      <dl className="grid grid-cols-3 gap-2 border-t border-line-2 pt-2 font-mono text-micro">
        <div className="min-w-0">
          <dt className="text-fg-4">provider</dt>
          <dd className="truncate text-fg-2" title={`${lane.provider} · ${lane.model}`}>
            {lane.provider}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-4">tokens</dt>
          <dd className="text-fg-2">{formatTokens(lane.tokens)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-4">cost</dt>
          <dd data-testid={`team-lane-cost-${lane.agentId}`} className="text-fg-2">
            {formatCost(lane.costUsd)}
          </dd>
        </div>
      </dl>

      <footer className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-micro text-fg-4" title={lane.worktree}>
          {lane.worktree}
        </span>
        {onTakeOver ? (
          <button
            type="button"
            onClick={() => onTakeOver(lane.agentId)}
            disabled={closable || takeoverPending}
            aria-label={`Take over ${lane.roleName}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-xs border border-line-2 px-2 py-1 font-mono text-micro text-fg-2 transition-colors duration-fast hover:border-accent/50 hover:text-fg-1 disabled:opacity-40 disabled:hover:border-line-2 disabled:hover:text-fg-2"
          >
            <Hand className="h-3 w-3" />
            {lane.takenOver ? 'Yours' : takeoverPending ? 'Taking…' : 'Take over'}
          </button>
        ) : null}
      </footer>
    </article>
  );
}