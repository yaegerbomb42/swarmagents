'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import DataStreamTicker from '@/components/ui/DataStreamTicker';

interface StatusChipProps {
  status: 'active' | 'idle' | 'paused' | 'error' | 'booting';
}

const STATUS_STYLES: Record<string, { color: string; border: string; bg: string; label: string }> = {
  active:  { color: '#4ade80', border: 'rgba(74,222,128,0.3)',  bg: 'rgba(74,222,128,0.08)',  label: 'Online' },
  idle:    { color: '#fbbf24', border: 'rgba(251,191,36,0.3)',  bg: 'rgba(251,191,36,0.08)',  label: 'Standby' },
  paused:  { color: '#60a5fa', border: 'rgba(96,165,250,0.3)',  bg: 'rgba(96,165,250,0.08)',  label: 'Paused' },
  error:   { color: '#f87171', border: 'rgba(248,113,113,0.3)', bg: 'rgba(248,113,113,0.08)', label: 'Offline' },
  booting: { color: '#a78bfa', border: 'rgba(167,139,250,0.3)', bg: 'rgba(167,139,250,0.08)', label: 'Starting' },
};

function StatusChip({ status }: StatusChipProps) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.idle;
  return (
    <div
      className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold tracking-wider uppercase"
      style={{ color: s.color, borderColor: s.border, backgroundColor: s.bg, border: `1px solid ${s.border}` }}
    >
      <motion.div
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: s.color }}
        animate={{ opacity: status === 'active' ? [0.5, 1, 0.5] : 1 }}
        transition={{ duration: 1.5, repeat: Infinity }}
      />
      {s.label}
    </div>
  );
}

interface SystemStatusBarProps {
  status?: 'active' | 'idle' | 'paused' | 'error' | 'booting';
  tasksPerMin?: number;
  tokensUsed?: number;
  costUsd?: number;
  agentCount?: number;
  className?: string;
}

export default function SystemStatusBar({
  status = 'active',
  tasksPerMin = 0,
  tokensUsed = 0,
  costUsd = 0,
  agentCount = 0,
  className = '',
}: SystemStatusBarProps) {
  const [clock, setClock] = useState('');

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(
        now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className={`flex flex-col gap-0 ${className}`}
      style={{
        background: 'rgba(10,13,20,0.95)',
        backdropFilter: 'blur(12px)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <DataStreamTicker speed="fast" />
      <div className="flex items-center gap-3 px-4 py-1.5 text-[11px] hyper-header-shimmer">
      <StatusChip status={status} />

      <div className="w-px h-3" style={{ background: 'rgba(255,255,255,0.08)' }} />

      <div className="flex items-center gap-1 text-gray-500">
        <span className="text-gray-400 font-medium">{agentCount}</span>
        <span>agents</span>
      </div>

      <div className="w-px h-3" style={{ background: 'rgba(255,255,255,0.08)' }} />

      <div className="flex items-center gap-1 text-gray-500">
        <span className="text-green-400 font-medium">{tasksPerMin.toFixed(1)}</span>
        <span>tasks/min</span>
      </div>

      <div className="w-px h-3" style={{ background: 'rgba(255,255,255,0.08)' }} />

      <div className="flex items-center gap-1 text-gray-500">
        <span className="text-blue-400 font-medium">{(tokensUsed / 1000).toFixed(0)}k</span>
        <span>tokens</span>
      </div>

      <div className="w-px h-3" style={{ background: 'rgba(255,255,255,0.08)' }} />

      <div className="flex items-center gap-1 text-gray-500">
        <span className="text-amber-400 font-medium">${costUsd.toFixed(2)}</span>
        <span>cost</span>
      </div>

      <div className="flex-1" />

      <span className="text-gray-600 font-mono tabular-nums">{clock}</span>
      </div>
    </div>
  );
}

export { StatusChip };
