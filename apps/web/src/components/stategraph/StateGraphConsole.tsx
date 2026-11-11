'use client';

import { useCallback, useEffect, useState } from 'react';
import { Play, RefreshCw } from 'lucide-react';
import ConsoleShell from '@/components/ConsoleShell';
import RequireAuth from '@/components/auth/RequireAuth';
import StateGraphViz from '@/components/stategraph/StateGraphViz';
import NodeEventFeed from '@/components/stategraph/NodeEventFeed';
import NodeDetailDrawer from '@/components/stategraph/NodeDetailDrawer';
import {
  fetchStateGraphStatus,
  startStateGraphRun,
  type StateGraphStatus,
} from '@/components/stategraph/api';

type NodeKey = 'pm' | 'coder' | 'verifier' | 'complete';

export default function StateGraphConsole() {
  const [goal, setGoal] = useState('Ship a typed REST API with tests and Docker Compose');
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<StateGraphStatus | null>(null);
  const [selected, setSelected] = useState<NodeKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const poll = useCallback(async (id: string) => {
    try {
      const next = await fetchStateGraphStatus(id);
      setStatus(next);
      setError(null);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'poll failed');
      return null;
    }
  }, []);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const tick = async () => {
      const next = await poll(runId);
      if (cancelled || !next) return;
      if (next.status === 'complete' || next.status === 'error') return;
    };
    void tick();
    const id = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [runId, poll]);

  const startRun = async () => {
    if (!goal.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await startStateGraphRun(goal.trim());
      setRunId(res.run_id);
      await poll(res.run_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'start failed');
    } finally {
      setStarting(false);
    }
  };

  return (
    <RequireAuth>
      <ConsoleShell missionHint="State graph · PM → Coder → Verifier">
        <main className="flex-1 min-h-0 p-3 flex flex-col gap-3">
          <div
            className="rounded-xl border border-white/[0.06] p-3 flex flex-col sm:flex-row gap-2"
            style={{ background: 'rgba(8,8,18,0.72)', backdropFilter: 'blur(12px)' }}
          >
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-500/40"
              placeholder="Project goal…"
            />
            <button
              type="button"
              onClick={startRun}
              disabled={starting}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              {starting ? 'Starting…' : 'Run async'}
            </button>
            {runId && (
              <button
                type="button"
                onClick={() => poll(runId)}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            )}
          </div>

          {error && <p className="text-xs text-rose-400 px-1">{error}</p>}
          {runId && (
            <p className="text-[10px] text-zinc-500 font-mono px-1">
              run_id: {runId} · status: {status?.status ?? '…'} · node: {status?.current_node ?? '—'}
            </p>
          )}

          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3">
            <div className="rounded-xl border border-white/[0.06] bg-[#06061a] p-4 min-h-[240px] overflow-auto">
              <StateGraphViz status={status} selected={selected} onSelect={setSelected} />
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-[#06061a] p-3 overflow-y-auto min-h-[200px]">
              <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Event feed</h3>
              <NodeEventFeed events={status?.node_history ?? []} />
            </div>
          </div>

          <NodeDetailDrawer node={selected} status={status} onClose={() => setSelected(null)} />
        </main>
      </ConsoleShell>
    </RequireAuth>
  );
}
