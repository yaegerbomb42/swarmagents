'use client';

import React from 'react';

export type HolographicBadgeVariant = 'live' | 'cyan' | 'purple';

type HolographicBadgeProps = {
  label: string;
  variant?: HolographicBadgeVariant;
  pulse?: boolean;
  className?: string;
};

export default function HolographicBadge({
  label,
  variant = 'live',
  pulse = true,
  className = '',
}: HolographicBadgeProps) {
  return (
    <span
      className={`hyper-holo-badge hyper-holo-badge--${variant} ${className}`}
      data-testid="holographic-badge"
    >
      {pulse ? <span className="hyper-holo-badge__dot" aria-hidden /> : null}
      <span className="hyper-holo-badge__label">{label}</span>
    </span>
  );
}
