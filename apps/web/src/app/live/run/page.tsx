'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import RequireAuth from '@/components/auth/RequireAuth';
import { ENGINE_PROXY } from '@/hooks/useRunStream';
import { authHeaders } from '@/lib/auth';
import { fmtNum } from '@/stores/runStore';
import { statusColor, V } from '@/components/cockpit/theme';
import type { RunSnapshot } from '@/types/runEvents';

function fmtStarted(s?: number): string {
  if (!s) return '—';
  const d = new Date(s < 1e12 ? s * 1000 : s);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function RunList() {
  const [runs, setRuns] = useState<RunSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${ENGINE_PROXY}/v1/runs`, { headers: authHeaders(), cache: 'no-store' });
        if (!res.ok) throw new Error(`engine ${res.status}`);
        const body = (await res.json()) as { runs?: RunSnapshot[] };
        if (!alive) return;
        const list = [...(body.runs ?? [])];
        list.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
        setRuns(list);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <main className="min-h-screen px-6 py-5" style={{ background: V.bg0, color: V.fg2 }}>
      <h1 className="mb-3 text-[13px] uppercase tracking-wider" style={{ color: V.fg3 }}>Harness runs</h1>
      {error ? <p className="mb-2 text-[12px]" style={{ color: V.failed }}>Could not list runs: {error}</p> : null}
      {runs == null && !error ? <p className="text-[12px]" style={{ color: V.fg4 }}>loading…</p> : null}
      {runs && runs.length === 0 ? <p className="text-[12px]" style={{ color: V.fg4 }}>No runs yet. Start one with POST /v1/runs.</p> : null}
      {runs && runs.length > 0 ? (
        <table className="w-full font-mono text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-[11px]" style={{ color: V.fg3 }}>
              <th className="py-1 font-normal">run</th><th className="font-normal">status</th>
              <th className="font-normal">steps</th><th className="font-normal">tokens</th>
              <th className="font-normal">started</th><th className="font-normal">task</th><th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run_id} className="border-t" style={{ borderColor: V.line1 }}>
                <td className="py-1.5">
                  <Link href={`/live/run/${encodeURIComponent(r.run_id)}`} style={{ color: V.fg1 }}>{r.run_id}</Link>
                </td>
                <td style={{ color: statusColor(String(r.status)) }}>{r.status}</td>
                <td>{r.steps_done ?? '—'}{r.budgets?.max_steps ? `/${r.budgets.max_steps}` : ''}</td>
                <td>{fmtNum(r.tokens_est)}</td>
                <td>{fmtStarted(r.started_at)}</td>
                <td className="max-w-[40ch] truncate" title={r.task}>{r.task ?? '—'}</td>
                <td className="text-right">
                  <Link href={`/live/run/${encodeURIComponent(r.run_id)}?mode=replay`} className="text-[11px] underline" style={{ color: V.fg3 }}>replay</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </main>
  );
}

export default function RunIndexPage() {
  return (
    <RequireAuth>
      <RunList />
    </RequireAuth>
  );
}
