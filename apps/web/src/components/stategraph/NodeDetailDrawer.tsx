'use client';

import React from 'react';
import type { StateGraphStatus } from './api';
import { X } from 'lucide-react';

type NodeKey = 'pm' | 'coder' | 'verifier' | 'complete';

const TITLES: Record<NodeKey, string> = {
  pm: 'PM Node — Task Decomposition',
  coder: 'Coder Node — Diff Generation',
  verifier: 'Verifier Node — Test Gate',
  complete: 'Run Complete',
};

export default function NodeDetailDrawer({
  node,
  status,
  onClose,
}: {
  node: NodeKey | null;
  status: StateGraphStatus | null;
  onClose: () => void;
}) {
  if (!node) return null;

  const diffs = status?.code_diffs ?? {};
  const tasks = status?.current_tasks ?? [];
  const activeIdx = status?.active_task_index ?? 0;
  const vLogs = status?.verification_logs ?? '';
  const retries = status?.retry_counts ?? {};
  const logs = status?.logs ?? [];

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[480px] bg-zinc-950 border-l border-white/10 shadow-2xl z-40 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="text-sm font-semibold text-white/90">{TITLES[node]}</div>
        <button onClick={onClose} className="text-white/40 hover:text-white/80">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-[12px]">
        {!status && <div className="text-white/40">No run yet. Start a run to inspect nodes.</div>}

        {node === 'pm' && status && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-amber-300/80 mb-1.5">Decomposed Tasks</h3>
            {tasks.length ? (
              <ol className="list-decimal ml-5 space-y-1">
                {tasks.map((t, i) => (
                  <li key={t} className={i === activeIdx ? 'text-amber-300' : 'text-white/70'}>
                    <code className="font-mono">{t}</code>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="text-white/40">No tasks decomposed yet.</div>
            )}
          </section>
        )}

        {node === 'coder' && status && (
          <section className="space-y-2">
            <h3 className="text-[11px] uppercase tracking-wider text-cyan-300/80">Generated Diffs</h3>
            {Object.keys(diffs).length ? (
              Object.entries(diffs).map(([task, diff]) => (
                <details key={task} className="border border-white/5 rounded" open={task === tasks[activeIdx]}>
                  <summary className="cursor-pointer px-2 py-1.5 text-cyan-200/90 font-mono text-[11px]">
                    {task}
                  </summary>
                  <pre className="px-2 py-1.5 bg-black/50 text-[11px] text-emerald-200/80 overflow-x-auto border-t border-white/5">
                    {diff}
                  </pre>
                </details>
              ))
            ) : (
              <div className="text-white/40">No diffs generated yet.</div>
            )}
            <div className="text-white/40">coder retries: {retries['coder'] ?? 0}</div>
          </section>
        )}

        {node === 'verifier' && status && (
          <section className="space-y-2">
            <h3 className="text-[11px] uppercase tracking-wider text-violet-300/80">Verification Outcome</h3>
            {vLogs ? (
              <pre className="bg-black/50 p-2 rounded text-[11px] text-violet-200/80 whitespace-pre-wrap">
                {vLogs}
              </pre>
            ) : (
              <div className="text-white/40">No verification yet.</div>
            )}
            <div className="text-white/40">verifier retries observed: {retries['verifier'] ?? 0}</div>
          </section>
        )}

        {node === 'complete' && status && (
          <section className="space-y-2">
            <h3 className="text-[11px] uppercase tracking-wider text-emerald-300/80">Final State</h3>
            <div className="text-white/70">
              tasks completed: <span className="text-emerald-300">{activeIdx} / {tasks.length}</span>
            </div>
            <div className="text-white/70">
              duration:{' '}
              <span className="text-emerald-300">
                {status.finished_at ? `${((status.finished_at - status.started_at) * 1000).toFixed(0)}ms` : 'in progress'}
              </span>
            </div>
            <h4 className="text-[11px] uppercase tracking-wider text-white/50 mt-3">Tail Logs</h4>
            <pre className="bg-black/50 p-2 rounded text-[11px] text-white/60 max-h-64 overflow-y-auto whitespace-pre-wrap">
              {logs.slice(-30).join('\n') || '(no logs)'}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
