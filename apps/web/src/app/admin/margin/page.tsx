'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import {
  clearAdminKey,
  fetchLiveMargin,
  getAdminKey,
  LiveMarginError,
  LiveMarginResponse,
  setAdminKey,
  WindowHours,
} from '@/lib/marginApi';

const WINDOWS: { label: string; hours: WindowHours }[] = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });

export default function AdminMarginLivePage() {
  const [adminKey, setAdminKeyInput] = useState<string>('');
  const [hasKey, setHasKey] = useState(false);
  const [windowHours, setWindowHours] = useState<WindowHours>(1);
  const [report, setReport] = useState<LiveMarginResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const existing = getAdminKey();
    if (existing) {
      setAdminKeyInput(existing);
      setHasKey(true);
    }
  }, []);

  const load = useCallback(
    async (key: string, hours: WindowHours) => {
      if (!key) return;
      setLoading(true);
      setError(null);
      try {
        const data = await fetchLiveMargin(hours, key);
        setReport(data);
      } catch (e) {
        const err = e as LiveMarginError;
        setError(err.message || 'Fetch failed');
        setReport(null);
        if (err.unauthorized) {
          clearAdminKey();
          setHasKey(false);
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (hasKey && adminKey) {
      void load(adminKey, windowHours);
    }
  }, [hasKey, adminKey, windowHours, load]);

  const maxAbsMargin = useMemo(() => {
    if (!report?.models?.length) return 1;
    return Math.max(
      1e-9,
      ...report.models.map((m) => Math.abs(m.margin_pct ?? 0)),
    );
  }, [report]);

  function handleSubmitKey(e: React.FormEvent) {
    e.preventDefault();
    if (!adminKey.trim()) return;
    setAdminKey(adminKey.trim());
    setHasKey(true);
  }

  function handleClearKey() {
    clearAdminKey();
    setAdminKeyInput('');
    setHasKey(false);
    setReport(null);
  }

  if (!hasKey) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-6">
        <div className="rounded-lg border border-cyan-400/20 bg-slate-950/40 p-6">
          <div className="mb-4 flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-300" />
            <h1 className="text-base font-semibold text-cyan-50">Admin key required</h1>
          </div>
          <p className="mb-4 text-xs text-cyan-100/60">
            Enter the engine <code className="rounded bg-cyan-400/10 px-1">BILLING_INTERNAL_SECRET</code> to
            view live margin telemetry. Stored in sessionStorage only — cleared when this tab closes.
          </p>
          <form onSubmit={handleSubmitKey} className="space-y-3">
            <input
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKeyInput(e.target.value)}
              placeholder="X-Billing-Internal-Key"
              autoFocus
              className="w-full rounded-md border border-cyan-400/30 bg-slate-900/60 px-3 py-2 text-sm text-cyan-50 placeholder:text-cyan-100/30 focus:border-cyan-400/70 focus:outline-none"
            />
            <button
              type="submit"
              className="w-full rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-sm font-medium text-cyan-50 hover:bg-cyan-400/20"
            >
              Unlock margin dashboard
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-cyan-50">Live model margins</h1>
          <p className="mt-1 text-xs text-cyan-100/50">
            Credits (USD at list price) vs. estimated Azure cost over the selected window.
            {report && (
              <>
                {' '}Generated {new Date(report.generated_at).toLocaleTimeString()}.
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-cyan-400/20 p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.hours}
                onClick={() => setWindowHours(w.hours)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  windowHours === w.hours
                    ? 'bg-cyan-400/20 text-cyan-50'
                    : 'text-cyan-100/60 hover:text-cyan-50'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => void load(adminKey, windowHours)}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-cyan-400/20 px-3 py-1.5 text-xs text-cyan-100/80 hover:bg-cyan-400/10 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button
            onClick={handleClearKey}
            className="rounded-md border border-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100/50 hover:text-cyan-100"
          >
            Sign out
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-400/30 bg-red-400/10 px-4 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {loading && !report ? (
        <p className="text-sm text-cyan-100/40">Loading margin report…</p>
      ) : report ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-cyan-400/15">
            <table className="w-full text-left text-xs">
              <thead className="bg-cyan-400/5 text-[11px] uppercase tracking-wide text-cyan-100/50">
                <tr>
                  <th className="px-4 py-2">Model</th>
                  <th className="px-4 py-2 text-right">Gross (USD)</th>
                  <th className="px-4 py-2 text-right">Cost (USD)</th>
                  <th className="px-4 py-2 text-right">Margin (USD)</th>
                  <th className="px-4 py-2 text-right">Margin %</th>
                  <th className="px-4 py-2 text-right">Calls</th>
                  <th className="px-4 py-2 w-[220px]">Margin % chart</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cyan-400/10 text-cyan-50/90">
                {report.models.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-cyan-100/40">
                      No traffic in this window.
                    </td>
                  </tr>
                ) : (
                  report.models.map((m) => {
                    const pct = m.margin_pct ?? 0;
                    const barW = Math.min(100, (Math.abs(pct) / maxAbsMargin) * 100);
                    const positive = pct >= 0;
                    return (
                      <tr key={m.model} className="hover:bg-cyan-400/5">
                        <td className="px-4 py-2 font-medium">{m.model}</td>
                        <td className="px-4 py-2 text-right tabular-nums">${fmt(m.gross_usd)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">${fmt(m.cost_usd)}</td>
                        <td
                          className={`px-4 py-2 text-right tabular-nums ${
                            m.margin_usd >= 0 ? 'text-emerald-300' : 'text-red-300'
                          }`}
                        >
                          ${fmt(m.margin_usd)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {m.margin_pct === null ? '—' : `${m.margin_pct.toFixed(1)}%`}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{m.calls}</td>
                        <td className="px-4 py-2">
                          <svg
                            width="200"
                            height="14"
                            viewBox="0 0 200 14"
                            className="block"
                            aria-label={`margin ${pct.toFixed(1)}%`}
                          >
                            <rect x="0" y="4" width="200" height="6" rx="2" fill="rgba(34,211,238,0.08)" />
                            <rect
                              x={positive ? 100 : 100 - barW}
                              y="4"
                              width={barW}
                              height="6"
                              rx="2"
                              fill={positive ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)'}
                            />
                            <line x1="100" y1="2" x2="100" y2="12" stroke="rgba(34,211,238,0.4)" strokeWidth="1" />
                          </svg>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
              {report.models.length > 0 && (
                <tfoot className="border-t border-cyan-400/20 bg-cyan-400/5 font-semibold text-cyan-50">
                  <tr>
                    <td className="px-4 py-2">Total ({windowHours}h)</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      ${fmt(report.totals.gross_usd)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">${fmt(report.totals.cost_usd)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      ${fmt(report.totals.margin_usd)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {report.totals.margin_pct === null
                        ? '—'
                        : `${report.totals.margin_pct.toFixed(1)}%`}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{report.totals.calls}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
