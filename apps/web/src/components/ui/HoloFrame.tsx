'use client';

import React from 'react';

type HoloFrameProps = {
  children: React.ReactNode;
  className?: string;
  brackets?: boolean;
  scan?: boolean;
};

/** Holographic conic border + optional corner brackets + laser scan */
export default function HoloFrame({
  children,
  className = '',
  brackets = true,
  scan = false,
}: HoloFrameProps) {
  return (
    <div className={`hologram-border-wrap rounded-2xl ${className}`}>
      <div className="hologram-border-inner rounded-[calc(1rem-1.5px)] relative overflow-hidden">
        {brackets ? (
          <>
            <span className="cyber-bracket cyber-bracket-tl border-solid" />
            <span className="cyber-bracket cyber-bracket-tr border-solid" />
            <span className="cyber-bracket cyber-bracket-bl border-solid" />
            <span className="cyber-bracket cyber-bracket-br border-solid" />
          </>
        ) : null}
        {scan ? <div className="laser-scan-line" aria-hidden /> : null}
        {children}
      </div>
    </div>
  );
}
