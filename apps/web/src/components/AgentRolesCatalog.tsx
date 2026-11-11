'use client';

import { AGENT_ROLES, TIER_BADGE_CLASS, TIER_LABELS, type AgentRole } from '@/lib/agentRoles';

type Props = {
  compact?: boolean;
  onSelect?: (role: AgentRole) => void;
  selectedId?: string | null;
  className?: string;
};

export default function AgentRolesCatalog({ compact, onSelect, selectedId, className = '' }: Props) {
  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">Fleet agent roles</h3>
          <p className="text-[11px] text-zinc-500">
            {AGENT_ROLES.length} built-in roles used by decomposition, sandboxes, and provider bindings.
          </p>
        </div>
        <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider">SwarmAgents catalog</span>
      </div>
      <div
        className={
          compact
            ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2'
            : 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3'
        }
      >
        {AGENT_ROLES.map((role) => {
          const Icon = role.icon;
          const selected = selectedId === role.id;
          const inner = (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className={`shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br ${role.color} flex items-center justify-center shadow-sm`}
                  >
                    <Icon className="w-4 h-4 text-white" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white truncate">{role.name}</div>
                    <div className="text-[10px] font-mono text-zinc-500 truncate">{role.id}</div>
                  </div>
                </div>
                <span
                  className={`shrink-0 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border ${TIER_BADGE_CLASS[role.model_tier]}`}
                >
                  {TIER_LABELS[role.model_tier]}
                </span>
              </div>
              {!compact && (
                <>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">{role.description}</p>
                  <p className="text-[10px] text-zinc-500 leading-relaxed">{role.responsibility}</p>
                </>
              )}
              <div className="flex flex-wrap gap-1">
                {role.tools.map((tool) => (
                  <span
                    key={tool}
                    className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.06] text-zinc-400"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </>
          );

          if (onSelect) {
            return (
              <button
                key={role.id}
                type="button"
                onClick={() => onSelect(role)}
                className={`text-left rounded-xl border p-3 space-y-2 transition ${
                  selected
                    ? 'border-violet-500/50 bg-violet-500/10'
                    : 'border-white/[0.06] bg-black/30 hover:border-white/[0.12] hover:bg-white/[0.02]'
                }`}
              >
                {inner}
              </button>
            );
          }

          return (
            <div
              key={role.id}
              className="rounded-xl border border-white/[0.06] bg-black/30 p-3 space-y-2"
            >
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}
