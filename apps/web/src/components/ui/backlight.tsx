'use client';

import React from 'react';

// ════════════════════════════════════════════════════════════
//  Backlight — wraps content w/ animated glow behind it
//  Inspired by MagicUI <Backlight>
// ════════════════════════════════════════════════════════════

export interface BacklightProps {
  children: React.ReactNode;
  blur?: number;
  className?: string;
  intensity?: number; // 0..1
  colors?: string[]; // e.g. ['#6366f1', '#ec4899', '#06b6d4']
}

export function Backlight({
  children,
  blur = 40,
  className = '',
  intensity = 1,
  colors = ['#6366f1', '#ec4899', '#a78bfa', '#06b6d4', '#22d3ee'],
}: BacklightProps) {
  const gradient = `conic-gradient(from 0deg, ${colors.join(', ')}, ${colors[0]})`;

  return (
    <div className={`relative ${className}`}>
      {/* Glow layer */}
      <div
        className="absolute -inset-2 rounded-3xl animate-[backlight-spin_8s_linear_infinite]"
        style={{
          background: gradient,
          filter: `blur(${blur}px)`,
          opacity: intensity * 0.55,
          zIndex: 0,
        }}
      />
      {/* Subtle inner glow */}
      <div
        className="absolute -inset-0.5 rounded-2xl"
        style={{
          background: gradient,
          filter: `blur(${Math.max(8, blur / 4)}px)`,
          opacity: intensity * 0.35,
          zIndex: 0,
        }}
      />
      {/* Content */}
      <div className="relative z-10">{children}</div>
      <style jsx>{`
        @keyframes backlight-spin {
          0%   { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export default Backlight;
