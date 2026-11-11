'use client';

import { statusMeta, type CanonicalStatus } from '@/lib/status';

export interface StatusDotProps {
  /** Canonical or raw status (raw is mapped through `toCanonical`). */
  status: CanonicalStatus | string | null | undefined;
  size?: number;
  /** Set false to force a static dot (e.g. beyond the visible halo cap). */
  animate?: boolean;
  className?: string;
  title?: string;
}

/**
 * Canonical status indicator. Only running/thinking/planning animate, and
 * all motion is gated behind `motion-safe:` so prefers-reduced-motion is honored.
 */
export default function StatusDot({ status, size = 8, animate = true, className = '', title }: StatusDotProps) {
  const meta = statusMeta(status);
  const color = meta.colorVar;
  const px = `${size}px`;
  const base = 'relative inline-flex shrink-0 items-center justify-center rounded-full';
  const label = title ?? meta.label;
  const anim = animate ? meta.animate : 'none';

  const common = { role: 'img' as const, 'aria-label': label, title: label };

  switch (meta.glyph) {
    case 'ring':
    case 'ring-strike':
      return (
        <span {...common} className={`${base} ${className}`} style={{ width: px, height: px, border: `1.5px solid ${color}` }}>
          {meta.glyph === 'ring-strike' && (
            <span className="absolute h-[1.5px] w-[140%] rotate-45" style={{ background: color }} />
          )}
        </span>
      );
    case 'arc':
      return (
        <span
          {...common}
          className={`${base} ${anim === 'spin' ? 'motion-safe:animate-spin' : ''} ${className}`}
          style={{
            width: px,
            height: px,
            border: `1.5px solid color-mix(in srgb, ${color} 35%, transparent)`,
            borderTopColor: color,
            animationDuration: '1.2s',
          }}
        />
      );
    case 'bars':
      return (
        <span {...common} className={`${base} gap-[1.5px] ${className}`} style={{ width: px, height: px }}>
          <span className="h-full w-[2px] rounded-sm" style={{ background: color }} />
          <span className="h-full w-[2px] rounded-sm" style={{ background: color }} />
        </span>
      );
    case 'check':
      return (
        <svg {...common} width={size + 2} height={size + 2} viewBox="0 0 10 10" className={`shrink-0 ${className}`}>
          <path d="M1.5 5.2 4 7.6 8.5 2.6" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default: {
      const ring =
        meta.glyph === 'dot-dashed'
          ? { outline: `1px dashed ${color}`, outlineOffset: '1.5px' }
          : meta.glyph === 'dot-outline'
            ? { outline: `1px solid ${color}`, outlineOffset: '1.5px' }
            : {};
      return (
        <span {...common} className={`${base} ${className}`} style={{ width: px, height: px }}>
          {anim === 'halo' && (
            <span
              aria-hidden
              className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping"
              style={{ background: color, animationDuration: '2s' }}
            />
          )}
          <span
            className={`relative inline-block h-full w-full rounded-full ${anim === 'breath' ? 'motion-safe:animate-pulse' : ''}`}
            style={{ background: color, animationDuration: anim === 'breath' ? '2.4s' : undefined, ...ring }}
          />
        </span>
      );
    }
  }
}

