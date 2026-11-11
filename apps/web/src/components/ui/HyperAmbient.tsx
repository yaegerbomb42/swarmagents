'use client';

import { useEffect, useRef } from 'react';

/** CSS aurora orbs + cursor spotlight — lightweight ambient layer */
export default function HyperAmbient() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const el = ref.current;
    if (!el) return;

    let raf = 0;
    let mx = 0.5;
    let my = 0.35;
    let tx = mx;
    let ty = my;

    const onMove = (e: MouseEvent) => {
      mx = e.clientX / window.innerWidth;
      my = e.clientY / window.innerHeight;
    };

    const tick = () => {
      tx += (mx - tx) * 0.06;
      ty += (my - ty) * 0.06;
      el.style.setProperty('--mx', String(tx));
      el.style.setProperty('--my', String(ty));
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="hyper-ambient pointer-events-none fixed inset-0 z-0 overflow-hidden"
      style={{ '--mx': 0.5, '--my': 0.35 } as React.CSSProperties}
    >
      <div className="hyper-aurora">
        <div className="hyper-aurora__blob hyper-aurora__blob--1" />
        <div className="hyper-aurora__blob hyper-aurora__blob--2" />
        <div className="hyper-aurora__blob hyper-aurora__blob--3" />
      </div>
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(600px circle at calc(var(--mx) * 100%) calc(var(--my) * 100%), rgba(0, 245, 255, 0.06), transparent 55%)`,
        }}
      />
      <div className="hyper-grain" />
    </div>
  );
}
