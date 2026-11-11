'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Command } from 'cmdk';
import {
  burnSeries, fmtMs, fmtNum, percentile, type ControlName, type RunView,
} from '@/stores/runStore';
import { TERMINAL_STATUSES } from '@/types/runEvents';
import Sparkline from './Sparkline';
import { elapsedSeconds } from './StatusLine';
import { numCls, V } from './theme';

function Bar({ label, used, max, fmt }: { label: string; used?: number; max?: number | null; fmt: (n?: number) => string }) {
  const pct = used != null && max ? Math.min(1, used / max) : null;
  const cells = 10;
  const on = pct == null ? 0 : Math.round(pct * cells);
  return (
    <div className={`flex items-center gap-2 text-[12px] ${numCls}`}>
      <span className="w-10" style={{ color: V.fg3 }}>{label}</span>
      <span aria-hidden className="flex gap-[2px]">
        {Array.from({ length: cells }, (_, i) => (
          <span key={i} className="inline-block h-2 w-[9px]" style={{
            background: i < on ? (pct! >= 0.9 ? V.failed : pct! >= 0.75 ? V.blocked : V.fg2) : V.line2,
          }} />
        ))}
      </span>
      <span className="ml-auto" style={{ color: V.fg2 }} title={`${fmt(used)} of ${max != null ? fmt(max) : '—'}`}>
        {pct == null ? '—' : `${Math.round(pct * 100)}%`}
      </span>
    </div>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 mt-3 text-[11px] uppercase tracking-wider first:mt-0" style={{ color: V.fg3 }}>{children}</div>;
}

const PHASE_LABEL: Record<string, string> = {
  sending: 'sending…', sent: 'requested · awaiting engine ack', acked: 'acked', error: 'failed',
};

export interface DeckActions {
  togglePause: () => void;
  openSteer: (interrupt: boolean) => void;
  askCancel: () => void;
  approve: (id: string, decision: 'approve' | 'reject') => void;
}

export default function ControlDeck({
  view, nowMs, actions, confirmCancel, readOnly,
}: {
  view: RunView; nowMs: number; actions: DeckActions; confirmCancel: boolean; readOnly: boolean;
}) {
  const { d, controls, steersLocal, approvalsLocal } = view;
  const b = d.budgets;
  const terminal = TERMINAL_STATUSES.has(d.status);
  const pendingApprovals = [...d.approvals.values()].filter((a) => !a.decision);
  const amber = d.paused || d.status === 'paused' || pendingApprovals.length > 0;
  const burnEnd = d.status === 'running' ? nowMs : d.tokenSamples[d.tokenSamples.length - 1]?.[0] ?? nowMs;
  const burn = burnSeries(d.tokenSamples, burnEnd);
  const el = elapsedSeconds(d, nowMs);
  const disabled = readOnly || terminal;

  const ctl = (name: ControlName) => controls[name];
  const pauseState = d.paused ? ctl('resume') : ctl('pause');

  return (
    <aside className="flex w-[280px] shrink-0 flex-col overflow-auto border-l px-3 py-2"
      style={{ borderColor: amber ? V.blocked : V.line2, background: V.bg1, color: V.fg2 }}
      aria-label="Control deck">
      <H>Budget</H>
      <Bar label="steps" used={d.stepsDone || d.step} max={b.max_steps} fmt={(n) => fmtNum(n)} />
      <Bar label="time" used={el} max={b.max_wallclock_s} fmt={(n) => (n == null ? '—' : `${Math.round(n)}s`)} />
      <Bar label="tok" used={d.tokensEst} max={b.max_tokens} fmt={fmtNum} />
      <div className={`mt-1 flex items-center gap-2 text-[12px] ${numCls}`}>
        <span className="w-10" style={{ color: V.fg3 }}>↯</span>
        <Sparkline values={burn} label="token burn per minute, last 5 minutes" width={150} />
        <span className="ml-auto">{burn.some((x) => x) ? `${fmtNum(burn[burn.length - 1])}/m` : '—'}</span>
      </div>
      {!d.usageSeen && d.tokenSamples.length ? (
        <div className="text-[11px]" style={{ color: V.fg4 }}>burn from tokens_est deltas (no llm usage yet)</div>
      ) : null}

      <H>Latency p50 / p95</H>
      <div className={`grid grid-cols-[3rem_1fr] gap-y-0.5 text-[12px] ${numCls}`}>
        <span style={{ color: V.fg3 }}>llm</span>
        <span>{fmtMs(percentile(d.llmLatency, 50))} / {fmtMs(percentile(d.llmLatency, 95))}</span>
        <span style={{ color: V.fg3 }}>tool</span>
        <span>{fmtMs(percentile(d.toolLatency, 50))} / {fmtMs(percentile(d.toolLatency, 95))}</span>
      </div>

      <H>Confidence</H>
      <Sparkline values={d.confidence.slice(-60).map((c) => c.value)} min={0} max={1} label="confidence per step" width={240} />

      <H>Provider</H>
      <div className="truncate font-mono text-[12px]">
        {d.provider ? `${d.provider.provider ?? '—'} · ${d.provider.model ?? '—'}${d.provider.attempts && d.provider.attempts > 1 ? ` · ${d.provider.attempts} attempts` : ''}` : '—'}
      </div>

      {pendingApprovals.length ? (
        <>
          <H>Approval needed</H>
          {pendingApprovals.slice(0, 3).map((a, i) => {
            const loc = approvalsLocal[a.id];
            return (
              <div key={a.id} className="mb-1 rounded px-2 py-1 text-[12px]" style={{ border: `1px solid ${V.blocked}` }}>
                <div className="font-mono" style={{ color: V.fg1 }}>{a.tool ?? 'action'} <span style={{ color: V.fg3 }}>step {a.step}</span></div>
                <div className="truncate font-mono text-[11px]" style={{ color: V.fg3 }} title={a.params_summary}>{a.params_summary ?? '—'}</div>
                {loc ? (
                  <div className="text-[11px]" style={{ color: loc.phase === 'error' ? V.failed : V.fg3 }}>
                    {loc.decision} · {loc.phase === 'error' ? `failed: ${loc.error}` : PHASE_LABEL[loc.phase]}
                  </div>
                ) : (
                  <div className="mt-1 flex gap-2">
                    <button type="button" disabled={readOnly} onClick={() => actions.approve(a.id, 'approve')} className="text-[11px] underline">{i === 0 ? 'a ' : ''}approve</button>
                    <button type="button" disabled={readOnly} onClick={() => actions.approve(a.id, 'reject')} className="text-[11px] underline">{i === 0 ? 'r ' : ''}reject</button>
                  </div>
                )}
              </div>
            );
          })}
        </>
      ) : null}

      {steersLocal.length || d.steers.size ? (
        <>
          <H>Steer notes</H>
          <ul className="space-y-0.5 text-[11px]">
            {steersLocal.slice(-4).reverse().map((s) => (
              <li key={s.localId} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate" style={{ color: V.fg1 }} title={s.text}>{s.interrupt ? '⏎ ' : '✎ '}{s.text}</span>
                <span style={{ color: s.phase === 'error' ? V.failed : s.phase === 'applied' ? V.done : V.fg3 }} title={s.error}>
                  {s.phase === 'sent' ? 'sent · pending' : s.phase === 'error' ? 'failed' : s.phase}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="mt-auto border-t pt-2" style={{ borderColor: V.line2 }}>
        <H>Controls</H>
        <ul className="space-y-1 font-mono text-[12px]">
          <li>
            <button type="button" disabled={disabled} onClick={actions.togglePause} className="flex w-full gap-2 text-left disabled:opacity-40">
              <kbd style={{ color: V.fg3 }}>␣</kbd>
              <span>{d.paused ? 'resume' : 'pause @ step'}</span>
              {pauseState && pauseState.phase !== 'idle' ? (
                <span className="ml-auto text-[11px]" style={{ color: pauseState.phase === 'error' ? V.failed : V.fg3 }} title={pauseState.error}>
                  {pauseState.phase === 'sent' && !d.paused && d.openSpan
                    ? `pausing… (${d.openSpan.kind} in flight ${((nowMs - d.openSpan.startMs) / 1000).toFixed(1)}s)`
                    : PHASE_LABEL[pauseState.phase]}
                </span>
              ) : null}
            </button>
          </li>
          <li><button type="button" disabled={disabled} onClick={() => actions.openSteer(false)} className="flex w-full gap-2 text-left disabled:opacity-40"><kbd style={{ color: V.fg3 }}>s</kbd><span>steer…</span></button></li>
          <li>
            <button type="button" disabled={disabled} onClick={() => actions.openSteer(true)} className="flex w-full gap-2 text-left disabled:opacity-40">
              <kbd style={{ color: V.fg3 }}>i</kbd><span>interrupt + redirect</span>
              {ctl('interrupt') ? <span className="ml-auto text-[11px]" style={{ color: V.fg3 }}>{PHASE_LABEL[ctl('interrupt')!.phase]}</span> : null}
            </button>
          </li>
          <li>
            <button type="button" disabled={disabled} onClick={actions.askCancel} className="flex w-full gap-2 text-left disabled:opacity-40"
              style={{ color: confirmCancel ? V.failed : undefined }}>
              <kbd style={{ color: V.fg3 }}>x</kbd>
              <span>{confirmCancel ? 'press x again to cancel · esc' : 'cancel run'}</span>
              {ctl('cancel') ? <span className="ml-auto text-[11px]" style={{ color: ctl('cancel')!.phase === 'error' ? V.failed : V.fg3 }} title={ctl('cancel')!.error}>{PHASE_LABEL[ctl('cancel')!.phase]}</span> : null}
            </button>
          </li>
        </ul>
        {Object.values(controls).find((c) => c?.phase === 'error') ? (
          <div className="mt-1 text-[11px]" style={{ color: V.failed }}>
            {Object.values(controls).find((c) => c?.phase === 'error')?.error}
          </div>
        ) : null}
        {readOnly ? <div className="mt-1 text-[11px]" style={{ color: V.fg4 }}>replay · controls disabled</div> : terminal ? <div className="mt-1 text-[11px]" style={{ color: V.fg4 }}>run ended · controls disabled</div> : null}
      </div>
    </aside>
  );
}

/** cmdk-style steer / interrupt input. Enter sends, Esc closes. */
export function SteerPalette({
  open, interrupt, onClose, onSubmit,
}: { open: boolean; interrupt: boolean; onClose: () => void; onSubmit: (text: string) => void }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setText(''); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]" style={{ background: 'rgba(0,0,0,0.5)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <Command label={interrupt ? 'Interrupt and redirect' : 'Steer the run'} shouldFilter={false}
        className="w-[560px] overflow-hidden rounded-md" style={{ background: V.bg2, border: `1px solid ${V.line3}` }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          if (e.key === 'Enter' && text.trim()) { e.preventDefault(); onSubmit(text.trim()); }
        }}>
        <div className="px-3 pt-2 text-[11px] uppercase tracking-wider" style={{ color: V.fg3 }}>
          {interrupt ? 'interrupt — cancels the in-flight LLM call (not a running tool), then continues with this note' : 'steer — applied at the next step boundary'}
        </div>
        <Command.Input ref={inputRef} value={text} onValueChange={setText}
          placeholder={interrupt ? 'Redirect the agent…' : 'Tell the agent…'}
          className="w-full bg-transparent px-3 py-2 font-mono text-[13px] outline-none" style={{ color: V.fg1 }} />
        <Command.List>
          <Command.Empty />
        </Command.List>
        <div className="flex justify-between px-3 pb-2 text-[11px]" style={{ color: V.fg4 }}>
          <span>↵ send</span><span>esc close</span>
        </div>
      </Command>
    </div>
  );
}
