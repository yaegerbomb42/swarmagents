'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, GitCompare, Loader2 } from 'lucide-react';
import { parseDiff, toUnifiedPatch, type DiffLine, type FileDiff } from '@/lib/parseDiff';
import { useDiffStream, usePatchActions } from '@/hooks/useDiffStream';

export type DiffViewerProps = {
  filename: string;
  diffText: string;
  streaming?: boolean;
  sideBySide?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
  /** When set, subscribes to /api/console/diff SSE for live hunks. */
  sessionId?: string | null;
  liveStream?: boolean;
  className?: string;
};

function lineClass(type: DiffLine['type']): string {
  switch (type) {
    case 'add':
      return 'bg-emerald-500/10 border-l-2 border-emerald-500/50 text-emerald-100';
    case 'del':
      return 'bg-rose-500/10 border-l-2 border-rose-500/50 text-rose-200 line-through decoration-rose-400/40';
    case 'hunk':
      return 'bg-cyan-500/5 text-cyan-300/70 italic';
    default:
      return 'text-zinc-300 border-l-2 border-transparent';
  }
}

function gutterPrefix(type: DiffLine['type']): string {
  if (type === 'add') return '+';
  if (type === 'del') return '-';
  if (type === 'hunk') return '@';
  return ' ';
}

function UnifiedDiffBody({
  diff,
  visibleCount,
}: {
  diff: FileDiff;
  visibleCount: number;
}) {
  const lines = diff.lines.slice(0, visibleCount);
  return (
    <div className="font-mono text-[11px] leading-5 select-text" role="region" aria-label="Unified diff">
      {lines.map((line, i) => (
        <div key={`${line.type}-${i}`} className={`flex min-w-0 ${lineClass(line.type)}`}>
          <span className="shrink-0 w-6 text-right pr-2 tabular-nums text-zinc-600 select-none">
            {line.lineNo ?? ''}
          </span>
          <span
            className={`shrink-0 w-4 text-center select-none ${
              line.type === 'add'
                ? 'text-emerald-400'
                : line.type === 'del'
                  ? 'text-rose-400'
                  : 'text-zinc-600'
            }`}
          >
            {gutterPrefix(line.type)}
          </span>
          <pre className="flex-1 min-w-0 whitespace-pre-wrap break-all m-0 py-0.5 pr-3">{line.content}</pre>
        </div>
      ))}
      {visibleCount < diff.lines.length && (
        <div className="px-3 py-1 text-[10px] text-cyan-400/60 animate-pulse">streaming…</div>
      )}
    </div>
  );
}

function SideBySideBody({ diff }: { diff: FileDiff }) {
  const left = diff.lines.filter((l) => l.type === 'del' || l.type === 'context' || l.type === 'hunk');
  const right = diff.lines.filter((l) => l.type === 'add' || l.type === 'context' || l.type === 'hunk');

  const renderCol = (lines: DiffLine[], accent: 'rose' | 'emerald') => (
    <div className="flex-1 min-w-0 overflow-auto border-r border-white/5 last:border-r-0">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`font-mono text-[11px] leading-5 px-2 py-0.5 whitespace-pre-wrap break-all ${
            line.type === 'add' && accent === 'emerald'
              ? 'bg-emerald-500/10 text-emerald-100'
              : line.type === 'del' && accent === 'rose'
                ? 'bg-rose-500/10 text-rose-200'
                : line.type === 'hunk'
                  ? 'bg-cyan-500/5 text-cyan-300/60 text-[10px]'
                  : 'text-zinc-400'
          }`}
        >
          {line.content}
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1" role="region" aria-label="Side by side diff">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="text-[9px] uppercase tracking-wider text-rose-400/70 px-2 py-1 border-b border-white/5 bg-rose-950/20">
          Before
        </div>
        {renderCol(left, 'rose')}
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="text-[9px] uppercase tracking-wider text-emerald-400/70 px-2 py-1 border-b border-white/5 bg-emerald-950/20">
          After
        </div>
        {renderCol(right, 'emerald')}
      </div>
    </div>
  );
}

export default function DiffViewer({
  filename,
  diffText: diffTextProp,
  streaming = false,
  sideBySide = false,
  onApprove,
  onReject,
  sessionId,
  liveStream = false,
  className = '',
}: DiffViewerProps) {
  const stream = useDiffStream(sessionId, { filename, enabled: liveStream });
  const effectiveText = liveStream ? stream.diffText : diffTextProp;
  const effectiveFilename = liveStream ? stream.filename : filename;
  const isStreaming = liveStream ? stream.streaming : streaming;

  const diff = useMemo(() => parseDiff(effectiveFilename, effectiveText), [effectiveFilename, effectiveText]);
  const patch = useMemo(() => toUnifiedPatch(diff, effectiveText), [diff, effectiveText]);
  const { approve: apiApprove, reject: apiReject, status: patchStatus } = usePatchActions(
    sessionId,
    effectiveFilename,
    patch,
  );

  const [visibleCount, setVisibleCount] = useState(isStreaming ? 0 : diff.lines.length);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (liveStream) {
      setVisibleCount(diff.lines.length);
      return;
    }
    if (!isStreaming) {
      setVisibleCount(diff.lines.length);
      return;
    }
    setVisibleCount(0);
    if (diff.lines.length === 0) return;
    let i = 0;
    const tick = () => {
      i += 1;
      setVisibleCount(i);
      if (i < diff.lines.length) {
        window.setTimeout(tick, 28);
      }
    };
    const t = window.setTimeout(tick, 28);
    return () => window.clearTimeout(t);
  }, [diff.lines.length, isStreaming, effectiveText, liveStream]);

  const copyPatch = useCallback(async () => {
    await navigator.clipboard.writeText(patch);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [patch]);

  const handleApprove = useCallback(async () => {
    if (liveStream && sessionId) await apiApprove();
    onApprove?.();
  }, [apiApprove, liveStream, onApprove, sessionId]);

  const handleReject = useCallback(async () => {
    if (liveStream && sessionId) await apiReject();
    onReject?.();
  }, [apiReject, liveStream, onReject, sessionId]);

  const showApprove = onApprove || (liveStream && sessionId);
  const showReject = onReject || (liveStream && sessionId);

  return (
    <div
      className={`flex flex-col h-full min-h-0 rounded-xl border border-white/10 bg-[#0a0a0f]/80 backdrop-blur-[12px] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${className}`}
    >
      <div className="flex items-center gap-2 shrink-0 px-3 py-2 border-b border-white/8 bg-white/[0.02]">
        <GitCompare className="w-3.5 h-3.5 text-cyan-400 shrink-0" aria-hidden />
        <span className="text-[11px] font-mono text-zinc-200 truncate flex-1">{effectiveFilename}</span>
        {isStreaming && <Loader2 className="w-3 h-3 text-cyan-400 animate-spin shrink-0" aria-hidden />}
        {patchStatus === 'approved' && (
          <span className="text-[9px] text-emerald-400 uppercase tracking-wide">approved</span>
        )}
        {patchStatus === 'rejected' && (
          <span className="text-[9px] text-rose-400 uppercase tracking-wide">rejected</span>
        )}
        <span className="text-[10px] text-emerald-400 tabular-nums">+{diff.additions}</span>
        <span className="text-[10px] text-rose-400 tabular-nums">-{diff.deletions}</span>
        <button
          type="button"
          onClick={copyPatch}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-white/[0.08] transition-colors duration-100"
          aria-label="Copy patch"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Patch'}
        </button>
        {showReject && (
          <button
            type="button"
            onClick={handleReject}
            disabled={patchStatus === 'rejected'}
            className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-200 hover:bg-rose-500/20 transition-colors duration-100 disabled:opacity-40"
          >
            Reject
          </button>
        )}
        {showApprove && (
          <button
            type="button"
            onClick={handleApprove}
            disabled={patchStatus === 'approved' || (liveStream && isStreaming)}
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/20 transition-colors duration-100 disabled:opacity-40"
          >
            Approve
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto py-1">
        {sideBySide ? (
          <SideBySideBody diff={diff} />
        ) : (
          <UnifiedDiffBody diff={diff} visibleCount={visibleCount} />
        )}
      </div>
    </div>
  );
}
