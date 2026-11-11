'use client';

import React from 'react';

export interface ProviderItem {
  name: string;
  endpoint: string;
  enabled: boolean;
}

interface ProviderListProps {
  providers: ProviderItem[];
  onToggle: (name: string) => void;
}

export default function ProviderList({ providers, onToggle }: ProviderListProps) {
  return (
    <div className="space-y-2" data-testid="provider-list">
      {providers.map((p) => (
        <div
          key={p.name}
          className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3 transition-colors hover:border-cyan-500/20"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium text-white/90">{p.name}</span>
            <span className="text-[11px] font-mono text-white/35 truncate max-w-[320px]">
              {p.endpoint || '(no endpoint)'}
            </span>
          </div>
          <button
            onClick={() => onToggle(p.name)}
            data-enabled={p.enabled}
            className={`tactile text-[11px] font-medium px-3 py-1 rounded-md border transition-all ${
              p.enabled
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400/50 hover:bg-emerald-500/15'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-300 hover:border-rose-400/50 hover:bg-rose-500/15'
            }`}
          >
            {p.enabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
      ))}
    </div>
  );
}
