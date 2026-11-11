'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { parseDiff, toUnifiedPatch, type DiffLine, type FileDiff } from '@/lib/parseDiff';
import { useDiffStream, usePatchActions } from '@/hooks/useDiffStream';

export type StreamingDiffGutterProps = {
  filename: string;
  diffText?: string;
  sessionId?: string | null;
  liveStream?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  className?: string;
};

function gutterLineClass(type: DiffLine['type']): string {
  if (type === 'add') return 'bg-emerald-500/12 text-emerald-100';
  if (type === 'del') return 'bg-rose-500/12 text-rose-200';
  if (type === 'hunk') return 'bg-cyan-500/8 text-cyan-300/70 text-[10px]';
  return 'text-zinc-400';
}

function GutterColumn({
  label,
  lines,
  accent,
  visibleCount,
}: {
  label: string;
  lines: DiffLine[];
  accent: 'rose' | 'emerald';
  visibleCount: number;
}) {
  const visible = lines.slice(0, visibleCount);
  return (
    <div className="flex min-w-0 flex-1 flex-col border-r border-white/5 last:border-r-0">
      <div
        className={`px-2 py-1 text-[9px] uppercase tracking-wider border-b border-white/5 ${
          accent === 'rose'
            ? 'text-rose-400/80 bg-rose-950/25'
            : 'text-emerald-400/80 bg-emerald-950/25'
        }`}
      >
        {label}
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-5" role="list">
        {visible.map((line, i) => (
          <div
            key={`${line.type}-${i}`}
            className={`grid grid-cols-[2.5rem_1fr] gap-1 px-1 py-0.5 ${gutterLineClass(line.type)}`}
            role="listitem"
          >
            <span className="select-none text-right tabular-nums text-zinc-600">
              {line.lineNo ?? (line.type === 'del' || line.type === 'add' ? '·' : '')}
            </span>
            <span className="whitespace-pre-wrap break-all">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function splitGutterColumns(diff: FileDiff): { left: DiffLine[]; right: DiffLine[] } {
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  for (const line of diff.lines) {
    if (line.type === 'hunk') {
      left.push(line);
      right.push(line);
    } else if (line.type === 'del') {
      left.push(line);
    } else if (line.type === 'add') {
      right.push(line);
    } else {
      left.push(line);
      right.push(line);
    }
  }
  return { left, right };
}

export default function StreamingDiffGutter({
  filename,
  diffText: diffTextProp = '',
  sessionId,
  liveStream = false,
  onApprove,
  onReject,
  className = '',
}: StreamingDiffGutterProps) {
  const stream = useDiffStream(sessionId, { filename, enabled: liveStream });
  const effectiveText = liveStream ? stream.diffText : diffTextProp;
  const effectiveFilename = liveStream ? stream.filename : filename;
  const isStreaming = liveStream ? stream.streaming : false;

  const diff = useMemo(
    () => parseDiff(effectiveFilename, effectiveText),
    [effectiveFilename, effectiveText],
  );
  const patch = useMemo(() => toUnifiedPatch(diff, effectiveText), [diff, effectiveText]);
  const { approve: apiApprove, reject: apiReject, status } = usePatchActions(
    sessionId,
    effectiveFilename,
    patch,
  );

  const { left, right } = useMemo(() => splitGutterColumns(diff), [diff]);
  const maxLines = Math.max(left.length, right.length);
  const [visibleCount, setVisibleCount] = useState(maxLines);

  useEffect(() => {
    if (!isStreaming) {
      setVisibleCount(maxLines);
      return;
    }
    setVisibleCount(0);
    if (maxLines === 0) return;
    let i = 0;
    const tick = () => {
      i += 1;
      setVisibleCount(i);
      if (i < maxLines) window.setTimeout(tick, 24);
    };
    const t = window.setTimeout(tick, 24);
    return () => window.clearTimeout(t);
  }, [maxLines, isStreaming, effectiveText]);

  const handleApprove = useCallback(() => {
    if (onApprove) onApprove();
    else void apiApprove();
  }, [apiApprove, onApprove]);

  const handleReject = useCallback(() => {
    if (onReject) onReject();
    else void apiReject();
  }, [apiReject, onReject]);

  return (
    <section
      data-testid="streaming-diff-gutter"
      className={`flex flex-col rounded-xl border border-white/10 bg-[#06061a]/90 backdrop-blur-md overflow-hidden ${className}`}
      aria-label={`Side-by-side diff gutter for ${effectiveFilename}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-white/90">{effectiveFilename}</p>
          <p className="text-[10px] text-zinc-500">
            +{diff.additions} / −{diff.deletions}
            {isStreaming ? (
              <span className="ml-2 inline-flex items-center gap-1 text-cyan-400">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                streaming
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={handleReject}
            className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-950/40 px-2 py-1 text-[10px] text-rose-200 hover:bg-rose-900/50"
          >
            <X className="h-3 w-3" aria-hidden />
            Reject
          </button>
          <button
            type="button"
            onClick={handleApprove}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-950/40 px-2 py-1 text-[10px] text-emerald-200 hover:bg-emerald-900/50"
          >
            <Check className="h-3 w-3" aria-hidden />
            Approve
          </button>
        </div>
      </header>

      <div className="flex min-h-[12rem] flex-1">
        <GutterColumn label="Before" lines={left} accent="rose" visibleCount={visibleCount} />
        <GutterColumn label="After" lines={right} accent="emerald" visibleCount={visibleCount} />
      </div>

      {status !== 'idle' ? (
        <footer className="border-t border-white/5 px-3 py-1 text-[10px] text-zinc-500">
          patch {status}
        </footer>
      ) : null}
    </section>
  );
}
