'use client';

import { useId } from 'react';
import { roleBadgeLabel, type GridAgent } from './swarmGridTypes';
import './swarm-grid.css';

export interface AgentRoleCardProps {
  agent: GridAgent;
  selected?: boolean;
  /** Live turn count from the stream store; overrides agent.turnCounter when given. */
  liveTurnCount?: number;
  onClick?: () => void;
}

const STATUS_LABEL: Record<GridAgent['status'], string> = {
  working: 'working',
  idle: 'idle',
  paused: 'paused',
  error: 'error',
};

function fmtTurns(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * A single active swarm worker card: agent name, role badge, active LLM model
 * tag, live status indicator, and a real-time turn counter. Clicking the card
 * selects it (and, through SwarmGrid, previews its task brief and tools).
 */
export default function AgentRoleCard({
  agent,
  selected = false,
  liveTurnCount,
  onClick,
}: AgentRoleCardProps) {
  const nameId = useId();
  const turns = liveTurnCount ?? agent.turnCounter;

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-labelledby={nameId}
      onClick={onClick}
      className={`swarm-card swarm-card--${agent.status}${selected ? ' swarm-card--selected' : ''}`}
    >
      <span className="swarm-card__top">
        <span id={nameId} className="swarm-card__name">
          {agent.name}
        </span>
        <span className="swarm-badge">{roleBadgeLabel(agent.roleId)}</span>
      </span>

      <span className="swarm-card__meta">
        <span className="swarm-model-tag">{agent.model ?? 'model unset'}</span>
        <span className="swarm-status">
          <span className="swarm-status__dot" aria-hidden="true" />
          {STATUS_LABEL[agent.status]}
        </span>
      </span>

      <span className="swarm-card__foot">
        <span className="swarm-turn-label">turns</span>
        <span className="swarm-turn-counter">{fmtTurns(turns)}</span>
      </span>
    </button>
  );
}
