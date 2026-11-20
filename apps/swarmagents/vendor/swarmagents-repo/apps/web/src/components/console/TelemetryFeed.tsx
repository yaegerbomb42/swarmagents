'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HarnessStepView, HarnessTask } from '@/lib/harnessTasks';

/**
 * Live telemetry feed for the home console. Two real sources, no
 * synthetic events anywhere:
 *
 * 1. The dispatched task's stream — GET /api/harness/task?id=<taskId>,
 *    which replays the executor's recorded steps and pushes new ones
 *    (phase, tool, reasoning, duration_ms, success) as they happen.
 * 2. The engine-wide stream — GET /api/events, the WebSocket bridge to
 *    the engine (localhost:8400). When the engine is unreachable that
 *    route says so explicitly (a `warning` system event) and the feed
 *    shows engine-offline state instead of inventing traffic.
 *
 * Token counters are extracted defensively from real event payloads
 * (usage/input_tokens/output_tokens shapes); when no event ever carries
 * usage the counter honestly reads "—" instead of a fabricated number.
 * The relentless executor does not report token usage, so expect "—"
 * for pure harness runs.
 */

type FeedRow =
  | {
      kind: 'step';
      id: string;
      ts: number;
      phase: string;
      tool?: string;
      text: string;
      status: 'running' | 'ok' | 'error';
      durationMs?: number;
    }
  | { kind: 'note'; id: string; ts: number; text: string; tone: 'info' | 'warn' | 'error' }
  | { kind: 'engine'; id: string; ts: number; label: string; text: string };

type TokenTotals = { input: number; output: number; seen: boolean };

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function extractUsage(payload: Record<string, unknown>): { input: number; output: number } | null {
  const usage = payload.usage as Record<string, unknown> | undefined;
  const tokens = payload.tokens as Record<string, unknown> | number | undefined;
  const input =
    Number(usage?.input_tokens ?? usage?.prompt_tokens ?? payload.inputTokens ?? payload.prompt_tokens ?? (typeof tokens === 'object' ? tokens.input : NaN)) || 0;
  const output =
    Number(usage?.output_tokens ?? usage?.completion_tokens ?? payload.outputTokens ?? payload.completion_tokens ?? (typeof tokens === 'object' ? tokens.output : NaN)) || 0;
  if (usage && (input || output)) return { input, output };
  if (typeof tokens === 'number' && tokens > 0) return { input: tokens, output: 0 };
  const single = Number(payload.tokenCount ?? NaN);
  if (single > 0) return { input: single, output: 0 };
  return null;
}

function eventText(payload: Record<string, unknown>): string {
  const text = payload.message ?? payload.text ?? payload.summary;
  if (typeof text === 'string' && text) return text;
  const tool = payload.tool;
  if (typeof tool === 'string') return `tool: ${tool}`;
  const phase = payload.phase ?? payload.status;
  if (typeof phase === 'string') return phase;
  return JSON.stringify(payload).slice(0, 180);
}

type StepRow = Extract<
  FeedRow,
  { kind: 'step' }
>;

function stepToRow(step: HarnessStepView, taskId: string): StepRow {
  const status: StepRow['status'] =
    step.success === false || step.error ? 'error' : step.success ? 'ok' : 'running';
  return {
    kind: 'step',
    id: `${taskId}-step-${step.step}-${step.timestamp}`,
    ts: step.timestamp,
    phase: step.phase,
    tool: step.tool,
    text: step.reasoning || step.output || step.error || step.tool || step.phase,
    status,
    durationMs: step.duration_ms,
  };
}

const MAX_ROWS = 300;

export function TelemetryFeed({
  taskId,
  running,
  onTaskEnd,
  onTaskGone,
}: {
  taskId: string | null;
  running: boolean;
  onTaskEnd: (status: string) => void;
  onTaskGone?: () => void;
}) {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null);
  const [tokens, setTokens] = useState<TokenTotals>({ input: 0, output: 0, seen: false });
  const [now, setNow] = useState(Date.now());
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastActivity, setLastActivity] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onTaskEndRef = useRef(onTaskEnd);
  onTaskEndRef.current = onTaskEnd;
  const onTaskGoneRef = useRef(onTaskGone);
  onTaskGoneRef.current = onTaskGone;

  const pushRows = useCallback((next: FeedRow[]) => {
    setRows((prev) => [...prev, ...next].slice(-MAX_ROWS));
  }, []);

  const noteUsage = useCallback((payload: Record<string, unknown>) => {
    const usage = extractUsage(payload);
    if (!usage) return;
    setTokens((prev) => ({
      input: prev.input + usage.input,
      output: prev.output + usage.output,
      seen: true,
    }));
  }, []);

  // ── Task stream ────────────────────────────────────────────────
  useEffect(() => {
    if (!taskId) return;
    setRows([]);
    setTokens({ input: 0, output: 0, seen: false });
    setLastActivity(null);
    setStartedAt(Date.now());
    stick.current = true;
    const es = new EventSource(`/api/harness/task?id=${encodeURIComponent(taskId)}`);
    es.onmessage = (m) => {
      try {
        const data = JSON.parse(m.data) as
          | { op: 'snapshot'; task: HarnessTask }
          | { op: 'event'; event: { action: string; payload: Record<string, unknown>; timestamp: number } };
        if (data.op === 'snapshot') {
          const task = data.task;
          if (task.startedAt) setStartedAt(task.startedAt);
          pushRows(task.steps.map((s) => stepToRow(s, taskId)));
          const last = task.steps.at(-1);
          if (last) setLastActivity(last.tool ? `${last.phase} · ${last.tool}` : last.phase);
          if (task.status === 'completed' || task.status === 'failed' || task.status === 'blocked') {
            onTaskEndRef.current(task.status);
          }
          return;
        }
        const evt = data.event;
        const payload = evt.payload ?? {};
        if (evt.action === 'step' && payload.step) {
          const row = stepToRow(payload.step as HarnessStepView, taskId);
          pushRows([row]);
          setLastActivity(row.tool ? `${row.phase} · ${row.tool}` : row.phase);
          noteUsage(payload.step as Record<string, unknown>);
        } else if (evt.action === 'started') {
          pushRows([
            {
              kind: 'note',
              id: `note-started-${evt.timestamp}`,
              ts: evt.timestamp,
              text: `Mission started${payload.title ? ` — ${String(payload.title)}` : ''}`,
              tone: 'info',
            },
          ]);
        } else if (evt.action === 'completed' || evt.action === 'failed' || evt.action === 'blocked') {
          const err = payload.error;
          pushRows([
            {
              kind: 'note',
              id: `note-end-${evt.timestamp}`,
              ts: evt.timestamp,
              text:
                evt.action === 'completed'
                  ? 'Mission completed'
                  : `Mission ${evt.action}${typeof err === 'string' && err ? ` — ${err}` : ''}`,
              tone: evt.action === 'completed' ? 'info' : 'error',
            },
          ]);
          onTaskEndRef.current(evt.action);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onerror = () => {
      // A 404 means the task record is gone (server restarted); otherwise
      // EventSource reconnects on its own.
      fetch(`/api/harness/task?id=${encodeURIComponent(taskId)}`).then((r) => {
        if (r.status === 404) {
          es.close();
          onTaskGoneRef.current?.();
          onTaskEndRef.current('failed');
        }
      });
    };
    return () => es.close();
  }, [taskId, pushRows, noteUsage]);

  // ── Engine-wide stream (ambient telemetry + engine status) ─────
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (m) => {
      try {
        const evt = JSON.parse(m.data) as {
          id?: string;
          type?: string;
          action?: string;
          agentId?: string;
          payload?: Record<string, unknown>;
          timestamp?: number;
        };
        if (evt.type === 'system' && evt.action === 'heartbeat') return;
        const ts = evt.timestamp ?? Date.now();
        const payload = evt.payload ?? {};
        if (evt.type === 'system' && evt.action === 'connected') {
          setEngineOnline(true);
          return;
        }
        if (evt.type === 'system' && evt.action === 'warning') {
          setEngineOnline(false);
          pushRows([
            {
              kind: 'note',
              id: `sys-${ts}`,
              ts,
              text: typeof payload.message === 'string' ? payload.message : 'Engine unreachable',
              tone: 'warn',
            },
          ]);
          return;
        }
        noteUsage(payload);
        pushRows([
          {
            kind: 'engine',
            id: evt.id ?? `eng-${ts}`,
            ts,
            label: evt.agentId ? `agent ${String(evt.agentId).slice(0, 12)}` : (evt.type ?? 'engine'),
            text: eventText(payload),
          },
        ]);
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onerror = () => setEngineOnline(false);
    return () => es.close();
  }, [pushRows, noteUsage]);

  // ── Auto-scroll + clock ────────────────────────────────────────
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const elapsedLabel =
    elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const stepRows = rows.filter((r): r is Extract<FeedRow, { kind: 'step' }> => r.kind === 'step');
  const toolRows = stepRows.filter((r) => r.tool);
  const lastLatency = [...stepRows].reverse().find((r) => r.durationMs !== undefined)?.durationMs;

  return (
    <section aria-label="Live telemetry" className="w-full">
      {/* Status strip — all counters come from real rows/events above. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-line-1 bg-bg-1 px-3 py-2 font-mono text-meta text-fg-3">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={`relative flex h-1.5 w-1.5 ${running ? 'animate-pulse' : ''}`}
            aria-hidden
          >
            <span
              className={`absolute inline-flex h-full w-full rounded-full ${
                running ? 'bg-st-running' : 'bg-st-idle'
              }`}
            />
            <span
              className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                running ? 'bg-st-running' : 'bg-st-idle'
              }`}
            />
          </span>
          <span className={running ? 'text-fg-1' : ''}>
            {running ? (lastActivity ?? 'Working') : taskId ? 'Idle' : 'Ready'}
          </span>
        </span>
        <span title="Engine WebSocket bridge (localhost:8400)">
          engine {engineOnline === null ? '…' : engineOnline ? 'online' : 'offline'}
        </span>
        {taskId ? <span>{elapsedLabel}</span> : null}
        {taskId ? <span>{stepRows.length} steps</span> : null}
        {taskId ? <span>{toolRows.length} tool calls</span> : null}
        <span title="Latency of the last timed step">
          {lastLatency !== undefined ? `last ${fmtMs(lastLatency)}` : 'latency —'}
        </span>
        <span title="Token totals summed from event payloads that report usage">
          ↑{tokens.seen ? tokens.input.toLocaleString() : '—'} ↓
          {tokens.seen ? tokens.output.toLocaleString() : '—'} tokens
        </span>
      </div>

      {/* Feed */}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="mt-2 h-[46vh] min-h-[280px] overflow-y-auto rounded-md border border-line-1 bg-bg-1 px-3 py-2"
      >
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="text-meta text-fg-3">
              {engineOnline === false
                ? 'Engine offline — no live events. Dispatch a mission and the executor’s steps stream here.'
                : 'No telemetry yet — dispatch a mission and its thoughts, tool calls, and timings stream here.'}
            </p>
            <p className="font-mono text-micro text-fg-4">
              sources: /api/harness/task · /api/events
            </p>
          </div>
        ) : (
          <ol className="space-y-1 font-mono text-meta">
            {rows.map((row) => {
              if (row.kind === 'note') {
                return (
                  <li key={row.id} className="flex items-start gap-2 py-0.5">
                    <span className="shrink-0 text-fg-4">{fmtClock(row.ts)}</span>
                    <span
                      className={
                        row.tone === 'error'
                          ? 'text-st-failed'
                          : row.tone === 'warn'
                            ? 'text-st-blocked'
                            : 'text-fg-3'
                      }
                    >
                      {row.text}
                    </span>
                  </li>
                );
              }
              if (row.kind === 'engine') {
                return (
                  <li key={row.id} className="flex items-start gap-2 py-0.5">
                    <span className="shrink-0 text-fg-4">{fmtClock(row.ts)}</span>
                    <span className="shrink-0 rounded border border-line-2 px-1 text-micro text-fg-3">
                      {row.label}
                    </span>
                    <span className="min-w-0 break-words text-fg-2">{row.text}</span>
                  </li>
                );
              }
              return (
                <li key={row.id} className="flex items-start gap-2 py-0.5">
                  <span className="shrink-0 text-fg-4">{fmtClock(row.ts)}</span>
                  <span
                    className={`shrink-0 rounded border px-1 text-micro ${
                      row.status === 'error'
                        ? 'border-st-failed/40 text-st-failed'
                        : row.status === 'ok'
                          ? 'border-st-done/40 text-st-done'
                          : 'border-st-running/40 text-st-running'
                    }`}
                  >
                    {row.phase}
                  </span>
                  {row.tool ? (
                    <span className="shrink-0 text-accent">{row.tool}</span>
                  ) : null}
                  <span className="min-w-0 flex-1 break-words text-fg-2">{row.text}</span>
                  {row.durationMs !== undefined ? (
                    <span className="shrink-0 text-fg-4">{fmtMs(row.durationMs)}</span>
                  ) : null}
                </li>
              );
            })}
            {running ? (
              <li className="flex items-center gap-2 py-1 text-fg-3">
                <span className="animate-pulse">Working…</span>
              </li>
            ) : null}
          </ol>
        )}
      </div>
    </section>
  );
}
