'use client';

import React from 'react';
import { burnPerMin, fmtDur, fmtMs, fmtNum, percentile, type ConnState, type RunDerived } from '@/stores/runStore';
import { numCls, statusColor, V } from './theme';

export function elapsedSeconds(d: RunDerived, nowMs: number): number | undefined {
  if (d.elapsedS != null && (d.endedAt != null || d.status !== 'running')) return d.elapsedS;
  if (d.startedAt == null) return d.elapsedS;
  const end = d.endedAt ?? nowMs;
  return Math.max(0, (end - d.startedAt) / 1000);
}

export function openSpanLabel(d: RunDerived, nowMs: number): string | null {
  const s = d.openSpan;
  if (!s) return null;
  const secs = Math.max(0, (nowMs - s.startMs) / 1000).toFixed(1);
  if (s.kind === 'llm') return `llm · ${s.model ?? s.provider ?? '?'} · ${secs}s`;
  return `${s.tool ?? 'tool'} · ${secs}s`;
}

function Sep() {
  return <span aria-hidden style={{ color: V.fg4 }}>·</span>;
}

export default function StatusLine({
  d, conn, nowMs, mode, onMode, viewingIndex, onBackToLive,
}: {
  d: RunDerived; conn: ConnState; nowMs: number; mode: 'live' | 'replay';
  onMode: (m: 'live' | 'replay') => void; viewingIndex: number | null; onBackToLive: () => void;
}) {
  const b = d.budgets;
  const el = elapsedSeconds(d, nowMs);
  const burnNow = d.status === 'running' ? nowMs : d.tokenSamples[d.tokenSamples.length - 1]?.[0] ?? nowMs;
  const burn = d.tokenSamples.length ? burnPerMin(d.tokenSamples, burnNow) : undefined;
  const p50 = percentile(d.llmLatency, 50);
  const span = openSpanLabel(d, nowMs);
  const connLabel =
    mode === 'replay' ? 'replay' :
    conn.phase === 'open' ? 'live' :
    conn.phase === 'retrying' ? `reconnecting${conn.nextRetryMs ? ` ${Math.round(conn.nextRetryMs / 1000)}s` : ''}` :
    conn.phase === 'closed' ? 'stream closed' : conn.phase === 'error' ? `stream error${conn.error ? `: ${conn.error}` : ''}` : conn.phase;

  return (
    <header
      className={`flex h-9 shrink-0 items-center gap-3 border-b px-3 text-[12px] ${numCls}`}
      style={{ borderColor: V.line2, background: V.bg1, color: V.fg2 }}
      aria-label="Run status"
    >
      <span style={{ color: V.fg1 }} className="truncate" title={d.task}>{d.runId}</span>
      <span className="inline-flex items-center gap-1.5" data-testid="run-status">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: statusColor(d.status) }} />
        <span style={{ color: statusColor(d.status) }}>{d.status === 'unknown' ? '—' : d.status.toUpperCase()}</span>
      </span>
      <Sep />
      <span title="step / max steps">step {d.step || d.stepsDone || '—'}/{b.max_steps ?? '—'}</span>
      <Sep />
      <span title="elapsed / wallclock limit">{fmtDur(el)}/{b.max_wallclock_s ? fmtDur(b.max_wallclock_s) : '—'}</span>
      <Sep />
      <span title="tokens (estimate) / token budget">{fmtNum(d.tokensEst || undefined)}/{fmtNum(b.max_tokens ?? undefined)} tok</span>
      <Sep />
      <span title="token burn, 60 s window">↯ {burn != null ? `${fmtNum(burn)} tok/min` : '—'}</span>
      <Sep />
      <span title="LLM latency p50">llm p50 {fmtMs(p50)}</span>
      {span ? (<><Sep /><span style={{ color: V.thinking }} data-testid="open-span">● {span}</span></>) : null}
      <span className="ml-auto flex items-center gap-2">
        {viewingIndex != null && mode === 'live' ? (
          <button type="button" onClick={onBackToLive} className="rounded px-1.5 py-0.5 text-[11px]"
            style={{ border: `1px solid ${V.line3}`, color: V.fg1 }}>
            viewing #{d.events[viewingIndex]?.step ?? viewingIndex} · back to live (esc)
          </button>
        ) : null}
        <span style={{ color: conn.phase === 'error' ? V.failed : V.fg3 }}>{connLabel}</span>
        <span role="group" aria-label="Mode" className="flex overflow-hidden rounded" style={{ border: `1px solid ${V.line2}` }}>
          {(['live', 'replay'] as const).map((m) => (
            <button key={m} type="button" onClick={() => onMode(m)} aria-pressed={mode === m}
              className="px-2 py-0.5 text-[11px]"
              style={{ background: mode === m ? V.bg3 : 'transparent', color: mode === m ? V.fg1 : V.fg3 }}>
              {m}
            </button>
          ))}
        </span>
      </span>
    </header>
  );
}
