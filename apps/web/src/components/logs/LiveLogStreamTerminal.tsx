'use client';

/**
 * LiveLogStreamTerminal
 *
 * Enhanced execution log terminal with:
 * - SSE log streaming via EventSource
 * - Color-coded log kind badges (system/output/error/input)
 * - Auto-scroll with manual override
 * - Filter bar (kind + text search)
 * - Virtual rendering for large log sets (window of maxLines)
 * - Framer Motion entry animations per batch
 * - Keyboard: Ctrl+F focuses filter, Escape blurs, End scrolls to tail
 * - Resilient: reconnects on error, falls back to polling journal from useSwarmTelemetry
 *
 * Design tokens: bg #050508, surface rgba(8,10,18,0.72), border rgba(255,255,255,0.06),
 * accent cyan-400, font-mono, 10-11px dense labels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Radio,
  Terminal,
  Filter,
  X,
  ChevronDown,
  AlertCircle,
  ArrowDownToLine,
  RotateCcw,
} from 'lucide-react';
import { useSwarmTelemetry } from '@/hooks/useSwarmTelemetry';

// ─── Types ─────────────────────────────────────────────────────────────────

export type LogKind = 'system' | 'output' | 'error' | 'input' | 'warn' | 'info';

export type LogLine = {
  id: string;
  ts: number;
  kind: LogKind;
  message: string;
  worker_id?: string;
  task_id?: string;
};

export type LiveLogStreamTerminalProps = {
  /** SSE endpoint — defaults to /api/logs/stream */
  endpoint?: string;
  /** Maximum lines kept in memory */
  maxLines?: number;
  /** External log lines to merge (e.g. from useMissionTerminalFeed) */
  externalLines?: Array<{ kind: LogKind; text: string; ts?: number }>;
  className?: string;
  /** Default collapsed height; expanding shows full terminal */
  defaultExpanded?: boolean;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const KIND_STYLES: Record<LogKind, { dot: string; text: string; badge: string }> = {
  system:  { dot: 'bg-cyan-400',   text: 'text-cyan-400/90',   badge: 'text-cyan-500/70 bg-cyan-500/10' },
  output:  { dot: 'bg-emerald-400',text: 'text-zinc-300',      badge: 'text-emerald-500/70 bg-emerald-500/10' },
  input:   { dot: 'bg-violet-400', text: 'text-violet-300/80', badge: 'text-violet-500/70 bg-violet-500/10' },
  error:   { dot: 'bg-rose-500',   text: 'text-rose-300',      badge: 'text-rose-500/70 bg-rose-500/10' },
  warn:    { dot: 'bg-amber-400',  text: 'text-amber-300',     badge: 'text-amber-500/70 bg-amber-500/10' },
  info:    { dot: 'bg-zinc-400',   text: 'text-zinc-400',      badge: 'text-zinc-500/60 bg-zinc-500/10' },
};

const ALL_KINDS: LogKind[] = ['system', 'output', 'error', 'input', 'warn', 'info'];

let idCounter = 0;
function makeId() { return `log-${Date.now()}-${idCounter++}`; }

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function LiveLogStreamTerminal({
  endpoint = '/api/logs/stream',
  maxLines = 500,
  externalLines,
  className = '',
  defaultExpanded = true,
}: LiveLogStreamTerminalProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [filterKind, setFilterKind] = useState<LogKind | 'all'>('all');
  const [filterText, setFilterText] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showFilter, setShowFilter] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);

  const esRef = useRef<EventSource | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  // Fallback: use swarm telemetry journal if SSE unavailable
  const telemetry = useSwarmTelemetry(6000);

  // Append lines helper
  const appendLines = useCallback((incoming: LogLine[]) => {
    setLines(prev => {
      const merged = [...prev, ...incoming];
      return merged.length > maxLines ? merged.slice(merged.length - maxLines) : merged;
    });
  }, [maxLines]);

  // SSE connection
  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      try {
        es = new EventSource(endpoint);
        esRef.current = es;

        es.onopen = () => {
          setLive(true);
          setError(null);
        };

        es.onmessage = (msg) => {
          try {
            const raw = JSON.parse(msg.data);
            const kind = (raw.kind ?? 'output') as LogKind;
            appendLines([{
              id: makeId(),
              ts: raw.ts ?? Date.now(),
              kind: ALL_KINDS.includes(kind) ? kind : 'output',
              message: String(raw.message ?? raw.text ?? msg.data),
              worker_id: raw.worker_id,
              task_id: raw.task_id,
            }]);
          } catch {
            // malformed event — silently skip
          }
        };

        es.onerror = () => {
          setLive(false);
          setError('Stream disconnected — reconnecting…');
          es?.close();
          esRef.current = null;
          retryTimeout = setTimeout(() => {
            setReconnectCount(n => n + 1);
          }, 3000);
        };
      } catch {
        setLive(false);
        setError('SSE not available');
      }
    }

    connect();
    return () => {
      es?.close();
      esRef.current = null;
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  // reconnectCount triggers a fresh connection after errors
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, reconnectCount]);

  // Ingest external lines
  useEffect(() => {
    if (!externalLines?.length) return;
    const incoming = externalLines.map(l => ({
      id: makeId(),
      ts: l.ts ?? Date.now(),
      kind: ALL_KINDS.includes(l.kind) ? l.kind : 'output' as LogKind,
      message: l.text,
    }));
    appendLines(incoming);
  }, [externalLines, appendLines]);

  // Fallback: inject telemetry journal when SSE is unavailable
  useEffect(() => {
    if (live) return;
    if (!telemetry.journal.length) return;
    const incoming: LogLine[] = telemetry.journal.map(j => ({
      id: makeId(),
      ts: telemetry.lastUpdate,
      kind: 'system' as LogKind,
      message: j,
    }));
    // Only inject if we have no lines yet (avoid spamming)
    setLines(prev => {
      if (prev.length > 0) return prev;
      return incoming;
    });
  }, [live, telemetry.journal, telemetry.lastUpdate]);

  // Auto-scroll
  useEffect(() => {
    if (!autoScroll || !expanded) return;
    tailRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length, autoScroll, expanded]);

  // Scroll detection — disable auto-scroll if user scrolls up
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowFilter(v => !v);
        setTimeout(() => filterInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape') {
        filterInputRef.current?.blur();
      }
      if (e.key === 'End') {
        tailRef.current?.scrollIntoView({ behavior: 'smooth' });
        setAutoScroll(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Filtered display lines
  const displayLines = useMemo(() => {
    let filtered = lines;
    if (filterKind !== 'all') filtered = filtered.filter(l => l.kind === filterKind);
    if (filterText.trim()) {
      const q = filterText.toLowerCase();
      filtered = filtered.filter(l => l.message.toLowerCase().includes(q));
    }
    return filtered;
  }, [lines, filterKind, filterText]);

  const errorCount = useMemo(() => lines.filter(l => l.kind === 'error').length, [lines]);

  function clearLogs() {
    setLines([]);
  }

  return (
    <section
      data-testid="live-log-stream-terminal"
      aria-label="Live execution log terminal"
      className={`flex flex-col overflow-hidden rounded-lg border border-white/[0.06] ${className}`}
      style={{ background: 'rgba(5, 5, 8, 0.95)' }}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5 shrink-0">
        <Terminal className="h-3.5 w-3.5 text-zinc-500" aria-hidden />

        <div className="flex items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5" aria-hidden>
            <span
              className={`absolute inline-flex h-full w-full rounded-full ${live ? 'animate-ping bg-emerald-400/60' : 'bg-zinc-600'}`}
            />
            <span
              className={`relative inline-flex h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-zinc-600'}`}
            />
          </span>
          <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
            {live ? 'LIVE' : 'STREAM'}
          </span>
        </div>

        {errorCount > 0 && (
          <span className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-rose-400/80 bg-rose-500/10">
            <AlertCircle className="h-2.5 w-2.5" aria-hidden />
            {errorCount} err
          </span>
        )}

        <span className="ml-auto flex items-center gap-1">
          {/* Filter toggle */}
          <button
            type="button"
            onClick={() => { setShowFilter(v => !v); setTimeout(() => filterInputRef.current?.focus(), 50); }}
            className={`inline-flex h-5 w-5 items-center justify-center rounded transition-colors ${showFilter ? 'text-cyan-400 bg-cyan-400/10' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'}`}
            aria-label="Toggle filter bar (Ctrl+F)"
            title="Filter (Ctrl+F)"
          >
            <Filter className="h-3 w-3" aria-hidden />
          </button>

          {/* Scroll to tail */}
          {!autoScroll && (
            <button
              type="button"
              onClick={() => { tailRef.current?.scrollIntoView({ behavior: 'smooth' }); setAutoScroll(true); }}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-cyan-400/70 hover:text-cyan-300 hover:bg-white/[0.04] transition-colors"
              aria-label="Scroll to latest log entry"
              title="Scroll to tail (End)"
            >
              <ArrowDownToLine className="h-3 w-3" aria-hidden />
            </button>
          )}

          {/* Reconnect button when errored */}
          {error && (
            <button
              type="button"
              onClick={() => setReconnectCount(n => n + 1)}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-amber-400/70 hover:text-amber-300 transition-colors"
              aria-label="Reconnect log stream"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
            </button>
          )}

          {/* Clear */}
          <button
            type="button"
            onClick={clearLogs}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors"
            aria-label="Clear log terminal"
            title="Clear logs"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>

          {/* Collapse toggle */}
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors"
            aria-label={expanded ? 'Collapse terminal' : 'Expand terminal'}
            aria-expanded={expanded}
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`}
              aria-hidden
            />
          </button>
        </span>
      </div>

      {/* ── Filter bar ─────────────────────────────────────────── */}
      <AnimatePresence>
        {showFilter && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5 overflow-hidden shrink-0"
          >
            {/* Kind filter pills */}
            <div className="flex items-center gap-1 flex-wrap">
              {(['all', ...ALL_KINDS] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFilterKind(k)}
                  className={`rounded px-2 py-0.5 text-[10px] font-mono transition-colors ${
                    filterKind === k
                      ? 'bg-cyan-400/15 text-cyan-300'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
            <span className="h-3 w-px bg-white/[0.06] shrink-0" aria-hidden />
            {/* Text search */}
            <input
              ref={filterInputRef}
              type="search"
              placeholder="Search logs…"
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              className="flex-1 min-w-0 bg-transparent text-[11px] font-mono text-zinc-300 placeholder:text-zinc-600 outline-none"
              aria-label="Search log messages"
            />
            {filterText && (
              <button type="button" onClick={() => setFilterText('')} className="text-zinc-600 hover:text-zinc-300">
                <X className="h-3 w-3" aria-hidden />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Error banner ────────────────────────────────────────── */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1 shrink-0"
          >
            <Radio className="h-2.5 w-2.5 text-amber-400" aria-hidden />
            <span className="text-[10px] font-mono text-amber-400/80">{error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Log body ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: '100%' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.2 }}
            ref={containerRef}
            onScroll={handleScroll}
            className="flex-1 min-h-[8rem] overflow-y-auto font-mono text-[10px] leading-5 p-2 scrollbar-none"
            role="log"
            aria-live="polite"
            aria-label="Execution log output"
          >
            {displayLines.length === 0 ? (
              <p className="text-zinc-600 pt-1">
                {filterText || filterKind !== 'all'
                  ? 'No lines match the current filter.'
                  : 'Waiting for log stream…'}
              </p>
            ) : (
              <AnimatePresence initial={false}>
                {displayLines.map((line, idx) => {
                  const style = KIND_STYLES[line.kind] ?? KIND_STYLES.output;
                  return (
                    <motion.div
                      key={line.id}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.12, delay: Math.min(idx * 0.008, 0.1) }}
                      className="flex items-baseline gap-2 group py-0.5 hover:bg-white/[0.02] rounded px-1 -mx-1"
                    >
                      {/* Timestamp */}
                      <span className="shrink-0 text-zinc-700 tabular-nums" aria-hidden>
                        {formatTs(line.ts)}
                      </span>
                      {/* Kind badge */}
                      <span
                        className={`shrink-0 rounded px-1 py-0 text-[9px] uppercase tracking-wider ${style.badge}`}
                        aria-label={`log kind: ${line.kind}`}
                      >
                        {line.kind}
                      </span>
                      {/* Worker ID if present */}
                      {line.worker_id && (
                        <span className="shrink-0 text-zinc-700 text-[9px] tabular-nums">
                          [{line.worker_id.slice(0, 8)}]
                        </span>
                      )}
                      {/* Message */}
                      <span className={`flex-1 min-w-0 break-all ${style.text}`}>
                        {line.message}
                      </span>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
            <div ref={tailRef} aria-hidden />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Footer stats ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-t border-white/[0.04] px-3 py-1 shrink-0">
        <span className="text-[9px] font-mono tabular-nums text-zinc-700">
          {displayLines.length}/{lines.length} lines
        </span>
        {filterKind !== 'all' || filterText ? (
          <span className="text-[9px] font-mono text-cyan-500/60">filtered</span>
        ) : null}
        <span className="ml-auto text-[9px] font-mono text-zinc-700">
          {autoScroll ? 'auto-scroll' : 'manual scroll'}
        </span>
      </div>
    </section>
  );
}
