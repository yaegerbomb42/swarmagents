'use client';

import React from 'react';

type HudCornersProps = {
  className?: string;
  children: React.ReactNode;
};

export default function HudCorners({ className = '', children }: HudCornersProps) {
  return (
    <div className={`hyper-hud ${className}`} data-testid="hud-corners">
      <span className="hyper-hud__corner hyper-hud__corner--tl" aria-hidden />
      <span className="hyper-hud__corner hyper-hud__corner--tr" aria-hidden />
      <span className="hyper-hud__corner hyper-hud__corner--bl" aria-hidden />
      <span className="hyper-hud__corner hyper-hud__corner--br" aria-hidden />
      {children}
    </div>
  );
}
