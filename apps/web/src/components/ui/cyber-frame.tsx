'use client';

import type { ReactNode } from 'react';

export interface CyberFrameProps {
  children: ReactNode;
  className?: string;
  variant?: 'cyan' | 'purple' | 'magenta';
  scanline?: boolean;
  brackets?: boolean;
  hologram?: boolean;
}

const ACCENT: Record<string, string> = {
  cyan: 'rgba(6, 182, 212, 0.6)',
  purple: 'rgba(168, 85, 247, 0.6)',
  magenta: 'rgba(236, 72, 153, 0.6)',
};

export default function CyberFrame({
  children,
  className = '',
  variant = 'cyan',
  scanline = true,
  brackets = true,
  hologram = false,
}: CyberFrameProps) {
  const accent = ACCENT[variant] ?? ACCENT.cyan;

  const inner = (
    <div
      className={`relative overflow-hidden rounded-xl border border-white/10 bg-[#06061a]/90 ${className}`}
    >
      {brackets ? (
        <>
          <span className="cyber-bracket cyber-bracket-tl" style={{ borderColor: accent }} />
          <span className="cyber-bracket cyber-bracket-tr" style={{ borderColor: accent }} />
          <span className="cyber-bracket cyber-bracket-bl" style={{ borderColor: accent }} />
          <span className="cyber-bracket cyber-bracket-br" style={{ borderColor: accent }} />
        </>
      ) : null}
      {scanline ? <div className="laser-scan-line" aria-hidden /> : null}
      {children}
    </div>
  );

  if (hologram) {
    return (
      <div className="hologram-border-wrap rounded-xl">
        <div className="hologram-border-inner rounded-[10px]">{inner}</div>
      </div>
    );
  }

  return inner;
}
