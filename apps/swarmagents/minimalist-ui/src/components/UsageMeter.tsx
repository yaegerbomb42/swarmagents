import { useEffect, useId, useState } from 'react';
import { Sparkles } from 'lucide-react';

/**
 * UsageMeter — spend, tokens and provider budgets for the Telemetry panel.
 *
 * Fetches GET /api/runtime/usage (same session auth as the other runtime
 * routes) and shows today's spend as a headline number, a 7-day sparkline
 * (inline SVG, no chart dependency), compact token counts and one budget bar
 * per provider: emerald under 80% of the daily budget, amber from 80%, red at
 * 100% or above. Refreshes on mount, whenever the active run changes, and
 * every 60s while mounted. Silent while the endpoint is unreachable — the
 * meter is informational, never a blocker.
 */

interface UsageSlice {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  runs: number;
  runsWithCost: number;
}

interface DayUsage extends UsageSlice {
  date: string;
  byProvider: Record<string, UsageSlice>;
  byModel: Record<string, UsageSlice>;
}

interface ProviderBudgetStatus {
  id: string;
  budgetUsd: number;
  spentTodayUsd: number;
  remainingUsd: number;
  fractionUsed: number;
}

interface UsageReport {
  days: DayUsage[];
  runs: unknown[];
  budgets: ProviderBudgetStatus[];
  totals: UsageSlice;
}

/** Height threshold (0..1) past which a budget bar turns amber. */
const BUDGET_WARN_PCT = 0.8;

/** Sparkline drawing box (viewBox units); the SVG itself is scaled to fit. */
const SPARK_W = 112;
const SPARK_H = 30;
/** Horizontal padding so the first/last points stay off the SVG edges. */
const SPARK_PAD = 4;

const DAY_MS = 86_400_000;

/** UTC day keys for the last 7 days, oldest first, ending today. */
function lastSevenDayKeys(): string[] {
  const keys: string[] = [];
  const now = Date.now();
  for (let i = 6; i >= 0; i -= 1) {
    keys.push(new Date(now - i * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

function budgetBarColor(fraction: number): string {
  if (fraction >= 1) return 'bg-red-500';
  if (fraction >= BUDGET_WARN_PCT) return 'bg-amber-400';
  return 'bg-emerald-400';
}

/** Compact token count: 940, 12.3k, 1.2M. */
function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${trimZero(v / 1000)}k`;
  return `${trimZero(v / 1_000_000)}M`;
}

function trimZero(v: number): string {
  return v.toFixed(1).replace(/\.0$/, '');
}

/** USD amount for the meter: 2 decimals, 3 when the amount is under $0.10. */
const fmtCost = (usd: number) => `$${usd.toFixed(usd > 0 && usd < 0.1 ? 3 : 2)}`;
const todayKey = () => new Date().toISOString().slice(0, 10);

/** One provider row: today's spend, tokens and (when configured) its budget. */
interface ProviderRow {
  id: string;
  tokens: number;
  spentUsd: number;
  budgetUsd?: number;
  fraction?: number;
  share: number;
}

function buildProviderRows(today: DayUsage | null, budgets: ProviderBudgetStatus[]): ProviderRow[] {
  const rows = new Map<string, ProviderRow>();
  const totalSpend = today?.costUsd ?? 0;
  if (today) {
    for (const [id, slice] of Object.entries(today.byProvider ?? {})) {
      if (!slice || slice.runs <= 0) continue;
      rows.set(id, {
        id,
        tokens: slice.tokensIn + slice.tokensOut,
        spentUsd: slice.costUsd,
        share: totalSpend > 0 ? slice.costUsd / totalSpend : 0,
      });
    }
  }
  for (const b of budgets) {
    const existing = rows.get(b.id);
    if (existing) {
      existing.budgetUsd = b.budgetUsd;
      existing.fraction = b.fractionUsed;
    } else {
      rows.set(b.id, {
        id: b.id,
        tokens: 0,
        spentUsd: b.spentTodayUsd,
        share: totalSpend > 0 ? b.spentTodayUsd / totalSpend : 0,
        budgetUsd: b.budgetUsd,
        fraction: b.fractionUsed,
      });
    }
  }
  return [...rows.values()].sort((a, b) => b.spentUsd - a.spentUsd || a.id.localeCompare(b.id));
}

/**
 * Inline SVG sparkline. `values` are plotted oldest first; the last point is
 * highlighted as "today". No charting dependency, no layout measurement.
 */
function Sparkline({
  values,
  gradientId,
  muted = false,
}: {
  values: number[];
  gradientId: string;
  muted?: boolean;
}) {
  const max = Math.max(...values, 0);
  const count = values.length;
  const plotW = SPARK_W - SPARK_PAD * 2;
  const stepX = count > 1 ? plotW / (count - 1) : 0;
  const points = values.map((v, i) => {
    const x = count > 1 ? SPARK_PAD + i * stepX : SPARK_W / 2;
    const y =
      muted || max <= 0
        ? SPARK_H / 2
        : SPARK_H - 2 - (v / max) * (SPARK_H - 5);
    return { x, y };
  });
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
  const area = points.length > 0 ? `${line} L${SPARK_W - SPARK_PAD} ${SPARK_H} L${SPARK_PAD} ${SPARK_H} Z` : '';
  const last = points[points.length - 1];
  const stroke = muted ? 'rgba(255,255,255,0.28)' : 'rgba(103,232,249,0.95)';

  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className="h-9 w-28 overflow-visible"
      role="img"
      aria-label={muted ? 'No usage trend yet' : 'Spend over the last 7 days'}
      data-testid="usage-sparkline"
    >
      {!muted && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(103,232,249,0.35)" />
            <stop offset="100%" stopColor="rgba(103,232,249,0)" />
          </linearGradient>
        </defs>
      )}
      {!muted && area !== '' && <path d={area} fill={`url(#${gradientId})`} stroke="none" />}
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={muted ? '3 3' : undefined}
        vectorEffect="non-scaling-stroke"
      />
      {last && !muted && (
        <circle cx={last.x} cy={last.y} r={2} fill="rgba(103,232,249,1)" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}

export function UsageMeter({ runId, runCostUsd }: { runId?: string; runCostUsd?: number }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [budgets, setBudgets] = useState<ProviderBudgetStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const gradientId = `usage-spark-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/runtime/usage?days=7&limit=1');
        if (!res.ok) {
          if (!cancelled) setLoaded(true);
          return;
        }
        const body = (await res.json()) as UsageReport;
        if (cancelled) return;
        setReport(body);
        setBudgets(Array.isArray(body.budgets) ? body.budgets : []);
        setLoaded(true);
      } catch {
        // Unreachable endpoint: leave the meter empty rather than erroring.
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId]);

  const days = lastSevenDayKeys();
  const byDate = new Map((report?.days ?? []).map((d) => [d.date, d]));
  const week = days.map((key) => byDate.get(key) ?? null);
  const today = byDate.get(todayKey()) ?? null;

  const hasUsage = (report?.totals?.runs ?? 0) > 0;
  const weekSpend = week.reduce((sum, d) => sum + (d?.costUsd ?? 0), 0);
  const weekTokens = week.reduce((sum, d) => sum + (d?.tokensIn ?? 0) + (d?.tokensOut ?? 0), 0);
  const metric: 'spend' | 'tokens' = weekSpend > 0 ? 'spend' : 'tokens';
  const sparkValues =
    metric === 'spend'
      ? week.map((d) => d?.costUsd ?? 0)
      : week.map((d) => (d?.tokensIn ?? 0) + (d?.tokensOut ?? 0));
  const weekTotal = metric === 'spend' ? weekSpend : weekTokens;

  const spendToday = today?.costUsd ?? 0;
  const costKnown = (today?.runsWithCost ?? 0) > 0;
  const rows = buildProviderRows(today, budgets);

  if (loaded && !hasUsage) {
    const unavailable = report === null;
    return (
      <div
        data-testid="usage-empty"
        className="mb-5 flex items-center gap-4 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-4 font-mono text-[10.5px] text-white/40"
      >
        <Sparkles className="h-4 w-4 shrink-0 text-cyan-300/50" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-white/60">{unavailable ? 'Usage data unavailable' : 'No usage yet'}</div>
          <div className="mt-0.5 text-[10px] leading-relaxed text-white/30">
            {unavailable
              ? 'The usage endpoint did not answer — the meter retries every minute.'
              : 'Run a prompt and today\u2019s spend, tokens and provider budgets will show up here.'}
          </div>
        </div>
        <Sparkline values={sparkValues} gradientId={gradientId} muted />
      </div>
    );
  }

  return (
    <div
      data-testid="usage-meter"
      className="mb-5 rounded-2xl border border-white/10 bg-[#0a0a0f]/70 px-4 py-3.5 font-mono text-[10.5px] text-white/40"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        {/* headline: today's spend */}
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-white/30">spend today</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span
              data-testid="usage-spend-today"
              className="text-[30px] font-light leading-none tracking-tight text-white/90 tabular-nums"
            >
              {costKnown ? fmtCost(spendToday) : '—'}
            </span>
            <span className="text-[10px] text-white/30">
              {costKnown
                ? `${today?.runs ?? 0} run${today?.runs === 1 ? '' : 's'} today`
                : today
                  ? 'no cost reported yet'
                  : 'no runs yet today'}
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]">
            <span>
              tokens <span className="text-white/75">{fmtTokens((today?.tokensIn ?? 0) + (today?.tokensOut ?? 0))}</span>
            </span>
            <span className="text-white/30">
              {fmtTokens(today?.tokensIn ?? 0)} in · {fmtTokens(today?.tokensOut ?? 0)} out
              {(today?.tokensCached ?? 0) > 0 ? ` · ${fmtTokens(today?.tokensCached ?? 0)} cached` : ''}
            </span>
          </div>
          {runCostUsd !== undefined && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-white/40">
              <span className="uppercase tracking-widest text-white/30">this run</span>
              <span data-testid="usage-run-cost" className="text-white/80 tabular-nums">${runCostUsd.toFixed(3)}</span>
            </div>
          )}
        </div>

        {/* 7-day trend */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-widest text-white/30">last 7 days</div>
            <div className="mt-0.5 text-sm text-white/70 tabular-nums">
              {metric === 'spend' ? fmtCost(weekTotal) : fmtTokens(weekTotal)}
              <span className="ml-1 text-[10px] text-white/30">{metric === 'spend' ? 'spend' : 'tokens'}</span>
            </div>
          </div>
          <Sparkline values={sparkValues} gradientId={gradientId} />
        </div>
      </div>

      {/* per-provider budgets */}
      {rows.length > 0 && (
        <div className="mt-3.5 space-y-2 border-t border-white/5 pt-3">
          <div className="text-[10px] uppercase tracking-widest text-white/30">provider budgets</div>
          {rows.map((row) => {
            const hasBudget = row.budgetUsd !== undefined && row.fraction !== undefined;
            const fraction = row.fraction ?? 0;
            const width = hasBudget ? Math.min(100, Math.max(0, fraction * 100)) : Math.min(100, Math.max(0, row.share * 100));
            return (
              <div key={row.id} className="flex items-center gap-3">
                <span className="w-16 shrink-0 truncate text-white/55 sm:w-20" title={row.id}>
                  {row.id}
                </span>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    data-testid="usage-budget-bar"
                    data-provider={row.id}
                    className={`h-full rounded-full ${hasBudget ? budgetBarColor(fraction) : 'bg-white/25'}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
                <span className="w-32 shrink-0 text-right text-[10px] text-white/55 tabular-nums sm:w-40">
                  {hasBudget ? (
                    <>
                      <span
                        className={
                          fraction >= 1
                            ? 'text-red-300/90'
                            : fraction >= BUDGET_WARN_PCT
                              ? 'text-amber-300/90'
                              : 'text-emerald-300/80'
                        }
                      >
                        {fmtCost(row.spentUsd)} / {fmtCost(row.budgetUsd ?? 0)}
                      </span>
                      {' · '}
                      {Math.round(fraction * 100)}%
                    </>
                  ) : (
                    <>
                      {fmtCost(row.spentUsd)} · {fmtTokens(row.tokens)} tok
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
