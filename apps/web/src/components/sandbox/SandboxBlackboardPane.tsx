'use client';

import React from 'react';

interface SandboxBlackboardPaneProps {
  entries?: Array<{ key: string; value: string; updatedAt: number }>;
  thoughtStream?: Array<{ text: string; elapsedMs: number; ts: number }>;
  contextPct?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** True only when the agent is actually thinking right now. */
  thinking?: boolean;
}

export default function SandboxBlackboardPane({
  entries = [],
  thoughtStream = [],
  contextPct,
  thinking = false,
}: SandboxBlackboardPaneProps) {
  const lastThought = thoughtStream[thoughtStream.length - 1];
  const empty = entries.length === 0 && thoughtStream.length === 0;

  return (
    <div className="w-full h-full flex flex-col relative bg-[#0c0c0c] font-mono text-[11px] select-none p-3 overflow-hidden">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--fg-3)]">{thinking ? 'Thinking' : 'Blackboard'}</span>
        </div>
        <span className="text-[11px] text-[var(--fg-3)] tabular-nums">
          {lastThought ? `${(lastThought.elapsedMs / 1000).toFixed(1)}s` : '—'}
        </span>
      </div>

      {empty ? (
        <div className="flex-1 flex items-center justify-center text-center text-[11px] text-[var(--fg-3)]">
          No blackboard entries or thoughts reported yet.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-2 leading-relaxed pr-1">
          {entries.map((e) => (
            <div key={e.key} className="flex gap-2 text-[11px]">
              <span className="text-[var(--fg-3)] shrink-0">{e.key}</span>
              <span className="text-zinc-300 truncate">{e.value}</span>
            </div>
          ))}
          {thoughtStream.map((t, idx) => (
            <div key={`${t.ts}-${idx}`} className="text-[11px] text-zinc-400 truncate">
              {t.text}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#161616] text-[11px] text-[var(--fg-3)]">
        context {typeof contextPct === 'number' ? `${Math.round(contextPct)}%` : '—'}
      </div>
    </div>
  );
}
