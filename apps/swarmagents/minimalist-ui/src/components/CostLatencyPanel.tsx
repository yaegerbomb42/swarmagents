import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Coins, AlertTriangle, CirclePause } from 'lucide-react';
import {
  aggregateRunCostLatency,
  expectedNextCallUsd,
  projectRunBudget,
  BUDGET_WARN_FRACTION,
  type CostEvent,
  type RunCostLatency,
} from '../../../lib/telemetry/cost-latency';
import type { RunStreamItem } from '../../../lib/client/useRunStream';

/**
 * CostLatencyPanel — live $ per run and per provider, tokens, and the
 * per-call latency waterfall (queued -> first token -> complete) for the run
 * in the Telemetry drawer, plus the run's budget bar against
 * `perRunBudgetUsd` (Settings → Providers → Router): a warning at 80% of the
 * cap, and at 100% a pause with a Continue / Stop question.
 *
 * Numbers are derived live from the run's SSE stream (the same recorded
 * telemetry log the server of record sees), and refreshed against
 * GET /api/runtime/cost?runId=… so the budget cap and a pending "continue?"
 * decision stay authoritative. Continue / Stop go to POST /api/runtime/budget.
 */

/** Where a gateway event's payload lives: one level under the sequenced event. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function streamEvents(items: readonly RunStreamItem[]): CostEvent[] {
  return items.map((it) => {
    const parsed = isRecord(it.data) ? it.data : undefined;
    return {
      ...(parsed ?? {}),
      type: typeof parsed?.type === 'string' ? (parsed.type as string) : it.kind,
      seq: typeof parsed?.seq === 'number' ? (parsed.seq as number) : it.seq,
      ts: typeof parsed?.ts === 'number' ? (parsed.ts as number) : it.ts,
    } as CostEvent;
  });
}

interface PendingBudget {
  id: string;
  status: string;
  spentUsd: number;
  limitUsd: number;
  projectedUsd: number;
  expiresAt: number;
}

interface BudgetResponse {
  runId: string;
  report: RunCostLatency;
  budget: {
    limitUsd: number | null;
    spentUsd: number;
    projectedUsd: number;
    fraction: number | null;
    status: 'uncapped' | 'ok' | 'warn' | 'exceeded';
    expectedNextCallUsd: number;
  };
  pending: PendingBudget | null;
}

const fmtCost = (usd: number) => `$${usd.toFixed(usd > 0 && usd < 0.1 ? 3 : 2)}`;
const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtTokens = (n: number) => {
  const v = Number.isFinite(n) ? n : 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
};
const pctOf = (part: number, total: number) => (total > 0 ? (100 * part) / total : 0);

/** Budget bar color: emerald < 80%, amber from 80%, red at 100%. */
function budgetColor(fraction: number | null): string {
  if (fraction === null) return 'bg-white/25';
  if (fraction >= 1) return 'bg-red-500';
  if (fraction >= BUDGET_WARN_FRACTION) return 'bg-amber-400';
  return 'bg-emerald-400';
}

function budgetTextColor(status: BudgetResponse['budget']['status']): string {
  if (status === 'exceeded') return 'text-red-300/90';
  if (status === 'warn') return 'text-amber-300/90';
  return 'text-emerald-300/80';
}

/** One provider row: ok calls, tokens, spend and mean time to first token. */
function ProviderRow({ row }: { row: RunCostLatency['byProvider'][number] }) {
  return (
    <div data-testid="cost-provider-row" className="flex items-center gap-2 text-[10.5px]">
      <span className="w-20 shrink-0 truncate text-white/55 sm:w-24" title={row.provider}>
        {row.provider}
      </span>
      <span className="shrink-0 tabular-nums text-white/35">
        {row.okCalls}/{row.calls} ok
      </span>
      <span className="hidden shrink-0 tabular-nums text-white/35 sm:inline">
        {fmtTokens(row.tokensIn)} in · {fmtTokens(row.tokensOut)} out
      </span>
      <span className="ml-auto shrink-0 tabular-nums text-white/75">{fmtCost(row.costUsd)}</span>
      <span className="w-16 shrink-0 text-right tabular-nums text-white/35">
        {row.avgTtftMs !== undefined ? `${Math.round(row.avgTtftMs)}ms ttft` : row.calls > 0 ? fmtMs(row.avgLatencyMs) : '—'}
      </span>
    </div>
  );
}

/** One call in the latency waterfall: queued -> first token -> complete. */
function WaterfallRow({ call }: { call: RunCostLatency['calls'][number] }) {
  const queue = Math.max(0, call.queuedMs);
  const ttft = call.ttftMs;
  const complete = Math.max(0, call.latencyMs - (ttft ?? 0));
  const total = queue + call.latencyMs;
  const queuePct = pctOf(queue, total);
  const ttftPct = ttft !== undefined ? pctOf(ttft, total) : 0;
  const restPct = ttft !== undefined ? pctOf(complete, total) : 100 - queuePct - ttftPct;
  const failed = call.outcome !== 'ok';
  return (
    <div data-testid="latency-waterfall-row" className="space-y-0.5">
      <div className="flex items-center justify-between gap-2 text-[9.5px] leading-tight">
        <span className="min-w-0 truncate text-white/55">
          <span className="text-white/30">#{call.seq}</span> {call.provider}
          <span className="text-white/30"> · {call.model}</span>
          {failed && <span className={call.outcome === '429' ? 'text-amber-300/80' : 'text-rose-300/80'}> · {call.outcome}</span>}
        </span>
        <span className="shrink-0 tabular-nums text-white/40">
          {fmtMs(queue)} queued{ttft !== undefined ? ` · ${fmtMs(ttft)} ttft` : ''} · {fmtMs(call.latencyMs)} total
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-white/5" title="queued → first token → complete">
        <span style={{ width: `${queuePct}%` }} className="h-full bg-white/20" />
        {ttft !== undefined && <span style={{ width: `${ttftPct}%` }} className="h-full bg-cyan-400/50" />}
        <span style={{ width: `${restPct}%` }} className={`h-full ${failed ? 'bg-rose-400/70' : 'bg-cyan-400'}`} />
      </div>
    </div>
  );
}

export function CostLatencyPanel({ runId, items }: { runId?: string; items: readonly RunStreamItem[] }) {
  const [open, setOpen] = useState(true);
  const [budget, setBudget] = useState<BudgetResponse | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<'continue' | 'stop' | null>(null);

  const report = useMemo(
    () => aggregateRunCostLatency(runId ?? 'live', streamEvents(items)),
    [runId, items],
  );

  const refresh = useCallback(async () => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/runtime/cost?runId=${encodeURIComponent(runId)}`);
      if (!res.ok) {
        setBudget(null);
        return;
      }
      const body = (await res.json()) as BudgetResponse;
      setBudget(body);
      setBudgetError(null);
    } catch {
      // Unreachable: keep showing the live, stream-derived numbers.
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return undefined;
    void refresh();
    const id = setInterval(() => void refresh(), 2500);
    return () => clearInterval(id);
  }, [runId, refresh]);

  const decide = async (decision: 'continue' | 'stop') => {
    if (!runId || deciding) return;
    setDeciding(decision);
    try {
      const res = await fetch('/api/runtime/budget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, decision }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setBudgetError(body?.error ?? `Could not send the decision (HTTP ${res.status}).`);
      } else {
        setBudgetError(null);
        setBudget((prev) => (prev ? { ...prev, pending: null } : prev));
        await refresh();
      }
    } catch {
      setBudgetError('The budget endpoint is unreachable.');
    } finally {
      setDeciding(null);
    }
  };

  // Projection: prefer the live, stream-derived spend with the cap from the
  // server (the cap is the authority; the stream is the live feed).
  const limitUsd = budget?.budget.limitUsd ?? null;
  const projection = useMemo(
    () => projectRunBudget({ spentUsd: report.costUsd, limitUsd, expectedNextCallUsd: expectedNextCallUsd(report) }),
    [report, limitUsd],
  );
  const pending = budget?.pending ?? null;
  const fraction = projection.fraction;
  const barWidth = fraction === null ? 0 : Math.min(100, Math.max(0, fraction * 100));

  const calls = report.calls;
  const hasData = calls.length > 0 || report.costUsd > 0 || report.tokensIn + report.tokensOut > 0;
  const avgTtft = useMemo(() => {
    const ttfts = calls.filter((c) => c.ttftMs !== undefined).map((c) => c.ttftMs as number);
    return ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : undefined;
  }, [calls]);

  return (
    <div
      data-testid="cost-latency-panel"
      className="mb-5 rounded-2xl border border-white/10 bg-[#0a0a0f]/70 px-4 py-3 font-mono text-[10.5px] text-white/40"
    >
      {/* header: always visible; click to expand / collapse */}
      <button
        type="button"
        data-testid="cost-latency-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 text-[10px] uppercase tracking-widest text-white/35">
          <Coins size={12} className="shrink-0 text-cyan-300/70" />
          <span className="truncate">cost &amp; latency · this run</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span data-testid="run-cost" className="tabular-nums text-[11px] normal-case text-white/70">
            {report.costSource === 'none' ? '—' : fmtCost(report.costUsd)}
          </span>
          <ChevronDown size={14} className={`text-white/40 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="mt-2.5">
          {/* headline stats */}
          <div data-testid="cost-latency-stats" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px]">
            <span>
              spend{' '}
              <span className="text-white/80 tabular-nums">
                {report.costSource === 'none' ? '—' : fmtCost(report.costUsd)}
              </span>
            </span>
            <span>
              tokens{' '}
              <span className="tabular-nums text-white/80">
                {report.tokensIn.toLocaleString()} in · {report.tokensOut.toLocaleString()} out
              </span>
              {report.tokensCached > 0 && (
                <span className="text-white/35"> · {report.tokensCached.toLocaleString()} cached</span>
              )}
            </span>
            {calls.length > 0 && (
              <span>
                calls <span className="tabular-nums text-white/80">{calls.length}</span>
              </span>
            )}
            {avgTtft !== undefined && (
              <span>
                avg ttft <span className="tabular-nums text-white/80">{fmtMs(avgTtft)}</span>
              </span>
            )}
          </div>

          {/* per-run budget */}
          {budget !== null || limitUsd !== null ? (
            <div data-testid="run-budget" className="mt-2.5 border-t border-white/5 pt-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[9.5px] uppercase tracking-widest text-white/30">
                <span>per-run budget · perRunBudgetUsd</span>
                <span className="tabular-nums normal-case tracking-normal text-white/45">
                  {limitUsd === null
                    ? 'no cap set'
                    : `${fmtCost(projection.spentUsd)} of ${fmtCost(limitUsd)} · ${Math.round((fraction ?? 0) * 100)}%`}
                </span>
              </div>
              {limitUsd !== null && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    data-testid="run-budget-bar"
                    className={`h-full rounded-full ${budgetColor(fraction)}`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              )}

              {projection.status === 'warn' && (
                <div
                  data-testid="budget-warning"
                  className="mt-2 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-[10.5px] leading-snug text-amber-200/90"
                >
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>
                    Projected spend of {fmtCost(projection.projectedUsd)} is over 80% of this run&rsquo;s{' '}
                    {fmtCost(limitUsd ?? 0)} per-run budget. At 100% the agent pauses and asks you first.
                  </span>
                </div>
              )}
              {projection.status === 'exceeded' && !pending && (
                <div
                  data-testid="budget-exceeded"
                  className="mt-2 rounded-lg border border-rose-400/30 bg-rose-400/10 px-2.5 py-1.5 text-[10.5px] leading-snug text-rose-200/90"
                >
                  Projected spend of {fmtCost(projection.projectedUsd)} is over this run&rsquo;s{' '}
                  {fmtCost(limitUsd ?? 0)} per-run budget.
                </div>
              )}

              {pending && (
                <div data-testid="budget-pause" className="mt-2 rounded-xl border border-rose-400/30 bg-rose-400/10 p-3">
                  <div className="flex items-center gap-2 text-[11px] text-rose-100">
                    <CirclePause size={13} className="shrink-0" />
                    <span>
                      Budget reached — {fmtCost(pending.spentUsd)} of {fmtCost(pending.limitUsd)} spent. The
                      agent is paused.
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] leading-snug text-white/45">
                    Continuing lifts the per-run cap for the rest of this run. The daily cap still applies.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid="budget-continue"
                      disabled={deciding !== null}
                      onClick={() => void decide('continue')}
                      className="rounded-full bg-emerald-400/15 px-3 py-1.5 text-[10.5px] font-medium text-emerald-200 ring-1 ring-inset ring-emerald-400/40 transition hover:bg-emerald-400/25 disabled:opacity-50"
                    >
                      {deciding === 'continue' ? 'Resuming…' : 'Continue anyway'}
                    </button>
                    <button
                      type="button"
                      data-testid="budget-stop"
                      disabled={deciding !== null}
                      onClick={() => void decide('stop')}
                      className="rounded-full bg-rose-400/15 px-3 py-1.5 text-[10.5px] font-medium text-rose-200 ring-1 ring-inset ring-rose-400/40 transition hover:bg-rose-400/25 disabled:opacity-50"
                    >
                      {deciding === 'stop' ? 'Stopping…' : 'Stop the run'}
                    </button>
                  </div>
                  {budgetError && <div className="mt-2 text-[10px] text-rose-300/90">{budgetError}</div>}
                </div>
              )}
            </div>
          ) : null}

          {/* providers */}
          {report.byProvider.length > 0 && (
            <div className="mt-2.5 border-t border-white/5 pt-2.5">
              <div className="mb-1.5 text-[9.5px] uppercase tracking-widest text-white/30">by provider</div>
              <div data-testid="cost-provider-rows" className="space-y-1">
                {report.byProvider.map((row) => (
                  <ProviderRow key={row.provider} row={row} />
                ))}
              </div>
            </div>
          )}

          {/* latency waterfall */}
          {calls.length > 0 && (
            <div className="mt-2.5 border-t border-white/5 pt-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2 text-[9.5px] uppercase tracking-widest text-white/30">
                <span>latency waterfall</span>
                <span className="tabular-nums normal-case tracking-normal text-white/30">queued → ttft → complete</span>
              </div>
              <div data-testid="latency-waterfall" className="space-y-1.5">
                {calls.slice(-6).map((call) => (
                  <WaterfallRow key={`${call.seq}-${call.ts}`} call={call} />
                ))}
              </div>
            </div>
          )}

          {/* model switch timeline */}
          {report.modelSwitches.length > 0 && (
            <div className="mt-2.5 border-t border-white/5 pt-2.5">
              <div className="mb-1.5 text-[9.5px] uppercase tracking-widest text-white/30">model switches</div>
              <div data-testid="model-switches" className="flex flex-wrap gap-1.5">
                {report.modelSwitches.map((s, i) => (
                  <span
                    key={`${s.ts}-${i}`}
                    data-testid="model-switch"
                    className="inline-flex items-center gap-1.5 rounded-full bg-violet-400/10 px-2 py-1 text-[9.5px] text-violet-200/90 ring-1 ring-inset ring-violet-400/25"
                    title={new Date(s.ts).toLocaleTimeString()}
                  >
                    <span className="text-white/40">{s.fromProvider}/{s.fromModel}</span>
                    →
                    <span>{s.toProvider}/{s.toModel}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* empty + provenance */}
          {!hasData && (
            <div className="mt-2.5 rounded-xl border border-dashed border-white/10 px-3 py-3 text-center text-[10px] text-white/30">
              No provider calls recorded for this run yet — the panel fills in as soon as the agent talks to a provider.
            </div>
          )}
          {report.costSource === 'run_finished' && (
            <div className="mt-2 text-[9px] leading-snug text-white/25">
              Cost shown from the run&rsquo;s reported total ({fmtCost(report.costUsd)}); no provider reported a per-call price.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
