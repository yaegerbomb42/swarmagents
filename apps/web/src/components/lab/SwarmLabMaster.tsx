'use client';

import React, { useState } from 'react';
import { Wand2, Library } from 'lucide-react';
import RoleForgeLab from './RoleForgeLab';
import GlobalAgentMarketplace from './GlobalAgentMarketplace';

type LabView = 'create' | 'library';

const VIEWS: { id: LabView; label: string; icon: React.ElementType }[] = [
  { id: 'create', label: 'Create Agent', icon: Wand2 },
  { id: 'library', label: 'Library', icon: Library },
];

export default function SwarmLabMaster() {
  const [view, setView] = useState<LabView>('create');

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#04060f] text-white p-4 lg:p-6 space-y-6 overflow-y-auto">
      {/* Header + view switcher */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Agent Lab</h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Create new agent types, browse your personal library, and publish to the global community.
          </p>
        </div>

        <div
          role="group"
          aria-label="Lab views"
          className="flex items-center gap-1 p-1 rounded-xl bg-black/60 border border-white/10 w-fit"
        >
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-pressed={view === id}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 ${
                view === id
                  ? id === 'create'
                    ? 'bg-violet-500/20 text-violet-200 border-violet-400/40 shadow-sm'
                    : 'bg-cyan-500/20 text-cyan-300 border-cyan-400/40 shadow-sm'
                  : 'bg-transparent text-zinc-400 border-transparent hover:text-zinc-200'
              }`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {view === 'create' ? <RoleForgeLab /> : <GlobalAgentMarketplace />}
    </div>
  );
}
