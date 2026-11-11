'use client';

import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy, FileCode2, Loader2, X } from 'lucide-react';
import DiffViewer from '@/components/DiffViewer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeDiffVisualizerModalProps {
  isOpen: boolean;
  onClose: () => void;
  before?: string;
  after?: string;
  /** Syntax language hint — display only (Monaco-style label). */
  language?: string;
  /** e.g. 'src/components/Foo.tsx' */
  filename?: string;
  /** When provided, fetches diff from /api/tasks/diff?sessionId=X */
  sessionId?: string;
  title?: string;
}

type ActiveTab = 'diff' | 'new';

interface DiffStats {
  added: number;
  removed: number;
  changed: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeDiffStats(before: string, after: string): DiffStats {
  const bLines = before.split('\n');
  const aLines = after.split('\n');
  const added = aLines.filter((l) => !bLines.includes(l)).length;
  const removed = bLines.filter((l) => !aLines.includes(l)).length;
  return { added, removed, changed: Math.min(added, removed) };
}

/** Naively build a unified diff string from before/after text for DiffViewer. */
function buildUnifiedDiff(
  filename: string,
  before: string,
  after: string,
): string {
  const bLines = before === '' ? [] : before.split('\n');
  const aLines = after === '' ? [] : after.split('\n');
  const hunk = [
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${bLines.length} +1,${aLines.length} @@`,
    ...bLines.map((l) => `-${l}`),
    ...aLines.map((l) => `+${l}`),
  ];
  return hunk.join('\n');
}

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TS',
  javascript: 'JS',
  python: 'PY',
  bash: 'SH',
  json: 'JSON',
  css: 'CSS',
  html: 'HTML',
  rust: 'RS',
  go: 'GO',
  yaml: 'YAML',
};

// ---------------------------------------------------------------------------
// Focus trap hook
// ---------------------------------------------------------------------------

function useFocusTrap(containerRef: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !containerRef.current) return;

    const el = containerRef.current;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    // Focus first element on mount
    first?.focus();

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (focusable.length === 0) { e.preventDefault(); return; }
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    el.addEventListener('keydown', handleTab);
    return () => el.removeEventListener('keydown', handleTab);
  }, [active, containerRef]);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function CodeDiffVisualizerModal({
  isOpen,
  onClose,
  before = '',
  after = '',
  language = 'typescript',
  filename = 'file.ts',
  sessionId,
  title,
}: CodeDiffVisualizerModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('diff');
  const [copied, setCopied] = useState(false);

  // Session fetch state
  const [fetchedBefore, setFetchedBefore] = useState<string | null>(null);
  const [fetchedAfter, setFetchedAfter] = useState<string | null>(null);
  const [fetchedFilename, setFetchedFilename] = useState<string | null>(null);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Effective content — session overrides props
  const effectiveBefore = fetchedBefore ?? before;
  const effectiveAfter = fetchedAfter ?? after;
  const effectiveFilename = fetchedFilename ?? filename;

  // ---------------------------------------------------------------------------
  // Fetch from sessionId
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isOpen || !sessionId) return;
    let cancelled = false;
    setFetchLoading(true);
    setFetchError(null);

    fetch(`/api/tasks/diff?sessionId=${encodeURIComponent(sessionId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          before?: string;
          after?: string;
          filename?: string;
        };
        if (cancelled) return;
        setFetchedBefore(data.before ?? '');
        setFetchedAfter(data.after ?? '');
        setFetchedFilename(data.filename ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setFetchLoading(false);
      });

    return () => { cancelled = true; };
  }, [isOpen, sessionId]);

  // Reset fetch state when sessionId changes or modal closes
  useEffect(() => {
    if (!isOpen) {
      setFetchedBefore(null);
      setFetchedAfter(null);
      setFetchedFilename(null);
      setFetchError(null);
      setFetchLoading(false);
    }
  }, [isOpen]);

  // ---------------------------------------------------------------------------
  // Keyboard: Escape to close
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [isOpen, onClose]);

  // Focus trap
  useFocusTrap(panelRef, isOpen);

  // ---------------------------------------------------------------------------
  // Copy handler
  // ---------------------------------------------------------------------------
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(effectiveAfter);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard may be unavailable in test env — silently ignore
    }
  }, [effectiveAfter]);

  // ---------------------------------------------------------------------------
  // Derived stats & diff text
  // ---------------------------------------------------------------------------
  const stats = computeDiffStats(effectiveBefore, effectiveAfter);
  const diffText = buildUnifiedDiff(effectiveFilename, effectiveBefore, effectiveAfter);
  const langLabel = LANGUAGE_LABELS[language.toLowerCase()] ?? language.toUpperCase().slice(0, 6);
  const displayTitle = title ?? `Diff — ${effectiveFilename}`;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[9980] bg-black/60 backdrop-blur-xl"
            aria-hidden="true"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            key="panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 480, damping: 36 }}
            className={[
              'fixed left-1/2 top-[10%] -translate-x-1/2 z-[9985]',
              'w-[96vw] max-w-[900px] max-h-[80vh]',
              'flex flex-col',
              'rounded-xl border',
              'shadow-[0_24px_80px_rgba(0,0,0,0.72),inset_0_1px_0_rgba(255,255,255,0.04)]',
            ].join(' ')}
            style={{
              background: 'rgba(8,10,18,0.88)',
              borderColor: 'rgba(255,255,255,0.06)',
              backdropFilter: 'blur(24px)',
            }}
          >
            {/* ── Header ── */}
            <header className="flex items-center gap-2 shrink-0 px-4 py-2.5 border-b"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              <FileCode2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" aria-hidden />

              {/* Title */}
              <h2
                id={titleId}
                className="text-[11px] font-mono text-zinc-200 truncate flex-1 select-text"
                title={displayTitle}
              >
                {displayTitle}
              </h2>

              {/* Filename pill */}
              {effectiveFilename && (
                <span
                  className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono text-zinc-400 border"
                  style={{ background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.08)' }}
                  aria-label={`File: ${effectiveFilename}`}
                >
                  {effectiveFilename}
                </span>
              )}

              {/* Language badge */}
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold text-cyan-400 border border-cyan-400/20 bg-cyan-400/5 select-none"
                aria-label={`Language: ${language}`}
              >
                {langLabel}
              </span>

              {/* Stats */}
              {!fetchLoading && (
                <span className="hidden sm:flex items-center gap-1.5 tabular-nums">
                  <span className="text-[10px] text-emerald-400" aria-label={`${stats.added} lines added`}>
                    +{stats.added}
                  </span>
                  <span className="text-[10px] text-rose-400" aria-label={`${stats.removed} lines removed`}>
                    −{stats.removed}
                  </span>
                </span>
              )}

              {/* Copy button */}
              <button
                type="button"
                onClick={handleCopy}
                disabled={!effectiveAfter || fetchLoading}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] text-zinc-300 transition-colors duration-100 disabled:opacity-40"
                style={{ background: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.10)' }}
                aria-label="Copy new file content to clipboard"
              >
                {copied
                  ? <Check className="w-3 h-3 text-emerald-400" aria-hidden />
                  : <Copy className="w-3 h-3" aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </button>

              {/* Close */}
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-md text-zinc-500 hover:text-zinc-100 hover:bg-white/5 transition-colors duration-100"
                aria-label="Close diff viewer (Escape)"
              >
                <X className="w-4 h-4" aria-hidden />
              </button>
            </header>

            {/* ── Tab bar ── */}
            <div
              className="flex shrink-0 gap-0 border-b px-4"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}
              role="tablist"
              aria-label="Diff view modes"
            >
              {(['diff', 'new'] as const).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={activeTab === tab}
                  aria-controls={`tabpanel-${tab}`}
                  onClick={() => setActiveTab(tab)}
                  className={[
                    'px-3 py-2 text-[11px] font-mono border-b-2 transition-colors duration-100',
                    activeTab === tab
                      ? 'border-cyan-400 text-cyan-400'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300',
                  ].join(' ')}
                >
                  {tab === 'diff' ? 'Diff' : 'New file'}
                </button>
              ))}
            </div>

            {/* ── Body ── */}
            <div className="flex-1 min-h-0 overflow-auto">
              {fetchLoading ? (
                <div className="flex items-center justify-center h-48 gap-2 text-zinc-500">
                  <Loader2 className="w-4 h-4 animate-spin text-cyan-400" aria-hidden />
                  <span className="text-[11px] font-mono">Fetching diff…</span>
                </div>
              ) : fetchError ? (
                <div className="flex items-center justify-center h-48 px-6 text-center">
                  <p className="text-[11px] font-mono text-rose-400">
                    Failed to load diff: {fetchError}
                  </p>
                </div>
              ) : (
                <>
                  {/* Diff tab */}
                  <div
                    id="tabpanel-diff"
                    role="tabpanel"
                    aria-labelledby="tab-diff"
                    hidden={activeTab !== 'diff'}
                    className="h-full"
                  >
                    {activeTab === 'diff' && (
                      <DiffViewer
                        filename={effectiveFilename}
                        diffText={diffText}
                        streaming={false}
                        className="rounded-none border-0"
                      />
                    )}
                  </div>

                  {/* New file tab */}
                  <div
                    id="tabpanel-new"
                    role="tabpanel"
                    aria-labelledby="tab-new"
                    hidden={activeTab !== 'new'}
                    className="h-full"
                  >
                    {activeTab === 'new' && (
                      <pre
                        className="font-mono text-[11px] leading-5 text-zinc-300 whitespace-pre-wrap break-all p-4 m-0 select-text"
                        aria-label="New file content"
                      >
                        {effectiveAfter || (
                          <span className="text-zinc-600 italic">No content</span>
                        )}
                      </pre>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* ── Footer ── */}
            <footer
              className="flex items-center justify-between shrink-0 px-4 py-1.5 border-t"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}
            >
              <div className="flex items-center gap-3 tabular-nums">
                {!fetchLoading && (
                  <>
                    <span className="text-[10px] text-zinc-600 font-mono">
                      <span className="text-emerald-400">+{stats.added}</span>
                      {' / '}
                      <span className="text-rose-400">−{stats.removed}</span>
                      {stats.changed > 0 && (
                        <span className="text-zinc-500"> · {stats.changed} changed</span>
                      )}
                    </span>
                    {sessionId && (
                      <span className="text-[10px] text-zinc-600 font-mono">
                        session <span className="text-cyan-400/70">{sessionId}</span>
                      </span>
                    )}
                  </>
                )}
              </div>
              <span className="text-[10px] text-zinc-700 select-none">
                <kbd className="px-1 py-0.5 rounded border border-white/10 bg-white/5 text-zinc-500 text-[9px]">Esc</kbd>
                {' '}to close
              </span>
            </footer>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
