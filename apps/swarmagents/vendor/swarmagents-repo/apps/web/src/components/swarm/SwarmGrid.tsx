'use client';

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { agentStreamStore } from '@/lib/agentStreamStore';
import AgentRoleCard from './AgentRoleCard';
import { roleBadgeLabel, type GridAgent } from './swarmGridTypes';
import './swarm-grid.css';

export interface SwarmGridProps {
  agents: GridAgent[];
  /** Called with the clicked agent so hosts can open its task brief / tool whitelist. */
  onSelect?: (agent: GridAgent) => void;
  /** External live-turn map keyed by agent id; merged over the internal subscription. */
  liveTurns?: ReadonlyMap<string, number>;
  className?: string;
  emptyMessage?: string;
}

/** Subscribe to the agent stream store for live per-agent event counts (turns). */
function useLiveTurnCounts(external?: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  const [internal, setInternal] = useState<ReadonlyMap<string, number>>(() => new Map());

  useEffect(() => {
    const sync = () => {
      const next = new Map<string, number>();
      for (const s of agentStreamStore.agentsSnapshot()) next.set(s.agentId, s.eventCount);
      setInternal(next);
    };
    sync();
    return agentStreamStore.subscribe(sync);
  }, []);

  return useMemo(() => {
    if (!external || external.size === 0) return internal;
    const merged = new Map(internal);
    for (const [key, value] of external) merged.set(key, value);
    return merged;
  }, [internal, external]);
}

/**
 * Responsive grid/card view of every active swarm worker. Each card renders the
 * agent name, role badge, active model, status, and a real-time turn counter;
 * clicking a card selects it and previews its active task brief and tool
 * whitelist in an inspector, while also notifying the host via onSelect.
 */
export default function SwarmGrid({
  agents,
  onSelect,
  liveTurns,
  className = '',
  emptyMessage,
}: SwarmGridProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const liveTurnsAll = useLiveTurnCounts(liveTurns);
  const selected = agents.find((a) => a.id === selectedId) ?? null;

  const handleClick = (agent: GridAgent) => {
    setSelectedId(agent.id);
    onSelect?.(agent);
  };

  return (
    <div className={`swarm-grid-wrap ${className}`}>
      <div className="swarm-grid" role="list" aria-label="Active swarm agents">
        {agents.length === 0 ? (
          <div className="swarm-grid__empty">{emptyMessage ?? 'No active swarm agents.'}</div>
        ) : (
          agents.map((agent) => (
            <AgentRoleCard
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedId}
              liveTurnCount={liveTurnsAll.get(agent.id)}
              onClick={() => handleClick(agent)}
            />
          ))
        )}
      </div>

      {selected && (
        <aside className="swarm-inspector" aria-live="polite">
          <header className="swarm-inspector__head">
            <div>
              <div className="swarm-inspector__name">{selected.name}</div>
              <div className="swarm-inspector__role">{roleBadgeLabel(selected.roleId)}</div>
            </div>
            <button
              type="button"
              className="swarm-inspector__close"
              aria-label="Close inspector"
              onClick={() => setSelectedId(null)}
            >
              <X size={14} />
            </button>
          </header>

          <dl className="swarm-inspector__block">
            <dt>Active task brief</dt>
            <dd>{selected.taskBrief ?? 'No task brief available.'}</dd>
          </dl>

          <dl className="swarm-inspector__block">
            <dt>Tool whitelist</dt>
            <dd className="swarm-inspector__tools">
              {selected.toolWhitelist?.length ? (
                selected.toolWhitelist.map((tool) => <code key={tool}>{tool}</code>)
              ) : (
                <span>No tools assigned.</span>
              )}
            </dd>
          </dl>
        </aside>
      )}
    </div>
  );
}
