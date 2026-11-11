'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Keyboard, Command, ArrowRight, CornerDownLeft } from 'lucide-react';

export type ShortcutGroup = {
  category: string;
  items: Array<{
    keys: string[];
    description: string;
    context?: string;
  }>;
};

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    category: 'Global Navigation',
    items: [
      { keys: ['⌘', 'K'], description: 'Open omnibar command palette' },
      { keys: ['?'], description: 'Toggle this keyboard shortcuts HUD' },
      { keys: ['Esc'], description: 'Close modals, drawers, or active selections' },
      { keys: ['/'], description: 'Quick search / focus input' },
    ],
  },
  {
    category: 'DAG & Console',
    items: [
      { keys: ['J', 'or', '↓'], description: 'Traverse to next DAG node' },
      { keys: ['K', 'or', '↑'], description: 'Traverse to previous DAG node' },
      { keys: ['Enter'], description: 'Inspect selected node in detail panel' },
      { keys: ['M'], description: 'Toggle full-width DAG canvas expansion' },
      { keys: ['S'], description: 'Toggle right steering & context chat drawer' },
    ],
  },
  {
    category: 'Execution & Mission Controls',
    items: [
      { keys: ['⌘', 'Enter'], description: 'Execute / launch current mission' },
      { keys: ['Space'], description: 'Pause / resume active swarm execution' },
      { keys: ['R'], description: 'Refresh telemetry & sandbox viewports' },
    ],
  },
];

interface KeyboardShortcutsModalProps {
  open?: boolean;
  onClose?: () => void;
}

export default function KeyboardShortcutsModal({
  open: controlledOpen,
  onClose,
}: KeyboardShortcutsModalProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;

  const close = useCallback(() => {
    if (onClose) onClose();
    else setInternalOpen(false);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setInternalOpen((prev) => !prev);
      }
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        close();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, close]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
            className="fixed inset-0 z-[9990] bg-black/70 backdrop-blur-xs"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -12 }}
            transition={{ type: 'spring', stiffness: 450, damping: 32 }}
            className="fixed left-1/2 top-[18%] -translate-x-1/2 z-[9995] w-[92vw] max-w-[620px] rounded-2xl border border-white/10 bg-[#0c0d12]/95 backdrop-blur-xl shadow-2xl p-5 text-zinc-100 font-mono"
          >
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-white/10">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
                  <Keyboard size={16} />
                </div>
                <div>
                  <h2 className="text-sm font-semibold tracking-tight text-white flex items-center gap-2">
                    Keyboard Navigation HUD
                  </h2>
                  <p className="text-[10px] text-zinc-500">
                    Linear &amp; Vim-inspired keyboard-first fleet orchestration
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={close}
                className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
                title="Close (Esc)"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
              {SHORTCUT_GROUPS.map((group) => (
                <div key={group.category} className="space-y-2">
                  <h3 className="text-[10px] uppercase tracking-widest text-cyan-400/80 font-bold">
                    {group.category}
                  </h3>
                  <div className="grid grid-cols-1 gap-1.5">
                    {group.items.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/5 hover:border-white/10 transition-colors"
                      >
                        <span className="text-[11px] text-zinc-300">{item.description}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          {item.keys.map((k, kIdx) => (
                            <kbd
                              key={kIdx}
                              className={`px-1.5 py-0.5 text-[10px] rounded border ${
                                k === 'or'
                                  ? 'border-transparent text-zinc-600 font-sans'
                                  : 'border-white/15 bg-white/5 text-zinc-200 shadow-xs'
                              }`}
                            >
                              {k}
                            </kbd>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between text-[10px] text-zinc-500">
              <span className="flex items-center gap-1">
                Press <kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/10 text-zinc-300">?</kbd> anytime to toggle
              </span>
              <button
                type="button"
                onClick={close}
                className="px-2.5 py-1 rounded bg-white/5 border border-white/10 text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
              >
                Dismiss
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
