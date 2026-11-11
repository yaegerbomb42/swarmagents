'use client';

import { useEffect, useRef } from 'react';

export type SciFiReticleProps = {
  className?: string;
  color?: string;
};

export default function SciFiReticle({
  className = '',
  color = 'rgba(6, 182, 212, 0.35)',
}: SciFiReticleProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let tx = x;
    let ty = y;
    let raf = 0;

    const onMove = (e: PointerEvent) => {
      tx = e.clientX;
      ty = e.clientY;
    };

    const tick = () => {
      x += (tx - x) * 0.18;
      y += (ty - y) * 0.18;
      el.style.transform = `translate(${x}px, ${y}px)`;
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className={`pointer-events-none fixed top-0 left-0 z-[60] -translate-x-1/2 -translate-y-1/2 ${className}`}
    >
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="14" stroke={color} strokeWidth="0.75" strokeDasharray="3 4" />
        <circle cx="24" cy="24" r="3" fill={color} opacity="0.6" />
        <line x1="24" y1="4" x2="24" y2="12" stroke={color} strokeWidth="1" />
        <line x1="24" y1="36" x2="24" y2="44" stroke={color} strokeWidth="1" />
        <line x1="4" y1="24" x2="12" y2="24" stroke={color} strokeWidth="1" />
        <line x1="36" y1="24" x2="44" y2="24" stroke={color} strokeWidth="1" />
        <rect x="8" y="8" width="4" height="4" stroke={color} strokeWidth="0.75" />
        <rect x="36" y="8" width="4" height="4" stroke={color} strokeWidth="0.75" />
        <rect x="8" y="36" width="4" height="4" stroke={color} strokeWidth="0.75" />
        <rect x="36" y="36" width="4" height="4" stroke={color} strokeWidth="0.75" />
      </svg>
    </div>
  );
}
