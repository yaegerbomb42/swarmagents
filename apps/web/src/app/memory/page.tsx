'use client';

import RequireAuth from '@/components/auth/RequireAuth';
import ConsoleShell from '@/components/ConsoleShell';
import TribalMemoryPanel from '@/components/memory/TribalMemoryPanel';
import EpisodicMemoryPanel from '@/components/memory/EpisodicMemoryPanel';

export default function MemoryPage() {
  return (
    <RequireAuth>
      <ConsoleShell>
        <main className="mx-auto max-w-4xl px-5 py-8 lg:px-8 flex-1 space-y-6">
          <div className="mb-2">
            <h1 className="text-2xl font-semibold tracking-tight text-cyan-50">Swarm Memory</h1>
            <p className="mt-1 text-sm text-cyan-100/45">
              Cross-session rules the swarm has learned from past task executions — shared
              across every agent, every session.
            </p>
          </div>
          <EpisodicMemoryPanel />
          <TribalMemoryPanel />
        </main>
      </ConsoleShell>
    </RequireAuth>
  );
}
