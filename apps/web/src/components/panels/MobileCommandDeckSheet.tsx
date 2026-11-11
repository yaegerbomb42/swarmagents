'use client';

// ════════════════════════════════════════════════════════════
//  MobileCommandDeckSheet — gesture-driven bottom sheet Command Center
//
//  Tabs:
//    Fleet    — FleetTelemetryStrip in vertical stack
//    Queue    — top tasks from /api/swarm/status (next_pending) or demo
//    Terminal — last 8 journal lines from useSwarmTelemetry (static mock)
//
//  Notes:
//    - /api/telemetry is SSE-only — never fetch().json() it.
//      Journal lines come from useSwarmTelemetry instead.
//    - Drag-to-dismiss: velocity ≥ 400 px/s or drag-Y ≥ 120 px dismisses.
//    - window.visualViewport tracked to account for soft keyboard push.
// ════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, PanInfo } from 'framer-motion';
import { X, Layers, ListTodo, Terminal } from 'lucide-react';

import FleetTelemetryStrip from '@/components/fleet/FleetTelemetryStrip';
import { useSwarmTelemetry } from '@/hooks/useSwarmTelemetry';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MobileCommandDeckSheetProps {
  isOpen: boolean;
  onClose: () => void;
  className?: string;
}

type Tab = 'fleet' | 'queue' | 'terminal';

interface PendingTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
}

// ── Demo fallback data ─────────────────────────────────────────────────────────

const DEMO_TASKS: PendingTask[] = [
  { id: 'demo-1', title: 'Analyse repository structure', status: 'pending', priority: 'high' },
  { id: 'demo-2', title: 'Generate test coverage report', status: 'pending', priority: 'normal' },
  { id: 'demo-3', title: 'Refactor routing matrix', status: 'queued', priority: 'normal' },
  { id: 'demo-4', title: 'Benchmark quantum solver', status: 'queued', priority: 'low' },
  { id: 'demo-5', title: 'Deploy staging environment', status: 'pending', priority: 'high' },
];

// ── Priority badge ─────────────────────────────────────────────────────────────

const PRIORITY_COLOUR: Record<string, string> = {
  high: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
  normal: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
  low: 'text-zinc-500 bg-zinc-500/10 border-zinc-500/20',
};

// ── Tab config ────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; Icon: React.ElementType }[] = [
  { id: 'fleet', label: 'Fleet', Icon: Layers },
  { id: 'queue', label: 'Queue', Icon: ListTodo },
  { id: 'terminal', label: 'Terminal', Icon: Terminal },
];

// ── Sub-panels ────────────────────────────────────────────────────────────────

function FleetPanel() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <FleetTelemetryStrip className="w-full" refreshIntervalMs={6000} />
    </div>
  );
}

function QueuePanel() {
  const [tasks, setTasks] = useState<PendingTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/swarm/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          next_pending?: PendingTask[];
          tasks?: PendingTask[];
        };
        if (!cancelled) {
          const list = data.next_pending ?? data.tasks ?? [];
          setTasks(list.length ? list : DEMO_TASKS);
        }
      } catch {
        if (!cancelled) {
          setTasks(DEMO_TASKS);
          setError('offline — demo data');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06] shrink-0">
        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
          Pending tasks
        </span>
        {error && (
          <span className="text-[10px] font-mono text-amber-400/80">{error}</span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2 space-y-1.5">
        {loading ? (
          <div className="py-8 text-center text-[11px] font-mono text-zinc-600 animate-pulse">
            fetching…
          </div>
        ) : tasks.length === 0 ? (
          <div className="py-8 text-center text-[11px] font-mono text-zinc-600">
            queue empty
          </div>
        ) : (
          tasks.map((task) => (
            <motion.div
              key={task.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.15 }}
              className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] px-3 py-2.5"
              style={{ background: 'rgba(8,10,18,0.72)' }}
            >
              <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-cyan-400/60 shrink-0 mt-[7px]" aria-hidden />
              <span className="flex-1 min-w-0 text-[11px] text-zinc-200 leading-snug truncate">
                {task.title}
              </span>
              {task.priority && (
                <span
                  className={`shrink-0 text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border ${PRIORITY_COLOUR[task.priority] ?? PRIORITY_COLOUR.normal}`}
                >
                  {task.priority}
                </span>
              )}
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}

function TerminalPanel({ journal }: { journal: string[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [journal]);

  const lines = journal.length
    ? journal
    : ['[swarm] No telemetry yet — engine idle'];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.06] shrink-0">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70 animate-pulse" aria-hidden />
        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
          Journal · last {lines.length} lines
        </span>
      </div>
      <div
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-1 font-mono text-[11px] leading-relaxed"
        role="log"
        aria-live="polite"
        aria-label="Swarm journal"
      >
        {lines.map((line, i) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={`journal-${i}`}
            className="text-zinc-400 break-all"
          >
            <span className="text-zinc-700 select-none mr-2 tabular-nums">
              {String(i + 1).padStart(2, '0')}
            </span>
            {line}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MobileCommandDeckSheet({
  isOpen,
  onClose,
  className = '',
}: MobileCommandDeckSheetProps) {
  const [activeTab, setActiveTab] = useState<Tab>('fleet');
  const [bottomOffset, setBottomOffset] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const firstFocusableRef = useRef<HTMLButtonElement>(null);
  const { journal } = useSwarmTelemetry(10_000);

  // ── Keyboard awareness via visualViewport ──────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const onResize = () => {
      // Inset from bottom = difference between layout and visual viewport bottoms
      const layoutBottom = window.innerHeight;
      const visualBottom = vv.offsetTop + vv.height;
      const inset = Math.max(0, layoutBottom - visualBottom);
      setBottomOffset(inset);
    };

    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    onResize();
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }, [isOpen]);

  // ── Focus management ───────────────────────────────────────────────────────
  useEffect(() => {
    if (isOpen) {
      // Defer to let AnimatePresence mount first
      const t = window.setTimeout(() => firstFocusableRef.current?.focus(), 60);
      return () => window.clearTimeout(t);
    }
  }, [isOpen]);

  // ── Focus trap ────────────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !sheetRef.current) return;
      const focusable = Array.from(
        sheetRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  // ── Drag-to-dismiss ────────────────────────────────────────────────────────
  const handleDragEnd = useCallback(
    (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (info.velocity.y >= 400 || info.offset.y >= 120) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="mcd-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            aria-hidden="true"
            onClick={onClose}
          />

          {/* Sheet */}
          <motion.div
            key="mcd-sheet"
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label="Command Deck"
            data-testid="mobile-command-deck-sheet"
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            className={`fixed bottom-0 left-0 right-0 z-50 flex flex-col rounded-t-2xl overflow-hidden ${className}`}
            style={{
              background: '#050508',
              border: '1px solid rgba(255,255,255,0.06)',
              borderBottom: 'none',
              maxHeight: '85dvh',
              paddingBottom: bottomOffset > 0 ? `${bottomOffset}px` : undefined,
            }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.25 }}
            onDragEnd={handleDragEnd}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 340, damping: 32, mass: 0.9 }}
          >
            {/* Drag handle */}
            <div
              className="flex items-center justify-center pt-3 pb-1 shrink-0 cursor-grab active:cursor-grabbing"
              aria-hidden="true"
            >
              <div className="h-1 w-10 rounded-full bg-white/20" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 shrink-0">
              <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-zinc-500">
                Command Deck
              </span>
              <button
                ref={firstFocusableRef}
                type="button"
                onClick={onClose}
                aria-label="Close Command Deck"
                className="inline-flex items-center justify-center h-7 w-7 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors focus-visible:ring-1 focus-visible:ring-cyan-400 outline-none"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>

            {/* Tab bar */}
            <div
              role="tablist"
              aria-label="Command Deck tabs"
              className="flex items-center gap-0 px-4 pb-0 border-b border-white/[0.06] shrink-0"
            >
              {TABS.map(({ id, label, Icon }) => {
                const active = activeTab === id;
                return (
                  <button
                    key={id}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    aria-controls={`mcd-panel-${id}`}
                    id={`mcd-tab-${id}`}
                    onClick={() => setActiveTab(id)}
                    className={`relative flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 ${
                      active
                        ? 'text-cyan-400'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {label}
                    {active && (
                      <motion.span
                        layoutId="mcd-tab-indicator"
                        className="absolute inset-x-0 bottom-0 h-px bg-cyan-400"
                        transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Panel area */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeTab}
                  role="tabpanel"
                  id={`mcd-panel-${activeTab}`}
                  aria-labelledby={`mcd-tab-${activeTab}`}
                  className="h-full flex flex-col min-h-0"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.18, ease: 'easeInOut' }}
                >
                  {activeTab === 'fleet' && <FleetPanel />}
                  {activeTab === 'queue' && <QueuePanel />}
                  {activeTab === 'terminal' && (
                    <TerminalPanel journal={journal.slice(0, 8)} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
