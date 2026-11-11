'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain, Code, Wrench, Search, CheckCircle2, AlertTriangle,
  Terminal, FileEdit, Network, Sparkles, Zap, Eye, ChevronDown,
} from 'lucide-react';

// ════════════════════════════════════════════════════════════
//  ThoughtStream — Insanely polished bento-grid agent feed
// ════════════════════════════════════════════════════════════

export type ThoughtType =
  | 'thought'
  | 'action'
  | 'edit'
  | 'command'
  | 'observe'
  | 'validate'
  | 'success'
  | 'warning';

export interface ThoughtEntry {
  id: string;
  type: ThoughtType;
  agent: string;          // e.g. "Coder", "Reasoner"
  role?: string;          // e.g. "executor"
  title: string;
  detail?: string;        // longer body
  code?: string;          // diff or code preview
  meta?: string;          // tiny pill (e.g. file path, tps)
  ts?: number;            // unix ms
  size?: 'sm' | 'md' | 'lg';
}

const TYPE_ICON: Record<ThoughtType, React.ReactNode> = {
  thought:  <Brain size={14} />,
  action:   <Wrench size={14} />,
  edit:     <FileEdit size={14} />,
  command:  <Terminal size={14} />,
  observe:  <Eye size={14} />,
  validate: <CheckCircle2 size={14} />,
  success:  <Sparkles size={14} />,
  warning:  <AlertTriangle size={14} />,
};

const TYPE_STYLE: Record<ThoughtType, { bg: string; border: string; text: string; glow: string }> = {
  thought:  { bg: 'bg-[#120a21]/50',  border: 'border-purple-500/30',  text: 'text-purple-300',  glow: 'shadow-[0_0_15px_rgba(168,85,247,0.08)]' },
  action:   { bg: 'bg-[#06121f]/50',  border: 'border-cyan-500/35',    text: 'text-cyan-300',    glow: 'shadow-[0_0_20px_rgba(6,182,212,0.12)]'   },
  edit:     { bg: 'bg-[#061515]/50',  border: 'border-teal-500/35',    text: 'text-teal-300',    glow: 'shadow-[0_0_15px_rgba(20,184,166,0.1)]'   },
  command:  { bg: 'bg-[#08121f]/50',  border: 'border-sky-500/35',     text: 'text-sky-300',     glow: 'shadow-[0_0_15px_rgba(14,165,233,0.1)]'    },
  observe:  { bg: 'bg-[#0d0d12]/50',  border: 'border-slate-500/20',   text: 'text-slate-300',   glow: 'shadow-[0_0_10px_rgba(100,116,139,0.05)]'  },
  validate: { bg: 'bg-[#071712]/50',  border: 'border-emerald-500/35', text: 'text-emerald-300', glow: 'shadow-[0_0_15px_rgba(16,185,129,0.1)]'},
  success:  { bg: 'bg-[#0b2416]/50',  border: 'border-emerald-400/40', text: 'text-emerald-200', glow: 'shadow-[0_0_25px_rgba(16,185,129,0.18)]'},
  // Neon Border Jitter Warnings styling (Prompt 13)
  warning:  { 
    bg: 'bg-red-950/20 animate-neon-jitter',  
    border: 'border-red-500/50',   
    text: 'text-red-400',   
    glow: 'shadow-[0_0_20px_rgba(239,68,68,0.25)]'  
  },
};

const SIZE_SPAN: Record<NonNullable<ThoughtEntry['size']>, string> = {
  sm: 'col-span-1 row-span-1',
  md: 'col-span-2 row-span-1',
  lg: 'col-span-2 row-span-2',
};

function relTime(ms?: number): string {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// Micro Code Syntax Highlighter (Prompt 11)
function renderSyntaxColoredCode(code: string) {
  let html = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const keywords = /\b(const|let|var|function|return|import|export|from|class|extends|new|if|else|for|while|async|await|try|catch)\b/g;
  html = html.replace(keywords, '<span class="text-pink-400 font-semibold">$1</span>');

  const strings = /(["'`])(.*?)\1/g;
  html = html.replace(strings, '<span class="text-emerald-400">$1$2$1</span>');

  const comments = /(\/\/.*)/g;
  html = html.replace(comments, '<span class="text-gray-500">$1</span>');

  return <code className="block font-mono text-[10px]" dangerouslySetInnerHTML={{ __html: html }} />;
}

// Matrix rain backdrop overlay (Prompt 12)
function MatrixRainBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = (canvas.width = canvas.offsetWidth || 120);
    let height = (canvas.height = canvas.offsetHeight || 80);

    const columns = Math.floor(width / 8) + 1;
    const ypos = Array(columns).fill(0).map(() => Math.random() * -100);

    const draw = () => {
      ctx.fillStyle = 'rgba(6, 6, 26, 0.16)';
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = '#06b6d4'; // cyan rain drops
      ctx.font = '8px monospace';
      ctx.globalAlpha = 0.038; // extremely low contrast for foreground legibility (Prompt 12)

      for (let i = 0; i < columns; i++) {
        const char = Math.random() > 0.5 ? '1' : '0';
        const x = i * 8;
        const y = ypos[i];
        ctx.fillText(char, x, y);

        if (y > height + Math.random() * 200) {
          ypos[i] = 0;
        } else {
          ypos[i] += 8;
        }
      }
    };

    const interval = setInterval(draw, 33);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.offsetWidth || 120;
      height = canvas.height = canvas.offsetHeight || 80;
    };
    window.addEventListener('resize', handleResize);

    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-0" />;
}

export interface ThoughtStreamProps {
  entries: ThoughtEntry[];
  className?: string;
  emptyText?: string;
}

export function ThoughtStream({
  entries,
  className = '',
  emptyText = 'No agent activity yet. Launch a mission to see the swarm think.',
}: ThoughtStreamProps) {
  const sized = useMemo(() => {
    return entries.map((e, i): ThoughtEntry => {
      if (e.size) return e;
      if (i === 0) return { ...e, size: 'lg' };
      if (e.code || (e.detail && e.detail.length > 80)) return { ...e, size: 'md' };
      return { ...e, size: 'sm' };
    });
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center min-h-[200px] text-center px-8 ${className}`}>
        <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-400/20 flex items-center justify-center text-cyan-300 mb-3">
          <Brain size={20} />
        </div>
        <p className="text-sm text-gray-500 max-w-xs">{emptyText}</p>
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-2 lg:grid-cols-4 gap-3 auto-rows-[100px] ${className}`}>
      <AnimatePresence initial={false}>
        {sized.map((e) => (
          <ThoughtCard key={e.id} entry={e} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ThoughtCard({ entry }: { entry: ThoughtEntry }) {
  const style = TYPE_STYLE[entry.type];
  const span = SIZE_SPAN[entry.size || 'sm'];
  const [expanded, setExpanded] = useState(false);

  return (
    <motion.div
      layoutId={entry.id}
      layout
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.15 } }}
      transition={{ type: 'spring', stiffness: 350, damping: 28 }}
      className={`group relative overflow-hidden rounded-2xl border backdrop-blur-sm ${style.bg} ${style.border} ${style.glow} shadow-lg ${span} hover:border-opacity-60 transition-all duration-300`}
    >
      {/* Matrix Rain backdrop overlay (Prompt 12) */}
      {(entry.size === 'lg' || entry.type === 'thought') && <MatrixRainBackdrop />}

      {/* Subtle moving glow */}
      <div className={`absolute -inset-1 rounded-2xl ${style.bg} blur-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-0`} />

      <div className="relative p-3 h-full flex flex-col z-10">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`w-5 h-5 rounded-md flex items-center justify-center ${style.text} flex-shrink-0`}>
              {TYPE_ICON[entry.type]}
            </span>
            <span className={`text-[10px] uppercase tracking-widest font-mono ${style.text} truncate`}>
              {entry.type}
            </span>
          </div>
          <span className="text-[9px] text-gray-500 font-mono whitespace-nowrap">{relTime(entry.ts)}</span>
        </div>

        {/* Body */}
        <div className="mt-1.5 flex-1 min-h-0">
          <div className="text-xs text-white font-medium leading-snug">
            {entry.title}
          </div>
          {entry.detail && (
            <div className={`mt-1 text-[11px] text-gray-400 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
              {entry.detail}
            </div>
          )}
          {entry.code && (entry.size === 'lg' || expanded) && (
            <pre className="mt-2 p-2 rounded-lg bg-black/60 text-[10px] text-cyan-300 font-mono overflow-x-auto max-h-24 leading-tight border border-cyan-500/15">
              {renderSyntaxColoredCode(entry.code)}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="mt-auto pt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[10px] text-gray-500 truncate">
            <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
            <span className="truncate">{entry.agent}</span>
            {entry.meta && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded bg-white/5 text-[9px] font-mono text-gray-400 truncate">
                {entry.meta}
              </span>
            )}
          </div>
          {(entry.detail && entry.detail.length > 80) || entry.code ? (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[10px] text-gray-500 hover:text-cyan-200 transition-colors flex items-center gap-0.5 flex-shrink-0"
            >
              {expanded ? 'less' : 'more'}
              <ChevronDown size={10} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}

export function journalToThoughts(journal: string[], baseAgent = 'Swarm'): ThoughtEntry[] {
  return journal.map((line, i) => {
    const lower = line.toLowerCase();
    let type: ThoughtType = 'observe';
    if (lower.includes('error') || lower.includes('fail')) type = 'warning';
    else if (lower.includes('valid') || lower.includes('check')) type = 'validate';
    else if (lower.includes('edit') || lower.includes('write') || lower.includes('diff')) type = 'edit';
    else if (lower.includes('exec') || lower.includes('run') || lower.includes('cmd') || lower.includes('$')) type = 'command';
    else if (lower.includes('reason') || lower.includes('think') || lower.includes('plan')) type = 'thought';
    else if (lower.includes('success') || lower.includes('done') || lower.includes('complete')) type = 'success';
    else if (lower.includes('action') || lower.includes('tool')) type = 'action';

    return {
      id: `j-${i}-${line.slice(0, 10)}`,
      type,
      agent: baseAgent,
      title: line.length > 80 ? line.slice(0, 80) + '\u2026' : line,
      detail: line.length > 80 ? line : undefined,
      ts: Date.now() - i * 1000,
    };
  });
}

export default ThoughtStream;

export interface ArenaThoughtLog {
  id: string;
  agentId: string;
  agentLabel: string;
  perception: { S_t: { mood: string; location_label: string }; S_g: { objective: string } };
  action: { type: string; target_id?: string; rationale?: string };
  ts: number;
}

export function arenaThoughtsToEntries(arena: ArenaThoughtLog[]): ThoughtEntry[] {
  const TYPE_MAP: Record<string, ThoughtType> = {
    walk_to:        'action',
    pickup:         'action',
    drop:           'action',
    throw:          'warning',
    change_channel: 'command',
    sit_on:         'observe',
    stand_up:       'action',
    observe:        'observe',
    idle:           'observe',
    speak:          'thought',
    try_escape:     'warning',
    punch_glass:    'warning',
  };
  return arena.map(a => ({
    id: a.id,
    type: TYPE_MAP[a.action.type] ?? 'thought',
    agent: a.agentLabel,
    role: a.perception.S_g.objective,
    title: a.action.target_id ? `${a.action.type} → ${a.action.target_id}` : a.action.type,
    detail: a.action.rationale ?? `${a.perception.S_t.mood} · ${a.perception.S_t.location_label}`,
    ts: a.ts,
    size: a.action.type === 'try_escape' || a.action.type === 'punch_glass' ? 'lg' : 'sm',
  }));
}
