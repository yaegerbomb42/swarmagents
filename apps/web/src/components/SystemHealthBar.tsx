'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Cpu, HardDrive, Wifi, WifiOff, Thermometer, Zap, Clock } from 'lucide-react';

// ════════════════════════════════════════════════════════════
//  SystemHealthBar — Compact engine/infra status strip
//  Shows worker count, throughput, connectivity, phase
// ════════════════════════════════════════════════════════════

interface SystemHealthBarProps {
  engineReachable: boolean;
  workerCount: number;
  aggregateTps: number;
  phase: string;
  lastUpdate: number;
  className?: string;
}

const PHASE_COLORS: Record<string, string> = {
  idle:      'text-gray-400',
  reasoning: 'text-purple-400',
  executing: 'text-cyan-400',
  reviewing: 'text-emerald-400',
  planning:  'text-amber-400',
  sleep:     'text-gray-600',
};

export default function SystemHealthBar({
  engineReachable,
  workerCount,
  aggregateTps,
  phase,
  lastUpdate,
  className = '',
}: SystemHealthBarProps) {
  const ago = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : 0;

  return (
    <div className={`flex items-center gap-4 px-4 py-2 bg-black/30 backdrop-blur-sm border-t border-gray-800/50 text-[11px] ${className}`}>
      {/* Connection */}
      <div className="flex items-center gap-1.5">
        {engineReachable ? (
          <Wifi size={11} className="text-emerald-400" />
        ) : (
          <WifiOff size={11} className="text-red-400" />
        )}
        <span className={engineReachable ? 'text-emerald-400' : 'text-red-400'}>
          {engineReachable ? 'Connected' : 'Offline'}
        </span>
      </div>

      <div className="w-px h-3 bg-gray-700" />

      {/* Workers */}
      <div className="flex items-center gap-1.5 text-gray-400">
        <Cpu size={11} />
        <span>{workerCount} workers</span>
      </div>

      <div className="w-px h-3 bg-gray-700" />

      {/* Throughput */}
      <div className="flex items-center gap-1.5 text-gray-400">
        <Zap size={11} className="text-yellow-500" />
        <span>{aggregateTps > 0 ? `${aggregateTps.toFixed(0)} tok/s` : '—'}</span>
      </div>

      <div className="w-px h-3 bg-gray-700" />

      {/* Phase */}
      <div className="flex items-center gap-1.5">
        <Thermometer size={11} className={PHASE_COLORS[phase] || 'text-gray-500'} />
        <span className={PHASE_COLORS[phase] || 'text-gray-500'}>{phase || 'idle'}</span>
      </div>

      <div className="flex-1" />

      {/* Last polled */}
      {lastUpdate > 0 && (
        <div className="flex items-center gap-1 text-gray-600">
          <Clock size={10} />
          <span>{ago}s ago</span>
        </div>
      )}

      {/* Pulse indicator */}
      <motion.div
        animate={{ opacity: [0.3, 1, 0.3] }}
        transition={{ duration: 2, repeat: Infinity }}
        className={`w-1.5 h-1.5 rounded-full ${engineReachable ? 'bg-emerald-500' : 'bg-red-500'}`}
      />
    </div>
  );
}
