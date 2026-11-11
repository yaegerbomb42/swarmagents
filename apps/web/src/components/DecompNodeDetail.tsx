'use client';

import { X, CheckCircle2, Wrench, Link2, FileCode, Bot, Timer } from 'lucide-react';
import type { DecompNode } from '@/stores/swarmStore';
import { AGENT_ROLES } from '@/lib/agentRoles';

interface DecompNodeDetailProps {
  node: DecompNode | null;
  onClose?: () => void;
  className?: string;
}

const TIER_STYLE: Record<string, string> = {
  grunt: 'border-emerald-500/25 text-emerald-400/90 bg-emerald-500/10',
  specialist: 'border-zinc-500/40 text-zinc-300 bg-white/5',
  architect: 'border-zinc-400/40 text-zinc-200 bg-white/[0.06]',
};

export default function DecompNodeDetail({ node, onClose, className = '' }: DecompNodeDetailProps) {
  if (!node) return null;

  const criteria = node.acceptance_criteria || [];
  const tools = node.tools || [];
  const deps = node.depends_on || [];
  const tier = node.model_tier || (node.agent_class === 'grunt' ? 'grunt' : 'specialist');

  return (
    <div
      className={`rounded-lg border border-[#27272a] bg-[#141416] p-3 space-y-3 ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-[9px] uppercase tracking-widest text-zinc-500">
              {node.type}
            </span>
            <span
              className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border ${
                TIER_STYLE[tier] || TIER_STYLE.specialist
              }`}
            >
              {tier}
            </span>
            <select
              value={node.agent_class || 'implementer'}
              onChange={(e) => {
                node.agent_class = e.target.value;
                if (typeof window !== 'undefined') {
                  const event = new CustomEvent('agent-archetype-changed', { detail: { nodeId: node.id, archetype: e.target.value } });
                  window.dispatchEvent(event);
                }
              }}
              className="bg-[#0c0c0d] text-zinc-300 border border-[#27272a] text-[9px] rounded px-1 py-0.5 focus:outline-none max-w-[9rem]"
            >
              {AGENT_ROLES.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
            <span className="text-[9px] text-zinc-600 uppercase">{node.priority}</span>
          </div>
          <h3 className="text-sm text-zinc-100 font-medium leading-snug">{node.label}</h3>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-white/[0.04]"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {node.description && (
        <p className="text-[11px] text-zinc-500 leading-relaxed">{node.description}</p>
      )}

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div className="flex items-center gap-1.5 text-zinc-500">
          <Timer size={11} className="text-zinc-600" />
          {node.effort_minutes ?? '—'}m effort
        </div>
        <div className="flex items-center gap-1.5 text-zinc-500">
          <Bot size={11} className="text-zinc-600" />
          {node.status}
        </div>
      </div>

      {criteria.length > 0 && (
        <div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1.5 flex items-center gap-1">
            <CheckCircle2 size={10} /> Acceptance
          </div>
          <ul className="space-y-1">
            {criteria.map((c, i) => (
              <li
                key={i}
                className="text-[11px] text-zinc-400 flex gap-2 leading-snug"
              >
                <span className="text-zinc-600 shrink-0">·</span>
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tools.length > 0 && (
        <div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1.5 flex items-center gap-1">
            <Wrench size={10} /> Tools
          </div>
          <div className="flex flex-wrap gap-1">
            {tools.map((t) => (
              <span
                key={t}
                className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-amber-500/20 text-amber-200/70 bg-amber-500/5"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {deps.length > 0 && (
        <div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1.5 flex items-center gap-1">
            <Link2 size={10} /> Depends on
          </div>
          <div className="flex flex-wrap gap-1">
            {deps.map((d) => (
              <span
                key={d}
                className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-white/10 text-white/45"
              >
                {d}
              </span>
            ))}
          </div>
        </div>
      )}

      {node.deliverable_path && (
        <div>
          <div className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1 flex items-center gap-1">
            <FileCode size={10} /> Deliverable
          </div>
          <code className="text-[10px] font-mono text-zinc-400 break-all">
            {node.deliverable_path}
          </code>
        </div>
      )}

      {(node.tokens_used != null || node.tool_calls != null || node.quality_score != null) && (
        <div className="flex gap-3 text-[9px] text-zinc-600 border-t border-[#232326] pt-2">
          {node.tokens_used != null && <span>{node.tokens_used} tok</span>}
          {node.tool_calls != null && <span>{node.tool_calls} tools</span>}
          {node.retries != null && <span>{node.retries} retries</span>}
          {node.quality_score != null && <span>Q {node.quality_score.toFixed(2)}</span>}
        </div>
      )}
    </div>
  );
}
