'use client';

import React from 'react';
import type { SandboxLogLine } from '@/lib/sandboxTypes';

interface SandboxBrowserPaneProps {
  url?: string;
  screenshotUrl?: string;
  cursorX?: number;
  cursorY?: number;
  logs?: SandboxLogLine[];
}

export default function SandboxBrowserPane({ url, screenshotUrl }: SandboxBrowserPaneProps) {
  return (
    <div className="w-full h-full relative flex flex-col bg-[#0c0c0c] font-mono select-none">
      <div className="flex items-center gap-2 shrink-0 h-8 px-2.5 border-b border-[#161616] bg-[#0f0f0f]">
        <div className="flex items-center gap-1.5 flex-1 h-5 rounded-md bg-[#121212] border border-[#1a1a1a] px-2 overflow-hidden">
          <span className="text-[11px] text-[var(--fg-3)] truncate">{url || '—'}</span>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden flex items-center justify-center">
        {screenshotUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={screenshotUrl} alt={url ? `Browser viewport: ${url}` : 'Browser viewport'} className="w-full h-full object-contain object-top" />
        ) : (
          <div className="p-6 text-center text-[11px] text-[var(--fg-3)]">
            {url ? 'No screenshot available for this page.' : 'No browser activity for this agent.'}
          </div>
        )}
      </div>
    </div>
  );
}
