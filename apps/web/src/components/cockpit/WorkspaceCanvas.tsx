'use client';

import React, { useEffect, useMemo, useState } from 'react';
import StreamingDiffGutter from '@/components/diff/StreamingDiffGutter';
import { fmtMs, type FileEntry, type RunDerived } from '@/stores/runStore';
import { numCls, V } from './theme';

/** Edits within the last 20 steps → 0..3 heat cells. */
export function fileHeat(f: FileEntry, currentStep: number): number {
  const recent = f.revisions.filter((r) => r.step > currentStep - 20).length;
  return recent >= 5 ? 3 : recent >= 2 ? 2 : recent >= 1 ? 1 : 0;
}

function HeatBar({ n }: { n: number }) {
  return (
    <span aria-label={`heat ${n} of 3`} className="inline-flex gap-[2px]">
      {[0, 1, 2].map((i) => (
        <span key={i} className="inline-block h-2.5 w-1" style={{ background: i < n ? V.fg2 : V.line2 }} />
      ))}
    </span>
  );
}

export default function WorkspaceCanvas({
  d, summary, onSelectEventIndex, isScrubbed,
}: {
  d: RunDerived;
  summary?: string;
  onSelectEventIndex: (evIdx: number) => void;
  isScrubbed: boolean;
}) {
  const files = useMemo(() => {
    const arr = [...d.files.values()];
    arr.sort((a, b) => (fileHeat(b, d.step) - fileHeat(a, d.step)) || (b.lastSeq - a.lastSeq) || a.path.localeCompare(b.path));
    return arr;
  }, [d, d.files.size, d.step, d.events.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const [pinned, setPinned] = useState<string | null>(null);
  const [revOffset, setRevOffset] = useState(0); // 0 = latest
  const [termOpen, setTermOpen] = useState(false);

  // Follow the most recently touched file unless one is pinned.
  const latest = useMemo(() => {
    let best: FileEntry | undefined;
    for (const f of d.files.values()) if (!best || f.lastSeq > best.lastSeq) best = f;
    return best;
  }, [d, d.events.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = (pinned && d.files.get(pinned)) || latest;
  useEffect(() => { setRevOffset(0); }, [active?.path]);

  const revs = active?.revisions ?? [];
  const revIndex = Math.max(0, revs.length - 1 - revOffset);
  const rev = revs[revIndex];

  const empty = d.events.length === 0;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: V.bg0 }} aria-label="Workspace">
      <div className="flex min-h-0 flex-1">
        {/* file heat list */}
        <div className="flex w-[280px] shrink-0 flex-col border-r" style={{ borderColor: V.line1 }}>
          <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider" style={{ color: V.fg3 }}>
            Files <span style={{ color: V.fg4 }}>(heat = edits in last 20 steps)</span>
          </div>
          <ul className="min-h-0 flex-1 overflow-auto font-mono text-[12px]" role="listbox" aria-label="Files touched">
            {files.length === 0 ? (
              <li className="px-3 py-2 text-[11px]" style={{ color: V.fg4 }}>{empty ? 'waiting for first event' : 'no files touched yet'}</li>
            ) : files.map((f) => {
              const isActive = active?.path === f.path;
              return (
                <li key={f.path} role="option" aria-selected={isActive}>
                  <button type="button" onClick={() => setPinned(pinned === f.path ? null : f.path)}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left"
                    style={{ background: isActive ? V.bg2 : 'transparent', color: f.failed ? V.failed : V.fg2 }}
                    title={f.failed ? `failed: ${f.failReason ?? ''}` : `${f.edits} edits · last step ${f.lastStep}`}>
                    <HeatBar n={fileHeat(f, d.step)} />
                    <span className={`min-w-0 flex-1 truncate ${f.failed ? 'line-through' : ''}`}>{f.path}</span>
                    {f.failed ? <span className="text-[11px]">✕ failed</span>
                      : f.lastStep && f.lastStep === d.step ? <span className="text-[11px]" style={{ color: V.accent }}>● now</span>
                      : pinned === f.path ? <span className="text-[11px]" style={{ color: V.fg3 }}>pinned</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* diff pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          {active && rev ? (
            <>
              <div className={`flex items-center gap-2 border-b px-3 py-1 text-[12px] ${numCls}`} style={{ borderColor: V.line1, color: V.fg2 }}>
                <span className="truncate" style={{ color: V.fg1 }}>{active.path}</span>
                <span style={{ color: V.done }}>+{rev.adds}</span>
                <span style={{ color: V.failed }}>−{rev.dels}</span>
                <span style={{ color: V.fg4 }}>{rev.op} · step {rev.step}{rev.reconstructed ? ' · reconstructed from params' : ''}</span>
                <span className="ml-auto flex items-center gap-1">
                  <button type="button" aria-label="Previous revision" disabled={revIndex <= 0}
                    onClick={() => setRevOffset((o) => o + 1)} className="px-1 disabled:opacity-30">◀</button>
                  <span style={{ color: V.fg3 }}>{revIndex + 1}/{revs.length}</span>
                  <button type="button" aria-label="Next revision" disabled={revOffset === 0}
                    onClick={() => setRevOffset((o) => Math.max(0, o - 1))} className="px-1 disabled:opacity-30">▶</button>
                </span>
              </div>
              {rev.patch ? (
                // Read-only here: approvals go through the run's approval gate
                // (ControlDeck), so the gutter's own approve/reject is hidden.
                <div className="min-h-0 flex-1 overflow-hidden [&_header_button]:hidden [&_footer]:hidden">
                  <StreamingDiffGutter key={`${active.path}:${rev.seq}`} filename={active.path} diffText={rev.patch}
                    className="h-full !rounded-none !border-0 !bg-transparent" />
                </div>
              ) : (
                <div className="p-3 text-[12px]" style={{ color: V.fg4 }}>no patch captured for this revision</div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px]" style={{ color: V.fg4 }}>
              {active ? `${active.path} — written before this view; no diff captured` : empty ? 'waiting for first event' : 'no file changes yet'}
            </div>
          )}
        </div>
      </div>

      {/* terminal strip */}
      <div className="shrink-0 border-t font-mono text-[12px]" style={{ borderColor: V.line1, background: V.bg1 }}>
        {d.lastShell ? (
          <button type="button" className="block w-full px-3 py-1.5 text-left" onClick={() => setTermOpen((o) => !o)}
            aria-expanded={termOpen} aria-label="Last shell command">
            <div className="flex items-center gap-2">
              <span style={{ color: V.fg3 }}>$</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: V.fg1 }}>{d.lastShell.command ?? '—'}</span>
              <span className="tabular-nums" style={{ color: d.lastShell.ok ? V.fg3 : V.failed }}>
                exit {d.lastShell.exit_code ?? (d.lastShell.ok ? '—' : '≠0')} · {fmtMs(d.lastShell.ms)} · step {d.lastShell.step}
              </span>
            </div>
            <pre className={`mt-1 overflow-auto whitespace-pre-wrap text-[11px] ${termOpen ? 'max-h-64' : 'max-h-[3.2em]'}`}
              style={{ color: d.lastShell.ok ? V.fg3 : V.failed }}>
              {(termOpen ? d.lastShell.tail : d.lastShell.tail.split('\n').slice(-3).join('\n')) || '(no output)'}
            </pre>
          </button>
        ) : (
          <div className="px-3 py-1.5 text-[11px]" style={{ color: V.fg4 }}>$ — no shell commands yet</div>
        )}
      </div>

      {/* decisions + summary */}
      {(d.decisions.length > 0 || summary) ? (
        <div className="max-h-28 shrink-0 overflow-auto border-t px-3 py-1.5" style={{ borderColor: V.line1 }}>
          {d.decisions.slice(-4).reverse().map((dec) => {
            const idx = d.events.findIndex((e) => e.seq === dec.seq);
            return (
              <button key={dec.seq} type="button" onClick={() => idx >= 0 && onSelectEventIndex(idx)}
                className="flex w-full items-baseline gap-2 py-0.5 text-left text-[12px]" title={dec.rationale}>
                <span style={{ color: V.accent }}>◆</span>
                <span className="truncate" style={{ color: V.fg1 }}>{dec.title}</span>
                <span className={`ml-auto shrink-0 text-[11px] ${numCls}`} style={{ color: V.fg3 }}>
                  step {dec.step}{dec.confidence != null ? ` · conf ${dec.confidence.toFixed(2)}` : ''}
                </span>
              </button>
            );
          })}
          {summary && !isScrubbed ? (
            <p className="py-0.5 text-[12px]" style={{ color: V.fg2 }}><span style={{ color: V.fg3 }}>summary </span>{summary}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
