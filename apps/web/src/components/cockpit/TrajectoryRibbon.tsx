'use client';

/**
 * TrajectoryRibbon — one <canvas>, one glyph column per step outcome, with
 * marker ticks (checkpoint/compaction/steer/pause/decision/approval), a
 * token lane and a latency lane. Drawn only when data/hover/size changes
 * (no animation loop), so it's reduced-motion friendly by construction.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtMs, fmtNum, K, MARKER_MIN, summarizeEvent, type RunDerived } from '@/stores/runStore';
import type { RunEvent } from '@/types/runEvents';
import { resolveVar, V } from './theme';

export interface RibbonModel {
  /** column → ring slot */
  cols: Int32Array;
  n: number;
  markers: Array<{ col: number; kind: number; slot: number }>;
  maxTokens: number;
  maxMs: number;
}

/** Split the ring into glyph columns and between-column markers. */
export function buildRibbonModel(d: RunDerived): RibbonModel {
  const R = d.ribbon;
  const len = R.length;
  const cols = new Int32Array(len);
  const markers: RibbonModel['markers'] = [];
  let n = 0, maxTokens = 0, maxMs = 0;
  for (let i = 0; i < len; i++) {
    const j = R.idx(i);
    const k = R.kind[j];
    if (k >= MARKER_MIN) { markers.push({ col: n, kind: k, slot: j }); continue; }
    cols[n++] = j;
    if (R.tokens[j] > maxTokens) maxTokens = R.tokens[j];
    if (R.ms[j] > maxMs) maxMs = R.ms[j];
  }
  return { cols, n, markers, maxTokens, maxMs };
}

const GLYPH: Record<number, string> = {
  [K.READ]: 'r', [K.WRITE]: 'w', [K.SHELL]: 'x', [K.VCS]: 'g', [K.SEARCH]: 's',
  [K.TOOL]: 't', [K.REPAIR]: '░', [K.FINISH]: '✓', [K.DECISION]: '◆',
};
const MARK: Record<number, string> = {
  [K.CHECKPOINT]: '⟲', [K.COMPACTION]: '⟲', [K.STEER]: '✎', [K.PAUSE]: '‖', [K.RESUME]: '▸',
  [K.CANCEL]: '■', [K.APPROVAL]: '?',
};
/** Lightness per category (40-60% white); failures are the only saturated color. */
const ALPHA: Record<number, number> = {
  [K.READ]: 0.4, [K.WRITE]: 0.6, [K.SHELL]: 0.55, [K.VCS]: 0.5, [K.SEARCH]: 0.45,
  [K.TOOL]: 0.45, [K.REPAIR]: 0.5, [K.FINISH]: 0.7, [K.DECISION]: 0.7,
};

const H = 120;
const PAD_L = 8;
const PAD_R = 8;
const GLYPH_Y = 6, GLYPH_H = 26;
const TOK_Y = 42, TOK_H = 30;
const LAT_Y = 80, LAT_H = 30;

function findCall(events: RunEvent[], idx: number): { tool: string; params: Record<string, unknown> } | undefined {
  const ev = events[idx];
  if (!ev || ev.kind !== 'tool_result') return undefined;
  for (let i = idx - 1; i >= Math.max(0, idx - 50); i--) {
    const e = events[i] as Record<string, any>;
    if (e.kind === 'tool_call' && e.step === ev.step) return { tool: e.tool, params: e.params ?? {} };
  }
  return undefined;
}

export default function TrajectoryRibbon({
  d, version, selectedIndex, onSelect, onRaw, openSpanLabel,
}: {
  d: RunDerived;
  version: number;
  selectedIndex: number | null;
  onSelect: (evIdx: number) => void;
  onRaw: (evIdx: number) => void;
  openSpanLabel: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ col: number; x: number } | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number; active: boolean } | null>(null);
  const downRef = useRef<{ x: number; col: number } | null>(null);

  const model = useMemo(() => buildRibbonModel(d), [d, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const innerW = Math.max(1, width - PAD_L - PAD_R - (openSpanLabel ? 12 : 0));
  // 8-px grid when it fits; compresses (sub-pixel at 10k+) to keep the whole run visible.
  const colW = model.n ? Math.min(8, innerW / model.n) : 8;
  const xOf = useCallback((col: number) => PAD_L + col * colW, [colW]);
  const colAt = useCallback((x: number) => {
    if (!model.n) return -1;
    const c = Math.floor((x - PAD_L) / colW);
    return c < 0 || c >= model.n ? -1 : c;
  }, [colW, model.n]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selectedCol = useMemo(() => {
    if (selectedIndex == null) return -1;
    const R = d.ribbon;
    let best = -1;
    for (let c = 0; c < model.n; c++) if (R.evIdx[model.cols[c]] <= selectedIndex) best = c; else break;
    return best;
  }, [selectedIndex, model, d]);

  // draw
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const raf = requestAnimationFrame(() => {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      cv.width = Math.floor(width * dpr); cv.height = Math.floor(H * dpr);
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, H);
      const fail = resolveVar(cv, '--st-failed');
      const fg = resolveVar(cv, '--fg-1');
      const fg3 = resolveVar(cv, '--fg-3');
      const line = resolveVar(cv, '--line-2');
      const accent = resolveVar(cv, '--accent');
      const R = d.ribbon;
      const { cols, n, markers, maxTokens, maxMs } = model;

      // lane baselines
      ctx.fillStyle = line;
      ctx.fillRect(PAD_L, TOK_Y + TOK_H, innerW, 1);
      ctx.fillRect(PAD_L, LAT_Y + LAT_H, innerW, 1);

      // drag range
      if (drag && drag.a !== drag.b) {
        const a = Math.min(drag.a, drag.b), b = Math.max(drag.a, drag.b);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(xOf(a), 0, (b - a + 1) * colW, H);
      }

      const showText = colW >= 7;
      ctx.font = `10px ${getComputedStyle(cv).fontFamily || 'monospace'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let c = 0; c < n; c++) {
        const j = cols[c];
        const k = R.kind[j];
        const ok = R.ok[j] === 1;
        const x = xOf(c);
        ctx.globalAlpha = ok ? (ALPHA[k] ?? 0.5) : 1;
        ctx.fillStyle = ok ? fg : fail;
        if (showText) ctx.fillText(ok || k === K.REPAIR ? GLYPH[k] ?? '·' : '✕', x + colW / 2, GLYPH_Y + GLYPH_H / 2);
        else ctx.fillRect(x, GLYPH_Y + (ok ? 8 : 0), Math.max(1, colW - (colW > 2 ? 1 : 0)), ok ? GLYPH_H - 8 : GLYPH_H);
        // confidence underline: opacity = confidence
        const conf = R.conf[j];
        if (conf >= 0) {
          ctx.globalAlpha = Math.min(1, Math.max(0.05, conf));
          ctx.fillStyle = accent;
          ctx.fillRect(x, GLYPH_Y + GLYPH_H + 2, Math.max(1, colW - 1), 2);
        }
        // token lane bar
        const tk = R.tokens[j];
        if (tk > 0 && maxTokens > 0) {
          const h = Math.max(1, (tk / maxTokens) * TOK_H);
          ctx.globalAlpha = 0.45; ctx.fillStyle = fg;
          ctx.fillRect(x, TOK_Y + TOK_H - h, Math.max(1, colW - 1), h);
        }
      }
      // latency lane polyline (log scale)
      if (n > 1 && maxMs > 0) {
        const lm = Math.log1p(maxMs);
        ctx.globalAlpha = 0.6; ctx.strokeStyle = fg; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let c = 0; c < n; c++) {
          const ms = R.ms[cols[c]];
          const y = LAT_Y + LAT_H - (Math.log1p(ms) / lm) * LAT_H;
          const x = xOf(c) + colW / 2;
          if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // markers
      ctx.globalAlpha = 0.85;
      for (const m of markers) {
        const x = xOf(m.col) - 0.5;
        // checkpoint.saved fires every step: faint baseline tick only
        if (m.kind === K.CHECKPOINT) {
          ctx.globalAlpha = 0.25; ctx.fillStyle = fg3;
          ctx.fillRect(x, GLYPH_Y + GLYPH_H + 5, 1, 2);
          ctx.globalAlpha = 0.85;
          continue;
        }
        ctx.fillStyle = m.kind === K.STEER || m.kind === K.APPROVAL ? accent : m.kind === K.CANCEL ? fail : fg3;
        ctx.fillRect(x, GLYPH_Y - 4, 1, GLYPH_H + 8);
        if (colW >= 4 || markers.length < 200) ctx.fillText(MARK[m.kind] ?? '|', x, GLYPH_Y - 1);
      }
      // selection
      if (selectedCol >= 0) {
        ctx.globalAlpha = 1; ctx.strokeStyle = accent; ctx.lineWidth = 1;
        ctx.strokeRect(xOf(selectedCol) + 0.5, 1.5, Math.max(1, colW - 1), H - 3);
      }
      // hover
      if (hover && hover.col >= 0) {
        ctx.globalAlpha = 0.12; ctx.fillStyle = fg;
        ctx.fillRect(xOf(hover.col), 0, Math.max(1, colW), H);
      }
      // live head caret
      ctx.globalAlpha = 1;
      if (n > 0 || openSpanLabel) {
        const hx = xOf(n) + 1;
        ctx.fillStyle = openSpanLabel ? resolveVar(cv, '--st-thinking') : fg3;
        ctx.fillRect(hx, GLYPH_Y - 2, 1, GLYPH_H + 4);
      }
      ctx.globalAlpha = 1;
    });
    return () => cancelAnimationFrame(raf);
  }, [model, width, hover, selectedCol, drag, openSpanLabel, colW, innerW, xOf, d]);

  const onMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const col = colAt(x);
    setHover(col >= 0 ? { col, x } : null);
    if (downRef.current && Math.abs(x - downRef.current.x) > 3 && col >= 0) {
      setDrag({ a: downRef.current.col, b: col, active: true });
    }
  };
  const onDown = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    downRef.current = { x, col: colAt(x) };
  };
  const onUp = (e: React.MouseEvent) => {
    const start = downRef.current;
    downRef.current = null;
    if (drag?.active) { setDrag({ ...drag, active: false }); return; }
    setDrag(null);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const col = colAt(e.clientX - rect.left);
    if (col < 0 || !start) return;
    const evIdx = d.ribbon.evIdx[model.cols[col]];
    if (e.shiftKey) onRaw(evIdx); else onSelect(evIdx);
  };

  const tooltip = useMemo(() => {
    if (!hover || hover.col < 0 || hover.col >= model.n) return null;
    const j = model.cols[hover.col];
    const evIdx = d.ribbon.evIdx[j];
    const ev = d.events[evIdx];
    if (!ev) return null;
    const base = summarizeEvent(ev, findCall(d.events, evIdx));
    const tk = d.ribbon.tokens[j];
    return tk > 0 ? `${base} · ${fmtNum(tk)} tok` : base;
  }, [hover, model, d]);

  const rangeTotals = useMemo(() => {
    if (!drag || drag.a === drag.b) return null;
    const a = Math.min(drag.a, drag.b), b = Math.max(drag.a, drag.b);
    let tokens = 0, ms = 0, fails = 0;
    const R = d.ribbon;
    for (let c = a; c <= b; c++) {
      const j = model.cols[c];
      tokens += R.tokens[j]; ms += R.ms[j]; if (R.ok[j] !== 1 && R.kind[j] !== K.REPAIR) fails++;
      if (R.kind[j] === K.REPAIR && R.ok[j] !== 1) fails++;
    }
    const s0 = R.step[model.cols[a]], s1 = R.step[model.cols[b]];
    return `steps ${s0}–${s1} · ${b - a + 1} actions · ${fmtNum(tokens)} tok · tool time ${fmtMs(ms)} · ${fails} failures`;
  }, [drag, model, d]);

  return (
    <section className="relative shrink-0 border-t" style={{ height: H + 22, borderColor: V.line2, background: V.bg1 }}
      aria-label="Trajectory ribbon">
      <div className="flex h-[22px] items-center gap-3 px-2 text-[11px]" style={{ color: V.fg3 }}>
        <span>TRAJECTORY</span>
        <span className="font-mono tabular-nums">{model.n ? `${model.n} actions` : 'waiting for first event'}</span>
        {rangeTotals ? (
          <span className="font-mono tabular-nums" style={{ color: V.fg1 }} data-testid="range-totals">
            {rangeTotals} <button type="button" className="ml-1 underline" onClick={() => setDrag(null)}>clear</button>
          </span>
        ) : tooltip ? (
          <span className="truncate font-mono" style={{ color: V.fg1 }} data-testid="ribbon-tooltip">{tooltip}</span>
        ) : (
          <span style={{ color: V.fg4 }}>r read · w write · x shell · ✕ fail · ◆ decision · ⟲ ckpt/compact · ✎ steer · ‖ pause — click to scrub, shift+click raw, drag for totals</span>
        )}
        {openSpanLabel ? <span className="ml-auto shrink-0 font-mono" style={{ color: V.thinking }}>● {openSpanLabel}</span> : null}
      </div>
      <div ref={wrapRef} className="relative" style={{ height: H }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: H, display: 'block', cursor: model.n ? 'crosshair' : 'default', fontFamily: V.mono }}
          onMouseMove={onMove}
          onMouseLeave={() => { setHover(null); downRef.current = null; }}
          onMouseDown={onDown}
          onMouseUp={onUp}
          role="img"
          aria-label={`Trajectory: ${model.n} actions, ${d.failures} failures`}
        />
        <span className="pointer-events-none absolute left-2 text-[11px]" style={{ top: TOK_Y, color: V.fg4 }}>tokens</span>
        <span className="pointer-events-none absolute left-2 text-[11px]" style={{ top: LAT_Y, color: V.fg4 }}>latency</span>
      </div>
    </section>
  );
}
