'use client';

import React, { useState } from 'react';
import type { NodeEvent } from './api';
import { ChevronDown, ChevronRight } from 'lucide-react';

const NODE_DOT: Record<string, string> = {
  pm: 'bg-amber-400',
  coder: 'bg-cyan-400',
  verifier: 'bg-violet-400',
  graph: 'bg-emerald-400',
};

export default function NodeEventFeed({ events }: { events: NodeEvent[] }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  if (!events.length) {
    return (
      <div className="text-center text-xs text-white/30 py-6 border border-white/5 rounded-lg">
        No events yet. Start a run to see PM→Coder→Verifier activity.
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {events.map((ev, i) => {
        const key = `${i}-${ev.timestamp}`;
        const open = !!expanded[i];
        const hasData = !!ev.data && Object.keys(ev.data).length > 0;
        return (
          <div
            key={key}
            className="border border-white/5 bg-white/[0.02] rounded-md px-2.5 py-1.5 text-[12px]"
          >
            <button
              onClick={() => hasData && setExpanded((s) => ({ ...s, [i]: !s[i] }))}
              className="w-full flex items-center gap-2 text-left"
              disabled={!hasData}
            >
              <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${NODE_DOT[ev.node] ?? 'bg-zinc-500'}`} />
              <span className="font-mono text-white/50">step {ev.step}</span>
              <span className="font-semibold text-white/90">{ev.node}</span>
              <span className="text-white/50">·</span>
              <span className="text-white/70">{ev.event}</span>
              {ev.detail && <span className="text-white/40 truncate">— {ev.detail}</span>}
              <span className="ml-auto text-white/40">
                {hasData ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
              </span>
            </button>
            {open && hasData && (
              <pre className="mt-1.5 ml-4 p-2 bg-black/40 rounded text-[11px] text-emerald-200/80 overflow-x-auto max-h-48">
                {JSON.stringify(ev.data, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
