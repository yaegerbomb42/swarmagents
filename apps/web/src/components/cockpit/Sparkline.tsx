'use client';

import React from 'react';
import { V } from './theme';

/** 1-px polyline sparkline. Renders "—" when there's nothing to draw. */
export default function Sparkline({
  values, width = 120, height = 18, color = V.fg2, min, max, label,
}: { values: number[]; width?: number; height?: number; color?: string; min?: number; max?: number; label: string }) {
  if (values.length < 2 || values.every((v) => v === 0)) {
    return <span className="font-mono text-[11px]" style={{ color: V.fg4 }} aria-label={`${label}: no data`}>—</span>;
  }
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 1) + 0.5;
    const y = height - 1 - ((v - lo) / span) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="block">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
