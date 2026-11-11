'use client';

import React from 'react';
import { summarizeEvent } from '@/stores/runStore';
import type { RunEvent } from '@/types/runEvents';
import { V } from './theme';

/** The one place raw JSON is shown — opened deliberately via shift+click. */
export default function RawEventDrawer({ event, onClose }: { event: RunEvent | null; onClose: () => void }) {
  if (!event) return null;
  return (
    <div role="dialog" aria-label="Raw event" className="fixed bottom-0 right-0 top-0 z-40 flex w-[520px] flex-col border-l"
      style={{ background: V.bg2, borderColor: V.line3 }}>
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[12px]" style={{ borderColor: V.line2, color: V.fg1 }}>
        <span className="min-w-0 flex-1 truncate font-mono">{summarizeEvent(event)}</span>
        <span className="font-mono text-[11px]" style={{ color: V.fg3 }}>seq {event._localSeq ? '—' : event.seq}</span>
        <button type="button" onClick={onClose} className="text-[11px] underline" style={{ color: V.fg2 }}>close (esc)</button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px]" style={{ color: V.fg2 }}>
        {JSON.stringify(event, null, 2)}
      </pre>
    </div>
  );
}
