'use client';

import type { ReactNode } from 'react';

export type OrbitalGaugeProps = {
  children: ReactNode;
  size?: number;
  className?: string;
  'aria-label'?: string;
};

export default function OrbitalGauge({
  children,
  size = 64,
  className = '',
  'aria-label': ariaLabel,
}: OrbitalGaugeProps) {
  return (
    <div
      className={`hyper-orbital-gauge ${className}`}
      style={{ width: size, height: size }}
      aria-label={ariaLabel}
      data-testid="orbital-gauge"
    >
      <div className="hyper-orbital-gauge__ring" aria-hidden />
      <div
        className="hyper-orbital-gauge__ring hyper-orbital-gauge__ring--reverse"
        aria-hidden
      />
      <div className="relative z-[1] flex items-center justify-center w-full h-full">
        {children}
      </div>
    </div>
  );
}
