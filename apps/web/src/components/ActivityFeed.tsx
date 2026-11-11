'use client';

import React, { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, Brain, Code, Eye, Shield, Zap, Terminal, Clock } from 'lucide-react';

// ════════════════════════════════════════════════════════════
//  ActivityFeed — Real-time journal log from substrate
//  Consumed by the Studio sidebar / execution stream
// ════════════════════════════════════════════════════════════

interface ActivityFeedProps {
  journal: string[];
  maxItems?: number;
  className?: string;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  reason: <Brain size={12} className="text-purple-400" />,
  code:   <Code size={12} className="text-cyan-400" />,
  exec:   <Terminal size={12} className="text-green-400" />,
  valid:  <Shield size={12} className="text-emerald-400" />,
  browse: <Eye size={12} className="text-amber-400" />,
  fast:   <Zap size={12} className="text-yellow-400" />,
};

function pickIcon(line: string): React.ReactNode {
  const lower = line.toLowerCase();
  if (lower.includes('reason') || lower.includes('think')) return ICON_MAP.reason;
  if (lower.includes('code') || lower.includes('write') || lower.includes('edit')) return ICON_MAP.code;
  if (lower.includes('exec') || lower.includes('run') || lower.includes('shell')) return ICON_MAP.exec;
  if (lower.includes('valid') || lower.includes('check') || lower.includes('assert')) return ICON_MAP.valid;
  if (lower.includes('browse') || lower.includes('search') || lower.includes('web')) return ICON_MAP.browse;
  if (lower.includes('fast') || lower.includes('token') || lower.includes('speed')) return ICON_MAP.fast;
  return <Activity size={12} className="text-gray-500" />;
}

function parseJournalLine(line: string): { timestamp: string; content: string } {
  // Try to parse "[YYYY-MM-DD HH:MM:SS] content" or just return as-is
  const match = line.match(/^\[?([\d\-T:\s.]+Z?)\]?\s*(.*)$/);
  if (match) {
    return { timestamp: match[1].trim(), content: match[2] };
  }
  return { timestamp: '', content: line };
}

export default function ActivityFeed({ journal, maxItems = 20, className = '' }: ActivityFeedProps) {
  const items = journal.slice(0, maxItems);

  // Seeded mock data synced with active events (Prompt 15)
  const calendarBlocks = useMemo(() => {
    const size = 115; // fits grid container neatly
    return Array.from({ length: size }, (_, i) => {
      const val = Math.abs(Math.sin(i * 1.7)) * 10;
      let count = Math.max(0, Math.floor(val - (i % 9 === 0 ? 4 : 2)));
      if (i === size - 1) count = journal.length; // last interval has current queue
      return {
        id: `block-${i}`,
        count
      };
    });
  }, [journal.length]);

  if (items.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center py-12 text-gray-600 text-xs ${className}`}>
        <Activity size={20} className="mb-2 opacity-40" />
        <span>No activity yet</span>
        <span className="text-[10px] text-gray-700 mt-1">Journal events will appear here</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      {/* SVG Telemetry Calendar Grid Heatmap (Prompt 15) */}
      <div className="mb-3 p-3 bg-black/50 border border-white/[0.04] rounded-xl shadow-inner">
        <div className="text-[8px] font-mono uppercase tracking-[0.2em] text-white/30 mb-2">SYSTEM ACTIVITY DENSITY HEATMAP</div>
        <div className="flex items-center justify-center">
          <svg viewBox="0 0 322 40" className="w-full h-auto">
            {calendarBlocks.map((block, idx) => {
              const x = Math.floor(idx / 5) * 14;
              const y = (idx % 5) * 8;
              
              // Density Opacity rules
              const blockOpacity = block.count === 0 ? 0.05 : block.count > 8 ? 0.8 : block.count > 4 ? 0.55 : 0.3;
              const blockColor = block.count === 0 ? '#ffffff' : block.count > 8 ? '#00BFFF' : block.count > 4 ? '#a855f7' : '#06b6d4';

              return (
                <g key={block.id} className="group/cell">
                  <rect
                    x={x}
                    y={y}
                    width="11"
                    height="6"
                    rx="1.2"
                    fill={blockColor}
                    fillOpacity={blockOpacity}
                    className="transition-all duration-300 hover:fill-cyan-400 hover:fill-opacity-100"
                  />
                  <title>Interval {idx + 1}: {block.count} swarm actions logged</title>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <div className="flex items-center justify-between px-3 py-2 mb-1">
        <span className="text-[11px] uppercase tracking-widest font-semibold text-gray-500">
          Activity Feed
        </span>
        <span className="text-[10px] text-gray-600 flex items-center gap-1">
          <Clock size={10} />
          {items.length} events
        </span>
      </div>
      <AnimatePresence initial={false}>
        {items.map((line, i) => {
          const { timestamp, content } = parseJournalLine(line);
          return (
            <motion.div
              key={`${i}-${line.slice(0, 20)}`}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.2, delay: i * 0.02 }}
              className="flex items-start gap-2 px-3 py-1.5 hover:bg-white/[0.02] rounded-lg transition-colors group"
            >
              <div className="mt-0.5 shrink-0">{pickIcon(content)}</div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-gray-300 truncate leading-relaxed">{content || line}</p>
                {timestamp && (
                  <p className="text-[9px] text-gray-600 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {timestamp}
                  </p>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
