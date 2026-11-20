import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { ActiveRole, Attachment } from '../data';
import type { AgentState, LogEvent } from '../engine';
import { RoleIcon } from './RoleIcon';
import { useRunStream } from '../../../lib/client/useRunStream';
import { reduceRunTimeline, pendingApprovals, redactEventData, slowestTools, type ToolCallEntry, type RunSummary } from '../../../lib/client/runTimeline';
import { UsageMeter } from './UsageMeter';
import { CostLatencyPanel } from './CostLatencyPanel';
import { ApprovalGate } from './ApprovalGate';

const fmt = (ms?: number) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

const summarize = (v: unknown) => {
  if (v == null) return '';
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 280 ? `${text.slice(0, 280)}…` : text;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Where a gateway event's payload lives: the SSE `data:` field is the whole
 * sequenced event ({type, data, seq, runId, ts}), so gateway events nest one
 * level deeper than harness events. Accept both shapes.
 */
const payloadOf = (item: { data?: unknown }): Record<string, unknown> => {
  if (!isRecord(item.data)) return {};
  return isRecord(item.data.data) ? (item.data.data as Record<string, unknown>) : (item.data as Record<string, unknown>);
};

/** Event-type chip groups shown as filters over the raw run stream. */
type EventGroup = 'run' | 'vm' | 'tool' | 'assistant' | 'approval' | 'checkpoint' | 'error';
const EVENT_GROUPS: EventGroup[] = ['run', 'vm', 'tool', 'assistant', 'approval', 'checkpoint', 'error'];

const GROUP_STYLE: Record<EventGroup, string> = {
  run: 'bg-cyan-400/10 text-cyan-300 ring-cyan-400/25',
  vm: 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/25',
  tool: 'bg-amber-400/10 text-amber-300 ring-amber-400/25',
  assistant: 'bg-sky-400/10 text-sky-300 ring-sky-400/25',
  approval: 'bg-violet-400/10 text-violet-300 ring-violet-400/25',
  checkpoint: 'bg-teal-400/10 text-teal-300 ring-teal-400/25',
  error: 'bg-rose-400/10 text-rose-300 ring-rose-400/25',
};

/** Map a stream event kind onto its filter chip (run/vm/tool/assistant/approval/checkpoint/error). */
const classifyEvent = (kind: string): EventGroup => {
  if (kind.startsWith('vm.')) return kind === 'vm.error' ? 'error' : 'vm';
  if (kind.startsWith('run.')) return kind === 'run.error' ? 'error' : 'run';
  if (kind.startsWith('tool.')) return 'tool';
  if (kind.startsWith('assistant.')) return 'assistant';
  if (kind.startsWith('approval.')) return 'approval';
  if (kind.startsWith('checkpoint.')) return 'checkpoint';
  return 'run';
};

/** One-line human summary for an event row, derived from its payload. */
const eventSummary = (data: unknown): string => {
  if (!isRecord(data)) return typeof data === 'string' ? summarize(data) : '';
  if (isRecord(data) && (typeof data.framework === 'string' || data.linesPct !== undefined) && (Array.isArray(data.files) || Array.isArray(data.uncoveredRanges))) {
    const framework = typeof data.framework === 'string' ? data.framework : 'coverage';
    const lp = typeof data.linesPct === 'number' ? `${data.linesPct.toFixed(1)}%` : data.linesPct == null ? 'n/a' : String(data.linesPct);
    const files = Array.isArray(data.files) ? data.files.length : 0;
    const uncovered = Array.isArray(data.uncoveredRanges) ? data.uncoveredRanges.length : 0;
    return `${framework} · lines ${lp} · files ${files} · uncovered ${uncovered}`;
  }
  const parts: string[] = [];
  if (isRecord(data.from) && isRecord(data.to)) {
    const from = typeof data.from.name === 'string' ? data.from.name : String(data.from.provider ?? data.from.id ?? '');
    const to = typeof data.to.name === 'string' ? data.to.name : String(data.to.provider ?? data.to.id ?? '');
    if (from || to) parts.push(`${from || '?'} → ${to || '?'}`);
  }
  for (const key of ['name', 'model', 'message', 'text', 'action', 'tool', 'verdict', 'reason']) {
    if (typeof data[key] === 'string') parts.push(data[key] as string);
  }
  if (typeof data.inputTokens === 'number' || typeof data.outputTokens === 'number') {
    parts.push(`${String(data.inputTokens ?? 0)} in / ${String(data.outputTokens ?? 0)} out`);
  }
  if (typeof data.exitCode === 'number') parts.push(`exit ${data.exitCode}`);
  if (typeof data.durationMs === 'number') parts.push(fmt(data.durationMs));
  return summarize(parts.join(' · '));
};

/** Relative wall-clock offset, e.g. "+0.4s" / "+2m05s". */
const relTime = (ts: number, base: number) => {
  const ms = Math.max(0, ts - base);
  if (ms < 1000) return `+${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `+${s.toFixed(1)}s`;
  return `+${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
};

function useNow(active: boolean) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Telemetry view.
 *
 * When a real runtime run is active (`runId`), this renders a timeline derived
 * from the run's SSE stream via useRunStream: tool calls with durations and
 * ok/error, usage token totals, and final cost from run.finished. Without a
 * runId it falls back to the simulated multi-agent view (`states`/`logs`).
 */
export function Telemetry({
  roles,
  states,
  logs,
  busy,
  runStart,
  runEnd,
  prompt,
  promptAtts,
  runId,
}: {
  roles: ActiveRole[];
  states: Record<string, AgentState>;
  logs: LogEvent[];
  busy: boolean;
  runStart?: number;
  runEnd?: number;
  prompt?: string;
  promptAtts: Attachment[];
  runId?: string;
}) {
  const now = useNow(busy || Boolean(runId));
  const stream = useRunStream(runId);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const hasRun = runStart != null;

  if (!hasRun) {
    return (
      <div className="flex flex-col items-center gap-8 text-center">
        <div className="flex -space-x-2">
          {roles.map((r, i) => (
            <div
              key={r.uid}
              className="grid h-11 w-11 place-items-center rounded-full ring-1 ring-white/15 backdrop-blur-xl"
              style={{
                background: `hsl(${r.hue} 70% 60% / .12)`,
                color: `hsl(${r.hue} 80% 75%)`,
                animation: `float 4s ease-in-out ${i * 0.25}s infinite`,
              }}
              title={r.name}
            >
              <RoleIcon name={r.icon} className="h-[18px] w-[18px]" />
            </div>
          ))}
        </div>
        <div>
          <h1 className="text-3xl font-light tracking-tight text-white/90 sm:text-4xl">{roles.length} agents standing by</h1>
          <p className="mt-2 text-sm text-white/40">Type, drop files, images or video below. Telemetry streams here.</p>
        </div>
      </div>
    );
  }

  // A real runtime run owns the view; the simulated fallback below only
  // renders when no run is streaming.
  if (runId) {
    return <RealTimeTelemetry runId={runId} streamStatus={stream.status} items={stream.items} streamError={stream.error} prompt={prompt} promptAtts={promptAtts} now={now} openTool={openTool} onOpenTool={setOpenTool} />;
  }

  const list = roles.map((r) => ({ r, s: states[r.uid] })).filter((x) => x.s);
  const totalOut = list.reduce((a, x) => a + (x.s.tokens || 0), 0);
  const totalIn = list.reduce((a, x) => a + (x.s.inTokens || 0), 0);
  const done = list.filter((x) => x.s.status === 'done' || x.s.status === 'error').length;
  const elapsed = (runEnd ?? now) - (runStart ?? now);
  const openItem = list.find((x) => x.r.uid === openTool);

  return (
    <div className="w-full">
      {/* prompt + summary */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <div className="text-[11px] uppercase tracking-[0.2em] text-white/35">Input</div>
          <div className="mt-1 truncate text-lg font-light text-white/90">{prompt || <span className="text-white/40">(attachments only)</span>}</div>
          {promptAtts.length > 0 && (
            <div className="mt-1 text-xs text-white/40">+ {promptAtts.length} attachment{promptAtts.length > 1 ? 's' : ''}</div>
          )}
        </div>
        <div className="flex gap-6 font-mono text-xs">
          <Stat label="elapsed" value={fmt(elapsed)} />
          <Stat label="agents" value={`${done}/${list.length}`} />
          <Stat label="in" value={totalIn.toLocaleString()} />
          <Stat label="out" value={totalOut.toLocaleString()} />
        </div>
      </div>

      <UsageMeter runId={runId} />

      {/* progress */}
      <div className="mb-5 h-px w-full overflow-hidden bg-white/10">
        <div className="h-full bg-white/70 transition-all duration-500" style={{ width: `${(done / Math.max(1, list.length)) * 100}%` }} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map(({ r, s }) => {
          const end = s.end ?? now;
          const ttft = s.firstToken && s.start ? s.firstToken - s.start : undefined;
          const genMs = s.firstToken ? end - s.firstToken : 0;
          const tps = genMs > 50 ? (s.tokens / genMs) * 1000 : 0;
          const lat = s.start ? end - s.start : undefined;
          const active = s.status === 'thinking' || s.status === 'streaming';
          return (
            <button
              key={r.uid}
              onClick={() => setOpenTool(r.uid)}
              className={`glass-soft group relative overflow-hidden rounded-2xl p-4 text-left transition hover:bg-white/[0.07] ${
                s.status === 'queued' ? 'opacity-50' : ''
              }`}
            >
              {active && (
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 h-px"
                  style={{ background: `linear-gradient(90deg, transparent, hsl(${r.hue} 90% 70%), transparent)`, animation: 'scan 1.6s linear infinite' }}
                />
              )}
              <div className="flex items-center gap-3">
                <div
                  className="grid h-8 w-8 place-items-center rounded-lg"
                  style={{ background: `hsl(${r.hue} 70% 60% / .14)`, color: `hsl(${r.hue} 85% 75%)` }}
                >
                  <RoleIcon name={r.icon} className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-white/90">{r.name}</div>
                  <div className="truncate font-mono text-[10px] text-white/35">{s.model}</div>
                </div>
                <StatusPill status={s.status} hue={r.hue} />
              </div>

              <div className="mt-3 h-[72px] overflow-hidden font-mono text-[11px] leading-relaxed text-white/60 [mask-image:linear-gradient(to_bottom,transparent,black_30%)]">
                <div className="flex h-full flex-col justify-end whitespace-pre-wrap break-words">
                  {s.error ? (
                    <span className="text-red-300/80">{s.error}</span>
                  ) : s.output ? (
                    <span>
                      {s.output.slice(-320)}
                      {s.status === 'streaming' && <span className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-white/70" />}
                    </span>
                  ) : s.status === 'thinking' ? (
                    <span className="text-white/35">reasoning…</span>
                  ) : (
                    <span className="text-white/25">waiting</span>
                  )}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-4 gap-2 border-t border-white/5 pt-3 font-mono text-[10px]">
                <Mini label="ttft" value={fmt(ttft)} />
                <Mini label="lat" value={fmt(lat)} />
                <Mini label="tok" value={String(s.tokens || 0)} />
                <Mini label="tok/s" value={tps ? tps.toFixed(0) : '—'} />
              </div>
            </button>
          );
        })}
      </div>

      {/* log */}
      <div className="mt-5 max-h-28 overflow-y-auto font-mono text-[10.5px] leading-5 text-white/40 scrollbar-none">
        {logs.slice(-40).reverse().map((l, i) => (
          <div key={i} className="flex gap-3">
            <span className="w-14 shrink-0 text-white/25">+{fmt(l.t - (runStart ?? 0))}</span>
            <span style={{ color: `hsl(${l.hue} 80% 72%)` }} className="w-24 shrink-0 truncate">
              {l.agent}
            </span>
            <span className="truncate">{l.msg}</span>
          </div>
        ))}
      </div>

      {openItem && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setOpenTool(null)}>
          <div className="glass max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
              <RoleIcon name={openItem.r.icon} className="h-4 w-4 text-white/70" />
              <div className="flex-1 text-sm text-white/90">{openItem.r.name}</div>
              <span className="font-mono text-[10px] text-white/40">{openItem.s.model}</span>
              <button onClick={() => setOpenTool(null)} className="rounded-full p-1 text-white/50 hover:bg-white/10 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto whitespace-pre-wrap px-5 py-4 text-sm leading-relaxed text-white/80">
              {openItem.s.error || openItem.s.output || '…'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RealTimeTelemetry({
  runId,
  streamStatus,
  items,
  streamError,
  prompt,
  promptAtts,
  now,
  openTool,
  onOpenTool,
}: {
  runId?: string;
  streamStatus: ReturnType<typeof useRunStream>['status'];
  items: ReturnType<typeof useRunStream>['items'];
  streamError?: string;
  prompt?: string;
  promptAtts: Attachment[];
  now: number;
  openTool: string | null;
  onOpenTool: (id: string | null) => void;
}) {
  const { tools, summary, approvals } = reduceRunTimeline(items);
  const awaitingApproval = pendingApprovals(approvals).length > 0;
  const live = summary.finishedAt === undefined;
  const elapsed = summary.durationMs ?? (now - (summary.startedAt ?? now));
  const openEntry = tools.find((t) => t.id === openTool);
  const slowest = slowestTools(tools, 5);

  // Event-type filter chips (local UI state) + per-row expandable JSON.
  const [hiddenGroups, setHiddenGroups] = useState<Set<EventGroup>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleGroup = (g: EventGroup) =>
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  const toggleExpanded = (seq: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  const eventRows = items.map((it) => ({ it, group: classifyEvent(it.kind) }));
  const visibleEvents = eventRows.filter((e) => !hiddenGroups.has(e.group));
  const counts = EVENT_GROUPS.reduce<Record<string, number>>((acc, g) => {
    acc[g] = eventRows.filter((e) => e.group === g).length;
    return acc;
  }, {});
  const baseTs = items[0]?.ts ?? Date.now();

  // Gateway telemetry: one chip per LLM provider attempt (see
  // lib/runtime/llm-gateway.ts). Only ok calls carry a cost estimate; a run's
  // cost is the sum of its ok calls. Failover arrows connect failed attempts
  // to the next one.
  const llmCalls = items.filter((it) => it.kind === 'llm.call');
  // Router telemetry (lib/runtime/llm-routing.ts): why each provider was
  // picked, sticky-provider failovers and output-quality demotions.
  const routeDecisions = items.filter((it) => it.kind === 'route.decision');
  const routeNotes = items.filter((it) => it.kind === 'route.failover' || it.kind === 'route.demoted');
  const lastDecision = routeDecisions.length > 0 ? routeDecisions[routeDecisions.length - 1] : undefined;
  const runCostUsd = llmCalls.reduce((sum, it) => {
    const d = payloadOf(it);
    return d.outcome === 'ok' && typeof d.costUsd === 'number' ? sum + d.costUsd : sum;
  }, 0);

  return (
    <div className="w-full">
      {/* prompt + run stats */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <div className="text-[11px] uppercase tracking-[0.2em] text-white/35">Input</div>
          <div className="mt-1 truncate text-lg font-light text-white/90">{prompt || <span className="text-white/40">(attachments only)</span>}</div>
          {promptAtts.length > 0 && (
            <div className="mt-1 text-xs text-white/40">+ {promptAtts.length} attachment{promptAtts.length > 1 ? 's' : ''}</div>
          )}
        </div>
        <div className="flex gap-6 font-mono text-xs">
          <Stat label="status" value={<RunStateLabel streamStatus={streamStatus} summary={summary} live={live} awaitingApproval={awaitingApproval} />} />
          <Stat label="elapsed" value={fmt(elapsed)} />
          <Stat label="in" value={summary.usageReported ? summary.tokensIn.toLocaleString() : '—'} />
          <Stat label="out" value={summary.usageReported ? summary.tokensOut.toLocaleString() : '—'} />
          <Stat label="cost" value={summary.costUsd != null ? `$${summary.costUsd.toFixed(3)}` : '—'} />
        </div>
      </div>

      <UsageMeter runId={runId} runCostUsd={runCostUsd} />
      <CostLatencyPanel runId={runId} items={items} />

      {/* stream banner */}
      {streamStatus === 'connecting' && <Banner tone="muted">connecting to run stream…</Banner>}
      {streamStatus === 'reconnecting' && <Banner tone="warn">reconnecting to run stream…</Banner>}
      {streamError && streamError !== 'stream closed' && <Banner tone="error">stream error: {streamError}</Banner>}

      {/* pending approval gates: Allow / Deny the agent's flagged actions */}
      <ApprovalGate approvals={approvals} />

      {items.length === 0 ? (
        <div className="glass-soft rounded-2xl p-8 text-center font-mono text-xs text-white/35">awaiting run stream…</div>
      ) : (
        <>
          {/* tool call timeline */}
          <div className="space-y-2">
            {tools.slice().reverse().map((tool) => (
              <button
                key={tool.id}
                onClick={() => onOpenTool(tool.id)}
                className="glass-soft group w-full rounded-2xl p-4 text-left transition hover:bg-white/[0.07]"
              >
                <div className="flex items-center gap-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg font-mono text-[10px] text-amber-300/90 bg-amber-400/10">$</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-amber-200/90">{tool.name}</span>
                  {tool.input != null && <span className="hidden max-w-[40%] truncate font-mono text-[10px] text-white/35 sm:block">{summarize(tool.input)}</span>}
                  <ToolPill tool={tool} />
                  <span className="w-14 text-right font-mono text-[10px] text-white/40">{fmt(tool.durationMs)}</span>
                </div>
                {tool.output != null && tool.output !== '' && (
                  <div className="mt-2 truncate border-t border-white/5 pt-2 font-mono text-[11px] text-white/60">
                    <span className={tool.ok === false ? 'text-rose-300/90' : ''}>{summarize(tool.output)}</span>
                  </div>
                )}
              </button>
            ))}
          </div>

          {/* LLM call chips: which provider served each step, failover arrows,
              latency and estimated cost (see lib/runtime/llm-gateway.ts). */}
          {(llmCalls.length > 0 || routeDecisions.length > 0) && (
            <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-2 text-[10px] uppercase tracking-widest text-white/30">LLM serving</div>
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-2">
                {llmCalls.map((it, i) => {
                  const d = payloadOf(it);
                  const provider = String(d.provider ?? '?');
                  const model = String(d.model ?? '');
                  const latency = typeof d.latencyMs === 'number' ? d.latencyMs : undefined;
                  const cost = typeof d.costUsd === 'number' ? d.costUsd : null;
                  const ok = d.outcome === 'ok';
                  // Lens calls (see lib/lenses) ride on the run's bus too, so
                  // their cost shows up here next to the agent's own calls.
                  const lens = typeof d.lens === 'string' ? d.lens : undefined;
                  const prev = i > 0 ? llmCalls[i - 1] : undefined;
                  const prevData = prev ? payloadOf(prev) : {};
                  const failedBefore = prev !== undefined && prevData.outcome !== 'ok';
                  const label = `${provider} ${model}`.trim();
                  return (
                    <span key={it.seq} className="flex items-center gap-2">
                      {failedBefore && (
                        <span className="text-[12px] leading-none text-white/30" title="failover">➜</span>
                      )}
                      <span
                        data-testid="llm-call-chip"
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] ring-1 ring-inset ${
                          ok
                            ? 'bg-emerald-400/10 text-emerald-300/90 ring-emerald-400/25'
                            : 'bg-amber-400/10 text-amber-300/90 ring-amber-400/25'
                        }`}
                        title={`attempt ${String(d.attempt ?? '')}${!ok ? ` — ${String(d.outcome)}` : ''}`}
                      >
                        <span>{label}</span>
                        {lens && (
                          <span className="rounded-full bg-cyan-400/10 px-1.5 py-px text-cyan-200/80" title="Output lens">
                            lens
                          </span>
                        )}
                        <span className="text-white/35">·</span>
                        <span className="text-white/50">{latency != null ? fmt(latency) : '—'}</span>
                        <span className="text-white/35">·</span>
                        <span className="text-white/60">{cost != null ? `$${cost.toFixed(3)}` : '—'}</span>
                      </span>
                    </span>
                  );
                })}
              </div>
              <RouteSummary decision={lastDecision} notes={routeNotes} />
            </div>
          )}

          {/* slowest tools for this run */}
          {slowest.length > 0 && (
            <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-2 text-[10px] uppercase tracking-widest text-white/30">Slowest tools</div>
              <ol className="space-y-1">
                {slowest.map((tool) => (
                  <li key={tool.id} className="flex items-center gap-3 font-mono text-[11px] text-white/60">
                    <span className="truncate">{tool.name}</span>
                    <span className="ml-auto text-white/40">{fmt(tool.durationMs)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* run summary */}
          <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-4 font-mono text-[10.5px] text-white/40">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              {summary.model && <span>model <span className="text-white/70">{summary.model}</span></span>}
              <span>tokens <span className="text-white/70">{summary.usageReported ? `${summary.tokensIn.toLocaleString()} in / ${summary.tokensOut.toLocaleString()} out` : '—'}</span></span>
              {summary.tokensCached > 0 && <span>cached <span className="text-white/70">{summary.tokensCached.toLocaleString()}</span></span>}
              {summary.numTurns != null && <span>turns <span className="text-white/70">{summary.numTurns}</span></span>}
              {summary.exitCode != null && <span>exit <span className="text-white/70">{summary.exitCode}</span></span>}
              {summary.durationMs != null && <span>duration <span className="text-white/70">{fmt(summary.durationMs)}</span></span>}
              {summary.error && (
                <span className="text-rose-300/90">error: {summary.error}</span>
              )}
              {summary.cancelledReason && (
                <span className="text-amber-300/90">cancelled ({summary.cancelledReason})</span>
              )}
            </div>
          </div>

          {/* raw event stream: type chips + filter row + expandable JSON details */}
          <div className="mt-5">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.2em] text-white/35">Events</span>
              {EVENT_GROUPS.map((g) => (
                <button
                  key={g}
                  data-testid={`telemetry-filter-${g}`}
                  aria-pressed={!hiddenGroups.has(g)}
                  onClick={() => toggleGroup(g)}
                  title={hiddenGroups.has(g) ? `show ${g} events` : `hide ${g} events`}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ring-1 transition ${
                    hiddenGroups.has(g)
                      ? 'bg-transparent text-white/30 ring-white/10 hover:text-white/50'
                      : `ring-inset hover:brightness-125 ${GROUP_STYLE[g]}`
                  }`}
                >
                  {g}
                  {counts[g] > 0 && <span className="ml-1 opacity-60">{counts[g]}</span>}
                </button>
              ))}
            </div>

            {visibleEvents.length === 0 ? (
              <div className="glass-soft rounded-2xl p-8 text-center font-mono text-xs text-white/35">
                {items.length === 0 ? 'awaiting run stream…' : 'no events match the current filters'}
              </div>
            ) : (
              <div className="space-y-1.5">
                {visibleEvents.slice().reverse().map(({ it, group }) => {
                  const isOpen = expanded.has(it.seq);
                  // Raw payload, with internal identifiers (userId) stripped —
                  // the stream carries them for ownership scoping, but they
                  // are not user-facing.
                  const json = typeof it.data === 'string' ? it.data : JSON.stringify(redactEventData(it.data), null, 2) ?? '';
                  // F1 branch points: a checkpoint is a clickable fork origin,
                  // not just another stream row.
                  if (it.kind === 'checkpoint.created' || it.kind === 'checkpoint.failed' || it.kind === 'checkpoint.restored') {
                    return <CheckpointBranchNode key={it.seq} item={it} baseTs={baseTs} runId={runId} />;
                  }
                  if (it.kind === 'coverage.report' && !isOpen) {
                    const d = isRecord(it.data) ? it.data : {};
                    const framework = typeof d.framework === 'string' ? d.framework : 'coverage';
                    const lp = typeof d.linesPct === 'number' ? `${d.linesPct.toFixed(1)}%` : d.linesPct == null ? 'n/a' : String(d.linesPct);
                    const files = Array.isArray(d.files) ? d.files.length : 0;
                    const uncovered = Array.isArray(d.uncoveredRanges) ? (d.uncoveredRanges as unknown[]).map(String) : [];
                    return (
                      <button
                        key={it.seq}
                        data-testid="telemetry-event-row"
                        data-coverage-card="1"
                        onClick={() => toggleExpanded(it.seq)}
                        className="glass-soft w-full rounded-xl px-3 py-2.5 text-left ring-1 ring-cyan-400/20 transition hover:bg-white/[0.07]"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="shrink-0 rounded-full bg-cyan-400/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-cyan-300 ring-1 ring-inset ring-cyan-400/25">coverage</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/85">Coverage report</span>
                          <span className="hidden shrink-0 font-mono text-[10px] text-white/30 sm:block">{relTime(it.ts, baseTs)}</span>
                          <ChevronDown className={`h-3 w-3 shrink-0 text-white/30 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px]">
                          <div><div className="text-white/35">framework</div><div className="text-white/80">{framework}</div></div>
                          <div><div className="text-white/35">lines</div><div className="text-cyan-300">{lp}</div></div>
                          <div><div className="text-white/35">files</div><div className="text-white/80">{files}</div></div>
                        </div>
                        {uncovered.length > 0 && (
                          <div className="mt-1.5 truncate text-[10px] text-white/45">uncovered: {summarize(uncovered.slice(0, 8).join(', '))}</div>
                        )}
                      </button>
                    );
                  }
                  return (
                    <button
                      key={it.seq}
                      data-testid="telemetry-event-row"
                      onClick={() => toggleExpanded(it.seq)}
                      className="glass-soft w-full rounded-xl px-3 py-2 text-left transition hover:bg-white/[0.07]"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide ring-1 ring-inset ${GROUP_STYLE[group]}`}>
                          {group}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/70">{it.kind}</span>
                        <span className="hidden shrink-0 font-mono text-[10px] text-white/30 sm:block">{relTime(it.ts, baseTs)}</span>
                        <ChevronDown className={`h-3 w-3 shrink-0 text-white/30 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </div>
                      {!isOpen && eventSummary(it.data) && (
                        <div className="mt-1 truncate font-mono text-[10px] text-white/35">{eventSummary(it.data)}</div>
                      )}
                      {isOpen && (
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/40 p-2 text-left font-mono text-[10.5px] leading-relaxed text-white/70">
                          {json || '(no payload)'}
                        </pre>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {openEntry && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => onOpenTool(null)}>
          <div className="glass max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
              <span className="grid h-7 w-7 place-items-center rounded-lg font-mono text-[10px] text-amber-300/90 bg-amber-400/10">$</span>
              <div className="flex-1">
                <div className="text-sm text-white/90">{openEntry.name}</div>
                <div className="font-mono text-[10px] text-white/40">{openEntry.id}</div>
              </div>
              <ToolPill tool={openEntry} />
              <span className="font-mono text-[10px] text-white/40">{fmt(openEntry.durationMs)}</span>
              <button onClick={() => onOpenTool(null)} className="rounded-full p-1 text-white/50 hover:bg-white/10 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
              {openEntry.input != null && (
                <>
                  <div className="mb-1 text-[10px] uppercase tracking-widest text-white/30">Input</div>
                  <pre className="mb-4 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-white/80">{summarize(openEntry.input)}</pre>
                </>
              )}
              {openEntry.output != null && (
                <>
                  <div className="mb-1 text-[10px] uppercase tracking-widest text-white/30">Output</div>
                  <pre className={`whitespace-pre-wrap break-words font-mono text-xs leading-relaxed ${openEntry.ok === false ? 'text-rose-300/90' : 'text-white/80'}`}>
                    {openEntry.output}
                  </pre>
                </>
              )}
              {openEntry.input == null && openEntry.output == null && <div className="text-sm text-white/40">…</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * F1 branch point: one auto-checkpoint (`checkpoint.created`) in the run
 * timeline, with its label, step seq, timestamp, and the guarded tool — plus
 * "Fork Run from Here", which spawns a new run seeded from this checkpoint's
 * snapshot with a user-supplied tweaked prompt. The fork is a fresh run
 * (own runId, own snapshot lineage); the original run is untouched.
 * `checkpoint.failed` renders as a warning (the run continued without a
 * branch point) and `checkpoint.restored` as provenance on a forked run.
 */
function CheckpointBranchNode({ item, baseTs, runId }: { item: { seq: number; kind: string; ts: number; data?: unknown }; baseTs: number; runId?: string }) {
  const d = isRecord(item.data) ? item.data : {};
  const label = typeof d.label === 'string' ? d.label : 'checkpoint';
  const stepSeq = typeof d.stepSeq === 'number' ? d.stepSeq : undefined;
  const tool = typeof d.tool === 'string' ? d.tool : undefined;
  const reason = typeof d.reason === 'string' ? d.reason : undefined;
  const error = typeof d.error === 'string' ? d.error : undefined;
  const sourceRunId = typeof d.sourceRunId === 'string' ? d.sourceRunId : undefined;
  const [prompt, setPrompt] = useState('');
  const [forkOpen, setForkOpen] = useState(false);
  const [forking, setForking] = useState(false);
  const [status, setStatus] = useState('');

  const fork = async () => {
    if (!runId) { setStatus('This run cannot be forked from here.'); return; }
    if (stepSeq === undefined) { setStatus('This checkpoint has no step number.'); return; }
    if (!prompt.trim()) { setStatus('Add a tweaked prompt for the fork.'); return; }
    setForking(true); setStatus('');
    try {
      const response = await fetch(`/api/runtime/runs/${encodeURIComponent(runId)}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpointSeq: stepSeq, prompt: prompt.trim() }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; runId?: string };
      if (!response.ok) throw new Error(body.error || 'Could not start the fork.');
      setStatus(`Fork started · ${body.runId ?? 'new run'}`);
      setForkOpen(false);
      setPrompt('');
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setForking(false);
    }
  };

  if (item.kind === 'checkpoint.failed') {
    return (
      <div data-testid="telemetry-checkpoint-failed" className="glass-soft w-full rounded-xl px-3 py-2.5 text-left ring-1 ring-amber-400/25">
        <div className="flex items-center gap-2.5">
          <span className="shrink-0 rounded-full bg-amber-400/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-amber-300 ring-1 ring-inset ring-amber-400/25">checkpoint</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-amber-200/90">Checkpoint {label} failed — the run continued without a branch point</span>
          <span className="hidden shrink-0 font-mono text-[10px] text-white/30 sm:block">{relTime(item.ts, baseTs)}</span>
        </div>
        {error && <div className="mt-1 truncate font-mono text-[10px] text-white/35">{error}</div>}
      </div>
    );
  }

  if (item.kind === 'checkpoint.restored') {
    return (
      <div data-testid="telemetry-checkpoint-restored" className="glass-soft w-full rounded-xl px-3 py-2.5 text-left ring-1 ring-teal-400/25">
        <div className="flex items-center gap-2.5">
          <span className="shrink-0 rounded-full bg-teal-400/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-teal-300 ring-1 ring-inset ring-teal-400/25">forked</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/85">Forked from {label}{sourceRunId ? ` · ${sourceRunId}` : ''}</span>
          <span className="hidden shrink-0 font-mono text-[10px] text-white/30 sm:block">{relTime(item.ts, baseTs)}</span>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="telemetry-checkpoint" className="glass-soft w-full rounded-xl px-3 py-2.5 text-left ring-1 ring-teal-400/25">
      <div className="flex items-center gap-2.5">
        <span className="shrink-0 rounded-full bg-teal-400/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-teal-300 ring-1 ring-inset ring-teal-400/25">branch point</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/85">Checkpoint {label}</span>
        {stepSeq !== undefined && <span className="shrink-0 font-mono text-[10px] text-white/40">step {stepSeq}</span>}
        <span className="hidden shrink-0 font-mono text-[10px] text-white/30 sm:block">{relTime(item.ts, baseTs)}</span>
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-white/35">
        {tool ? `before ${tool}` : 'pre-mutation snapshot'}{reason ? ` · ${reason}` : ''}
      </div>
      <div className="mt-2">
        <button
          onClick={() => setForkOpen((v) => !v)}
          className="rounded-lg bg-teal-300 px-3 py-1.5 text-[11px] font-medium text-slate-950 hover:brightness-110"
        >
          Fork Run from Here
        </button>
      </div>
      {forkOpen && (
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void fork(); }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Tweaked prompt for the alternate run"
            aria-label="Tweaked prompt for the fork"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs outline-none focus:border-teal-300/50"
          />
          <button disabled={forking} className="rounded-lg bg-teal-300 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-50">
            {forking ? 'Starting…' : 'Fork'}
          </button>
        </form>
      )}
      {status && <p role="status" className="mt-2 font-mono text-[11px] text-white/60">{status}</p>}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'muted' | 'warn' | 'error'; children: ReactNode }) {
  const cls = tone === 'error' ? 'text-rose-300/90' : tone === 'warn' ? 'text-amber-300/90' : 'text-white/40';
  return <div className={`mb-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[10.5px] ${cls}`}>{children}</div>;
}

function ToolPill({ tool }: { tool: ToolCallEntry }) {
  const dot =
    tool.status === 'running'
      ? { color: 'hsl(190 90% 65%)', pulse: true }
      : tool.ok === false
        ? { color: '#f87171', pulse: false }
        : { color: 'rgba(255,255,255,.55)', pulse: false };
  const label = tool.status === 'running' ? 'running' : tool.ok === false ? 'error' : 'ok';
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] text-white/50">
      <span className="relative flex h-1.5 w-1.5">
        {dot.pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style={{ background: dot.color }} />}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: dot.color }} />
      </span>
      {label}
    </span>
  );
}

function RunStateLabel({ streamStatus, summary, live, awaitingApproval }: { streamStatus: ReturnType<typeof useRunStream>['status']; summary: RunSummary; live: boolean; awaitingApproval?: boolean }) {
  if (streamStatus === 'connecting') return <span className="text-cyan-300/80">connecting</span>;
  if (streamStatus === 'reconnecting') return <span className="text-amber-300/90">reconnecting</span>;
  if (summary.error) return <span className="text-rose-300/90">error</span>;
  if (summary.cancelledReason) return <span className="text-amber-300/90">cancelled</span>;
  if (awaitingApproval) return <span className="text-amber-300/90">awaiting approval</span>;
  if (live) return <span className="text-cyan-300/80">running</span>;
  return <span className="text-white/70">finished</span>;
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-widest text-white/30">{label}</div>
      <div className="text-sm text-white/85">{value}</div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-white/25">{label}</div>
      <div className="text-white/70">{value}</div>
    </div>
  );
}

function StatusPill({ status, hue }: { status: AgentState['status']; hue: number }) {
  const color =
    status === 'error' ? '#f87171' : status === 'done' ? 'rgba(255,255,255,.55)' : status === 'queued' || status === 'idle' ? 'rgba(255,255,255,.2)' : `hsl(${hue} 90% 70%)`;
  const pulse = status === 'thinking' || status === 'streaming';
  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px] text-white/50">
      <span className="relative flex h-1.5 w-1.5">
        {pulse && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style={{ background: color }} />}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      </span>
      {status}
    </div>
  );
}

type StreamItem = { seq: number; kind: string; data?: unknown };

/**
 * Why the router picked the last provider (score inputs, rejected candidates
 * on hover) plus any sticky-provider failovers and quality demotions.
 */
function RouteSummary({ decision, notes }: { decision?: StreamItem; notes: StreamItem[] }) {
  const d = decision ? payloadOf(decision) : undefined;
  // An event that carried no payload (or an unexpected shape) renders nothing.
  const dPresent = d !== undefined && Object.keys(d).length > 0 ? d : undefined;
  const chosen = dPresent && isRecord(dPresent.chosen) ? dPresent.chosen : undefined;
  const candidates = dPresent && Array.isArray(dPresent.candidates) ? dPresent.candidates.filter(isRecord) : [];
  const eligible = candidates.filter((c) => c.eligible === true).length;
  const rejected = candidates
    .filter((c) => c.eligible !== true)
    .map((c) => `${String(c.provider)} ${String(c.model)}: ${Array.isArray(c.reasons) ? c.reasons.join(', ') : ''}`);
  if (!dPresent && notes.length === 0) return null;
  return (
    <div className="space-y-1 font-mono text-[10px] text-white/45" data-testid="route-summary">
      {dPresent && (
        <div title={rejected.length > 0 ? rejected.join('\n') : undefined}>
          <span className="text-white/30">route </span>
          {chosen ? (
            <>
              <span className="text-white/70">{`${String(chosen.provider)} ${String(chosen.model)}`}</span>
              <span>{` · ${chosen.isPaid === true ? 'paid' : 'free'}${chosen.sticky === true ? ' · sticky' : ''}`}</span>
            </>
          ) : (
            <span className="text-rose-300/80">no usable provider</span>
          )}
          <span>{` · ${eligible}/${candidates.length} candidates eligible`}</span>
        </div>
      )}
      {notes.slice(-5).map((it) => {
        const n = payloadOf(it);
        const reason = typeof n.reason === 'string' ? n.reason : '';
        if (it.kind === 'route.failover') {
          const from = isRecord(n.from) ? String(n.from.provider ?? '?') : '?';
          const to = isRecord(n.to) ? String(n.to.provider ?? '?') : '?';
          return (
            <div key={it.seq} className="text-amber-300/80" title={reason}>
              {`failover ${from} ➜ ${to}`}
              <span className="text-white/35">{` · ${reason.slice(0, 120)}`}</span>
            </div>
          );
        }
        return (
          <div key={it.seq} className="text-amber-300/80" title={reason}>
            {`demoted ${String(n.provider ?? '?')} ${String(n.model ?? '')}`}
            <span className="text-white/35">{` · ${reason.slice(0, 120)}`}</span>
          </div>
        );
      })}
    </div>
  );
}
