import { formatHedgeLine, type RaceReport } from '../../../lib/arena/race';

const fmtMs = (ms?: number) =>
  ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
const fmtUsd = (usd?: number) => (usd == null ? '—' : `$${usd.toFixed(3)}`);

/**
 * Live hedge/racing telemetry for a RaceReport. Renders the router's
 * "stalled → hedged → won → saved" narrative plus a per-participant breakdown
 * (provider/model, first-token timing, total latency, cost) so the
 * multi-provider key pool is visible rather than invisible plumbing.
 *
 * Pure presentational component: it takes a RaceReport (from lib/arena/race)
 * and renders it. Mount it where race data flows (e.g. run reports or the
 * arena battle result overlay); it renders nothing when no report is given.
 */
export function HedgeTelemetry({ report }: { report?: RaceReport | null }) {
  if (!report || report.participants.length === 0) return null;
  const headline = formatHedgeLine(report);
  return (
    <div
      data-testid="hedge-telemetry"
      className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
    >
      <div className="mb-2 text-[10px] uppercase tracking-widest text-white/30">Race / hedge</div>
      <div className="font-mono text-[11px] leading-relaxed text-white/80">{headline}</div>
      <div className="mt-3 space-y-1.5">
        {report.participants.map((p, i) => (
          <div key={i} className="flex items-center gap-3 font-mono text-[10px] text-white/50">
            <span
              className={`w-2 h-2 shrink-0 rounded-full ${
                p.status === 'winner'
                  ? 'bg-emerald-400'
                  : p.status === 'failed'
                    ? 'bg-rose-400'
                    : 'bg-white/40'
              }`}
            />
            <span className="min-w-0 flex-1 truncate">
              {p.provider}
              {p.model ? <span className="text-white/30"> {p.model}</span> : null}
            </span>
            <span className="shrink-0">{p.status}</span>
            <span className="shrink-0 text-white/35">{fmtMs(p.firstTokenMs)}</span>
            <span className="shrink-0">{fmtMs(p.latencyMs)}</span>
            <span className="shrink-0 text-white/35">{fmtUsd(p.costUsd)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
