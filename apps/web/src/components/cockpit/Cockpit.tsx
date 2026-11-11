'use client';

/**
 * Glass cockpit for one harness run.
 *
 * ┌ StatusLine ─────────────────────────────────────────────┐
 * │ WorkspaceCanvas (~65%)                    │ ControlDeck │
 * │ TrajectoryRibbon (bottom, ~120px)         │   (280px)   │
 * └─────────────────────────────────────────────────────────┘
 *
 * Live mode streams; Replay mode pages REST history and scrubs with the
 * ribbon (replaces TraceReplayDebugger for harness runs). In either mode,
 * selecting a step re-derives the Canvas from events[0..i].
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRunStream } from '@/hooks/useRunStream';
import { deriveUpTo } from '@/stores/runStore';
import { TERMINAL_STATUSES } from '@/types/runEvents';
import ControlDeck, { SteerPalette } from './ControlDeck';
import { resolveApproval, sendControl, sendSteer } from './controls';
import RawEventDrawer from './RawEventDrawer';
import StatusLine, { openSpanLabel } from './StatusLine';
import TrajectoryRibbon from './TrajectoryRibbon';
import WorkspaceCanvas from './WorkspaceCanvas';
import { V } from './theme';

function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return active ? now : Date.now();
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export default function Cockpit({ runId, initialMode = 'live' }: { runId: string; initialMode?: 'live' | 'replay' }) {
  const [mode, setMode] = useState<'live' | 'replay'>(initialMode);
  const { store, view } = useRunStream(runId, mode);
  const { d } = view;
  const [selected, setSelected] = useState<number | null>(null);
  const [rawIdx, setRawIdx] = useState<number | null>(null);
  const [steer, setSteer] = useState<{ open: boolean; interrupt: boolean }>({ open: false, interrupt: false });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [playing, setPlaying] = useState(false);
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const live = mode === 'live' && !TERMINAL_STATUSES.has(d.status);
  const nowMs = useNow(live || playing);
  const readOnly = mode === 'replay';

  // Replay starts at the first event.
  useEffect(() => { if (mode === 'replay') setSelected((s) => s ?? (d.events.length ? 0 : null)); else setSelected(null); }, [mode, d.events.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Replay playback: one event every 120 ms.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setSelected((s) => {
        const next = (s ?? -1) + 1;
        if (next >= d.events.length) { setPlaying(false); return s; }
        return next;
      });
    }, 120);
    return () => clearInterval(t);
  }, [playing, d.events.length]);

  const shown = useMemo(
    () => (selected == null ? d : deriveUpTo(runId, d.events, selected, view.snapshot)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, selected == null ? view.version : d.events.length, runId],
  );

  const togglePause = useCallback(() => {
    if (readOnly || TERMINAL_STATUSES.has(store.d.status)) return;
    void sendControl(store, store.d.paused ? 'resume' : 'pause');
  }, [store, readOnly]);
  const askCancel = useCallback(() => {
    if (readOnly || TERMINAL_STATUSES.has(store.d.status)) return;
    if (confirmCancel) {
      setConfirmCancel(false);
      void sendControl(store, 'cancel');
      return;
    }
    setConfirmCancel(true);
    if (cancelTimer.current) clearTimeout(cancelTimer.current);
    cancelTimer.current = setTimeout(() => setConfirmCancel(false), 4000);
  }, [confirmCancel, store, readOnly]);
  const approve = useCallback((id: string, decision: 'approve' | 'reject') => { void resolveApproval(store, id, decision); }, [store]);
  const openSteer = useCallback((interrupt: boolean) => {
    if (readOnly || TERMINAL_STATUSES.has(store.d.status)) return;
    setSteer({ open: true, interrupt });
  }, [store, readOnly]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (steer.open || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const pending = [...store.d.approvals.values()].find((a) => !a.decision && !store.approvalsLocal[a.id]);
      switch (e.key) {
        case ' ': e.preventDefault(); if (mode === 'replay') setPlaying((p) => !p); else togglePause(); break;
        case 's': e.preventDefault(); openSteer(false); break;
        case 'i': e.preventDefault(); openSteer(true); break;
        case 'x': e.preventDefault(); askCancel(); break;
        case 'a': if (pending && !readOnly) { e.preventDefault(); approve(pending.id, 'approve'); } break;
        case 'r': if (pending && !readOnly) { e.preventDefault(); approve(pending.id, 'reject'); } break;
        case 'ArrowLeft': if (d.events.length) { e.preventDefault(); setSelected((s) => Math.max(0, (s ?? d.events.length - 1) - 1)); } break;
        case 'ArrowRight': if (selected != null) { e.preventDefault(); setSelected((s) => (s == null ? s : s + 1 >= d.events.length ? (mode === 'live' ? null : s) : s + 1)); } break;
        case 'Escape':
          if (rawIdx != null) setRawIdx(null);
          else if (confirmCancel) setConfirmCancel(false);
          else if (mode === 'live') setSelected(null);
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [steer.open, store, mode, togglePause, openSteer, askCancel, approve, readOnly, rawIdx, confirmCancel, selected, d.events.length]);

  const spanLabel = openSpanLabel(d, nowMs);

  return (
    <div className="flex h-[calc(100vh-var(--site-header-h,0px))] min-h-[560px] flex-col overflow-hidden"
      style={{ background: V.bg0, color: V.fg2, fontSize: 12 }} data-testid="run-cockpit">
      <StatusLine d={d} conn={view.conn} nowMs={nowMs} mode={mode}
        onMode={(m) => { setPlaying(false); setMode(m); }} viewingIndex={selected} onBackToLive={() => setSelected(null)} />
      {mode === 'replay' ? (
        <div className="flex h-8 shrink-0 items-center gap-3 border-b px-3 font-mono text-[12px] tabular-nums" style={{ borderColor: V.line1 }}>
          <button type="button" onClick={() => setPlaying((p) => !p)} disabled={!d.events.length}>{playing ? '‖ pause' : '▸ play'}</button>
          <input type="range" min={0} max={Math.max(0, d.events.length - 1)} value={selected ?? 0}
            onChange={(e) => { setPlaying(false); setSelected(Number(e.target.value)); }} className="flex-1" aria-label="Replay position" />
          <span style={{ color: V.fg3 }}>{selected != null ? `${selected + 1}/${d.events.length} · step ${shown.step}` : '—'}</span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <WorkspaceCanvas d={shown} summary={view.snapshot?.summary} onSelectEventIndex={setSelected} isScrubbed={selected != null} />
          <TrajectoryRibbon d={d} version={view.version} selectedIndex={selected}
            onSelect={(i) => { setPlaying(false); setSelected(i); }} onRaw={setRawIdx}
            openSpanLabel={mode === 'live' ? spanLabel : null} />
        </div>
        <ControlDeck view={view} nowMs={nowMs} confirmCancel={confirmCancel} readOnly={readOnly}
          actions={{ togglePause, openSteer, askCancel, approve }} />
      </div>
      <SteerPalette open={steer.open} interrupt={steer.interrupt}
        onClose={() => setSteer((s) => ({ ...s, open: false }))}
        onSubmit={(text) => { setSteer((s) => ({ ...s, open: false })); void sendSteer(store, text, steer.interrupt); }} />
      <RawEventDrawer event={rawIdx != null ? d.events[rawIdx] ?? null : null} onClose={() => setRawIdx(null)} />
    </div>
  );
}
