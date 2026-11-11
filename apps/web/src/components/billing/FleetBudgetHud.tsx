'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Coins, Flame, Gauge, RefreshCw, ShieldCheck, TrendingUp } from 'lucide-react';
import { useBalance } from '@/hooks/useBalance';
import {
  evaluateBudget,
  formatCredits,
  formatRunway,
  formatUsd,
  spendPerHourCredits,
  usdToCredits,
  type BudgetLevel,
} from '@/lib/budgetAlarm';

// ════════════════════════════════════════════════════════════
//  FleetBudgetHud — real-time spend tracker with threshold alarms
//
//  All figures are grounded in existing endpoints:
//   - GET /api/agents/costs  -> CostTracker.getStats() (totalCost,
//     costPerMinute, byProvider, byAgent, totalTokens, callCount)
//   - useBalance()           -> account credits (billingClient)
//   - modelPricing.CREDIT_USD owns the credit/USD rate
//
//  "Session spend" is the engine-tracked cost for the current process
//  converted to credits. The budget ceiling applies to that session
//  spend, so the HUD answers "how much of this run's budget is gone".
// ════════════════════════════════════════════════════════════

export const BUDGET_STORAGE_KEY = 'swarmagents.fleet_budget_credits';

/** Shape of GET /api/agents/costs (CostTracker.getStats()). */
export interface CostStats {
  ok?: boolean;
  totalCost?: number;
  totalCostFormatted?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  callCount?: number;
  runtimeSeconds?: number;
  runtimeFormatted?: string;
  costPerMinute?: number;
  tokensPerMinute?: number;
  byProvider?: Record<string, { cost: number; calls: number; tokens: number }>;
  byAgent?: Record<string, { cost: number; calls: number; tokens: number }>;
  error?: string;
}

export type FleetBudgetHudProps = {
  className?: string;
  refreshIntervalMs?: number;
  /** Injectable for tests; defaults to the dashboard costs proxy. */
  endpoint?: string;
};

const LEVEL_STYLES: Record<
  BudgetLevel,
  { border: string; text: string; icon: typeof ShieldCheck; label: string }
> = {
  ok: { border: 'border-emerald-400/30', text: 'text-emerald-300', icon: ShieldCheck, label: 'within budget' },
  warn: { border: 'border-amber-400/40', text: 'text-amber-300', icon: AlertTriangle, label: 'elevated' },
  critical: { border: 'border-rose-400/50', text: 'text-rose-300', icon: AlertTriangle, label: 'critical' },
  exceeded: { border: 'border-rose-500/70', text: 'text-rose-200', icon: Flame, label: 'exceeded' },
  unset: { border: 'border-white/[0.06]', text: 'text-zinc-500', icon: Gauge, label: 'no budget' },
};

/** Reads the persisted ceiling, tolerating absent/corrupt storage. */
export function readStoredBudget(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(BUDGET_STORAGE_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Persists the ceiling; `0` clears it. Never throws (private mode, quota). */
export function writeStoredBudget(credits: number): void {
  if (typeof window === 'undefined') return;
  try {
    if (!credits || credits <= 0) window.localStorage.removeItem(BUDGET_STORAGE_KEY);
    else window.localStorage.setItem(BUDGET_STORAGE_KEY, String(credits));
  } catch {
    /* storage unavailable — budget simply won't persist */
  }
}

export default function FleetBudgetHud({
  className = '',
  refreshIntervalMs = 10_000,
  endpoint = '/api/agents/costs',
}: FleetBudgetHudProps) {
  const [stats, setStats] = useState<CostStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [limitCredits, setLimitCredits] = useState(0);
  const [draftLimit, setDraftLimit] = useState('');
  const { balance } = useBalance({ intervalMs: 0 });

  useEffect(() => {
    const stored = readStoredBudget();
    setLimitCredits(stored);
    setDraftLimit(stored > 0 ? String(stored) : '');
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(endpoint, { cache: 'no-store', signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as CostStats;
        if (data?.ok === false) throw new Error(data.error || 'cost tracker error');
        setStats(data);
        setError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Cost telemetry unavailable');
      } finally {
        setLoading(false);
      }
    },
    [endpoint],
  );

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    const id = window.setInterval(() => void load(ctl.signal), refreshIntervalMs);
    return () => {
      ctl.abort();
      window.clearInterval(id);
    };
  }, [load, refreshIntervalMs]);

  const spentCredits = useMemo(
    () => usdToCredits(stats?.totalCost ?? 0),
    [stats?.totalCost],
  );
  const burnPerHour = useMemo(
    () => spendPerHourCredits(stats?.costPerMinute ?? 0),
    [stats?.costPerMinute],
  );
  const budget = useMemo(
    () => evaluateBudget({ spentCredits, limitCredits, burnPerHourCredits: burnPerHour }),
    [spentCredits, limitCredits, burnPerHour],
  );

  const style = LEVEL_STYLES[budget.level];
  const LevelIcon = style.icon;

  const topProviders = useMemo(() => {
    const rows = Object.entries(stats?.byProvider ?? {}).map(([provider, v]) => ({
      provider,
      cost: v.cost ?? 0,
      calls: v.calls ?? 0,
      tokens: v.tokens ?? 0,
    }));
    return rows.sort((a, b) => b.cost - a.cost).slice(0, 3);
  }, [stats?.byProvider]);

  const commitLimit = useCallback(() => {
    const parsed = Number(draftLimit);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    setLimitCredits(next);
    writeStoredBudget(next);
    if (next === 0) setDraftLimit('');
  }, [draftLimit]);

  const projectedHourlyUsd = (stats?.costPerMinute ?? 0) * 60;

  const metrics = [
    {
      id: 'spend',
      label: 'session spend',
      value: `${formatCredits(spentCredits)} cr`,
      title: `Engine-tracked cost ${formatUsd(stats?.totalCost ?? 0)} converted to credits`,
    },
    {
      id: 'burn',
      label: 'burn',
      value: `${formatCredits(burnPerHour)} cr/h`,
      title: `Projected from costPerMinute ${formatUsd(stats?.costPerMinute ?? 0)}/min`,
    },
    {
      id: 'runway',
      label: 'runway',
      value: formatRunway(budget.runwayMinutes),
      title: 'Time until the budget ceiling, at the current burn rate',
    },
    {
      id: 'balance',
      label: 'balance',
      value: balance ? `${formatCredits(balance.credits)} cr` : '—',
      title: 'Account credit balance',
    },
    {
      id: 'tokens',
      label: 'tokens',
      value: formatCredits(stats?.totalTokens ?? 0),
      title: `${formatCredits(stats?.totalInputTokens ?? 0)} in / ${formatCredits(stats?.totalOutputTokens ?? 0)} out`,
    },
    {
      id: 'calls',
      label: 'calls',
      value: String(stats?.callCount ?? 0),
      title: `Runtime ${stats?.runtimeFormatted ?? '—'}`,
    },
  ];

  const pctClamped = Math.min(100, Math.max(0, budget.pct));

  return (
    <section
      data-testid="fleet-budget-hud"
      aria-label="Fleet budget and spend"
      className={`rounded-xl border p-3 space-y-3 ${style.border} ${className}`}
      style={{
        background: 'rgba(8, 10, 18, 0.72)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-cyan-300" aria-hidden />
          <h3 className="text-xs font-semibold text-white/90">Fleet Budget</h3>
          <span
            data-testid="budget-level"
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${style.border} ${style.text}`}
          >
            <LevelIcon className="h-3 w-3" aria-hidden />
            {style.label}
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void load();
          }}
          className="inline-flex items-center justify-center h-6 w-6 rounded-md text-zinc-500 hover:text-cyan-200 hover:bg-white/[0.06] transition-colors"
          aria-label="Refresh spend telemetry"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      </div>

      {/* Alarm line */}
      <p
        role="status"
        aria-live="polite"
        data-testid="budget-alarm"
        className={`text-[11px] ${style.text}`}
      >
        {error ? `Spend telemetry offline — ${error}` : budget.message}
      </p>

      {/* Metric rail */}
      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {metrics.map((m) => (
          <div key={m.id} className="flex items-baseline gap-1.5" title={m.title}>
            <dt className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">
              {m.label}
            </dt>
            <dd
              data-testid={`budget-metric-${m.id}`}
              className="text-[12px] font-mono tabular-nums text-zinc-100"
            >
              {m.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* Ceiling editor */}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-zinc-600">
          ceiling
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={draftLimit}
            onChange={(e) => setDraftLimit(e.target.value)}
            onBlur={commitLimit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitLimit();
            }}
            placeholder="credits"
            aria-label="Budget ceiling in credits"
            className="w-24 rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-[11px] font-mono text-zinc-200 outline-none focus:border-cyan-400/40 placeholder:text-zinc-700"
          />
        </label>
        <button
          type="button"
          onClick={commitLimit}
          className="rounded border border-white/10 px-2 py-0.5 text-[10px] font-mono text-zinc-300 hover:bg-white/[0.06]"
        >
          set
        </button>
        {limitCredits > 0 ? (
          <button
            type="button"
            onClick={() => {
              setDraftLimit('');
              setLimitCredits(0);
              writeStoredBudget(0);
            }}
            className="rounded px-2 py-0.5 text-[10px] font-mono text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]"
          >
            clear
          </button>
        ) : null}
      </div>

      {/* Budget bar with threshold ticks at 75% / 90% */}
      <div className="space-y-1.5">
        <div className="relative h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
          <div
            data-testid="budget-bar"
            className={`h-full rounded-full transition-all duration-500 ${
              budget.level === 'exceeded' || budget.level === 'critical'
                ? 'bg-rose-400'
                : budget.level === 'warn'
                  ? 'bg-amber-400'
                  : budget.level === 'unset'
                    ? 'bg-zinc-700'
                    : 'bg-emerald-400'
            }`}
            style={{ width: `${budget.level === 'unset' ? 0 : pctClamped}%` }}
          />
          {limitCredits > 0
            ? [75, 90].map((tick) => (
                <span
                  key={tick}
                  className="absolute top-0 h-full w-px bg-black/50"
                  style={{ left: `${tick}%` }}
                  aria-hidden
                />
              ))
            : null}
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-zinc-500">
          <span data-testid="budget-pct">
            {limitCredits > 0
              ? `${budget.pct.toFixed(1)}% of ${formatCredits(limitCredits)} cr`
              : 'No ceiling set'}
          </span>
          <span className="inline-flex items-center gap-1">
            <TrendingUp className="h-3 w-3" aria-hidden />
            {formatUsd(projectedHourlyUsd)}/h projected
          </span>
        </div>
      </div>

      {/* Top spend by provider */}
      {topProviders.length ? (
        <div className="space-y-1" data-testid="budget-providers">
          <p className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">
            top spend
          </p>
          <ul className="space-y-0.5">
            {topProviders.map((p) => (
              <li
                key={p.provider}
                className="flex items-center justify-between gap-2 text-[11px] font-mono"
              >
                <span className="text-zinc-400 truncate">{p.provider}</span>
                <span className="text-zinc-500 tabular-nums shrink-0">
                  {formatUsd(p.cost)} · {p.calls} calls
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}