'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { openOmnibar, useOverlayRequests } from '@/lib/omnibar';
import { Command } from 'cmdk';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Network,
  Boxes,
  Database,
  FlaskConical,
  Search,
  Settings,
  CreditCard,
  MessageSquare,
  Plus,
  Rocket,
  Command as CommandIcon,
  Sparkles,
  ArrowRight,
  Terminal,
} from 'lucide-react';

// ════════════════════════════════════════════════════════════
//  CommandPalette — Unified Global Input & Omnibar (Linear-grade)
//  Acts as single universal entry point for navigation, quick prompt execution,
//  agent spawning, and system commands.
// ════════════════════════════════════════════════════════════

export type OmnibarAction = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ReactNode;
  keywords?: string;
  href?: string;
  shortcut?: string;
  run?: () => void;
};

const ROUTES: Array<{ href: string; label: string; hint: string; icon: React.ReactNode; keywords: string }> = [
  { href: '/decomp', label: 'Go to Console', hint: 'Plan DAG, steer, execute', icon: <Network size={15} />, keywords: 'console decomp dag plan tree tasks studio' },
  { href: '/command', label: 'Go to Command Center', hint: 'Fleet overview + mission launcher', icon: <Rocket size={15} />, keywords: 'command launch mission hud dashboard home overview' },
  { href: '/live', label: 'Go to Sandboxes', hint: 'Live agent sandboxes', icon: <Boxes size={15} />, keywords: 'live sandbox workers fleet' },
  { href: '/memory', label: 'Go to Memory', hint: 'Semantic recall + knowledge', icon: <Database size={15} />, keywords: 'memory recall knowledge' },
  { href: '/lab', label: 'Go to Lab', hint: 'Benchmarks, playground, roles', icon: <FlaskConical size={15} />, keywords: 'lab benchmark playground roles' },
  { href: '/chat', label: 'Go to Chat', hint: 'Talk to the swarm', icon: <MessageSquare size={15} />, keywords: 'chat talk message' },
  { href: '/billing', label: 'Go to Billing', hint: 'Credits, checkout, usage', icon: <CreditCard size={15} />, keywords: 'billing credits pricing usage' },
  { href: '/settings', label: 'Go to Settings', hint: 'Engine, models, providers', icon: <Settings size={15} />, keywords: 'settings config engine models' },
  { href: '/decomp?preset=tool_qa', label: 'New mission: 10m web QA', hint: 'Preset into Console', icon: <Plus size={15} />, keywords: 'new mission preset qa quickstart' },
];

export function useOmnibarOpen() {
  const [open, setOpen] = useState(false);
  useOverlayRequests('omnibar', setOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setOpen(false);
      } else if (e.key === '/' && !mod && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        const ae = document.activeElement;
        if (!(ae instanceof HTMLInputElement) && !(ae instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          setOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [open, setOpen] as const;
}

interface CommandPaletteProps {
  onNavigate?: (path: string) => void;
  onSpawnAgent?: (role: string) => void;
  onRunTask?: (task: string) => void;
  controlledOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export default function CommandPalette({ onNavigate, onSpawnAgent, onRunTask, controlledOpen, onOpenChange }: CommandPaletteProps) {
  let router: ReturnType<typeof useRouter> | null = null;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    router = useRouter();
  } catch {
    router = null;
  }
  const [internalOpen, setInternalOpen] = useOmnibarOpen();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [searchVal, setSearchVal] = useState('');

  const go = useCallback((href: string) => {
    setOpen(false);
    if (onNavigate) { onNavigate(href); return; }
    if (router?.push) {
      router.push(href);
    } else if (typeof window !== 'undefined') {
      window.location.href = href;
    }
  }, [onNavigate, router, setOpen]);

  const handleLaunchPrompt = useCallback((prompt: string) => {
    setOpen(false);
    if (onRunTask) {
      onRunTask(prompt);
    } else {
      go(`/command?prompt=${encodeURIComponent(prompt)}`);
    }
  }, [go, onRunTask, setOpen]);

  const actions: OmnibarAction[] = useMemo(() => ([
    ...ROUTES.map((r, i) => ({
      id: `go-${i}`, label: r.label, hint: r.hint, group: i < 8 ? 'Navigate' : 'Quick start',
      icon: r.icon, keywords: r.keywords, href: r.href,
    } as OmnibarAction)),
    { id: 'act-new-mission', label: 'New mission…', hint: 'Open Console', group: 'Actions', icon: <Plus size={15} />, keywords: 'new create mission', run: () => { onRunTask?.('new'); go('/decomp'); } },
    { id: 'act-chat', label: 'Open Chat', hint: 'Talk to the swarm', group: 'Actions', icon: <MessageSquare size={15} />, keywords: 'chat talk', run: () => go('/chat') },
    ...(onSpawnAgent ? ([
      { id: 'spawn-reasoner', label: 'Spawn reasoner agent', hint: 'Analytical chain-of-thought', group: 'Spawn agent', icon: <CommandIcon size={15} />, keywords: 'spawn reasoner', run: () => onSpawnAgent('reasoner') },
      { id: 'spawn-executor', label: 'Spawn executor agent', hint: 'Code generation + execution', group: 'Spawn agent', icon: <CommandIcon size={15} />, keywords: 'spawn executor', run: () => onSpawnAgent('executor') },
    ] as OmnibarAction[]) : []),
  ]), [go, onRunTask, onSpawnAgent]);

  const groups = useMemo(() => [...new Set(actions.map((a) => a.group))], [actions]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999]"
            onClick={() => setOpen(false)}
          />

          {/* Palette */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="fixed top-[14%] left-1/2 -translate-x-1/2 w-[min(38rem,calc(100vw-2rem))] z-[10000]"
            role="dialog" aria-modal="true" aria-label="Command palette"
          >
            <Command
              className="bg-bg-2 backdrop-blur-xl border border-line-2 rounded-r-lg shadow-e2 overflow-hidden text-zinc-100"
              loop label="Global command palette"
            >
              <div className="flex items-center border-b border-white/10 px-3.5">
                <Search size={15} className="text-cyan-400 mr-2.5 shrink-0" />
                <Command.Input
                  autoFocus
                  value={searchVal}
                  onValueChange={setSearchVal}
                  placeholder="Type a mission prompt, search pages, or run action… (⌘K)"
                  className="w-full bg-transparent text-sm py-3.5 outline-none placeholder:text-zinc-600 font-sans"
                />
                <kbd className="ml-2 text-micro font-mono text-fg-3 bg-white/[0.04] px-1.5 py-0.5 rounded-xs border border-line-2 shrink-0">
                  ESC
                </kbd>
              </div>

              {/* Quick Launch Custom Prompt Action if user types something custom */}
              {searchVal.trim().length > 2 && (
                <div className="p-2 border-b border-white/[0.06] bg-cyan-500/[0.03]">
                  <button
                    type="button"
                    onClick={() => handleLaunchPrompt(searchVal.trim())}
                    className="w-full flex items-center justify-between p-2 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-200 text-xs transition-colors"
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Sparkles size={13} className="text-cyan-400 shrink-0" />
                      <span className="truncate">
                        Launch mission: <strong className="text-cyan-100">&quot;{searchVal}&quot;</strong>
                      </span>
                    </span>
                    <span className="flex items-center gap-1 text-meta font-mono text-accent shrink-0 ml-2">
                      <span>↵ Execute</span>
                    </span>
                  </button>
                </div>
              )}

              <Command.List className="max-h-[340px] overflow-y-auto p-1.5">
                <Command.Empty className="py-8 text-center text-xs text-zinc-500">
                  No direct commands found. Press Enter to launch as a new swarm mission.
                </Command.Empty>
                {groups.map((group) => (
                  <Command.Group key={group} heading={group} className="[&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-fg-3 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:font-mono">
                    {actions.filter((a) => a.group === group).map((a) => (
                        <Command.Item
                          key={a.id}
                          value={`${a.label} ${a.hint ?? ''} ${a.keywords ?? ''}`}
                          onSelect={() => { if (a.run) a.run(); else if (a.href) go(a.href); }}
                          className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer text-zinc-300 data-[selected=true]:bg-white/[0.07] data-[selected=true]:text-zinc-50 transition-colors"
                        >
                          <span className="text-zinc-500 shrink-0">{a.icon}</span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-body font-medium truncate">{a.label}</span>
                            {a.hint ? <span className="block text-meta text-fg-3 truncate">{a.hint}</span> : null}
                          </span>
                          {a.shortcut ? (
                            <kbd className="text-micro font-mono text-fg-3 bg-white/[0.04] px-1.5 py-0.5 rounded border border-white/10 shrink-0">{a.shortcut}</kbd>
                          ) : null}
                        </Command.Item>
                      ))}
                  </Command.Group>
                ))}
              </Command.List>
              <div className="border-t border-white/10 px-3.5 py-2 flex items-center justify-between text-micro font-mono text-fg-3">
                <span>↑↓ navigate · ⏎ select · esc close · / to open</span>
                <span className="text-accent">⌘K</span>
              </div>
            </Command>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// Global mount: Cmd+K / `/` anywhere, Escape to dismiss. Zero deps on page code.
export function GlobalOmnibar() {
  return <CommandPalette />;
}

// Quick Universal Launcher Pill for top navigation or bottom execution dock
export function UniversalLauncherPill({ className = '' }: { className?: string }) {
  const triggerOmnibar = () => openOmnibar();

  return (
    <button
      type="button"
      onClick={triggerOmnibar}
      aria-label="Universal Command Launcher"
      className={`flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] hover:border-cyan-500/30 text-zinc-400 hover:text-zinc-200 transition-all text-xs font-mono group ${className}`}
    >
      <Search size={12} className="text-zinc-500 group-hover:text-cyan-400 transition-colors" />
      <span className="text-meta text-fg-2 group-hover:text-fg-1">Search or command…</span>
      <kbd className="text-micro px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/10 text-zinc-500">
        ⌘K
      </kbd>
    </button>
  );
}
