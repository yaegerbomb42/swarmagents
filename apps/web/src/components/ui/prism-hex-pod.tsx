'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import {
  Activity,
  ArrowUpRight,
  Gauge,
  Thermometer,
  TrendingUp,
  Waves,
} from 'lucide-react';

export interface HudMetrics {
  signal: number;
  drift: number;
  load: number;
  temp: number;
}

export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  return (h % 1_000_003) / 1_000_003;
}

export function hudTelemetry(t: number, seed: number): HudMetrics {
  const sig = (Math.sin(t * 0.5 + seed * 4) + 1) / 2;
  const dft = Math.min(1, Math.max(0, (Math.sin(t * 1.7 + seed * 9) + 1) / 2));
  const ld = (Math.sin(t * 0.85 + seed * 2) + 1) / 2;
  const temp = 38 + 18 * ((Math.sin(t * 0.3 + seed * 11) + 1) / 2);
  return {
    signal: 0.4 + sig * 0.58,
    drift: dft,
    load: 0.25 + ld * 0.7,
    temp,
  };
}

export function prismSheen(t: number, period = 7): number {
  const phi = ((t % period) + period) % period;
  return phi / period;
}

export function tiltFromPointer(
  px: number,
  py: number,
  w: number,
  h: number,
  maxDeg = 10,
): { rx: number; ry: number } {
  if (w <= 0 || h <= 0) return { rx: 0, ry: 0 };
  const nx = (px / w) * 2 - 1;
  const ny = (py / h) * 2 - 1;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const zeroOr = (v: number) => (v === 0 ? 0 : v); // collapses -0 into 0
  return { rx: zeroOr(clamp(-ny) * maxDeg), ry: zeroOr(clamp(nx) * maxDeg) };
}

const fmtNum = (n: number, dp = 1): string => n.toFixed(dp);

function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export interface PrismHexPodProps {
  className?: string;
  seed?: string;
  label?: string;
}

export default function PrismHexPod({
  className = '',
  seed = 'swarmagents.prism.v1',
  label = 'PRISM CORE',
}: PrismHexPodProps) {
  const podRef = useRef<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();

  const seedNum = useMemo(() => hashSeed(seed), [seed]);
  const [tNow, setTNow] = useState(0);
  const [metrics, setMetrics] = useState<HudMetrics>(() =>
    hudTelemetry(0, seedNum),
  );

  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const sRx = useSpring(rx, { stiffness: 140, damping: 16, mass: 0.4 });
  const sRy = useSpring(ry, { stiffness: 140, damping: 16, mass: 0.4 });

  const onMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (reduced) return;
      const el = podRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const tilt = tiltFromPointer(
        e.clientX - rect.left,
        e.clientY - rect.top,
        rect.width,
        rect.height,
      );
      rx.set(tilt.rx);
      ry.set(tilt.ry);
    },
    [reduced, rx, ry],
  );

  const onLeave = useCallback(() => {
    rx.set(0);
    ry.set(0);
  }, [rx, ry]);

  useEffect(() => {
    const tick = () => {
      const t = performance.now() / 1000;
      setTNow(t);
      setMetrics(hudTelemetry(t, seedNum));
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [seedNum]);

  const sheen = prismSheen(tNow);
  const bar = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;

  const rows: Array<{ key: string; label: string; pct: number; val: string }> = [
    { key: 'signal', label: 'SIGNAL', pct: metrics.signal, val: fmtNum(metrics.signal * 100, 0) },
    { key: 'drift', label: 'DRIFT', pct: 1 - metrics.drift, val: fmtNum(metrics.drift * 100, 0) },
    { key: 'load', label: 'LOAD', pct: metrics.load, val: fmtNum(metrics.load * 100, 0) },
  ];

  return (
    <div
      ref={podRef}
      data-testid="prism-hex-pod"
      role="region"
      aria-label={`PrismHUD — ${label}`}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      className={`relative h-full min-h-[220px] w-full select-none ${className}`}
    >
      <motion.div
        data-testid="prism-hex-pod-pod"
        style={{ rotateX: sRx, rotateY: sRy }}
        className="relative h-full w-full overflow-hidden rounded-2xl border border-white/15 bg-gradient-to-br from-white/[0.09] via-white/[0.03] to-cyan-300/[0.07] backdrop-blur-xl shadow-[0_30px_80px_-30px_rgba(0,212,255,0.45)]"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(105deg, transparent 0%, transparent 38%, rgba(255,255,255,0.28) 50%, rgba(0,229,255,0.18) 58%, transparent 72%, transparent 100%)',
            transform: `translateX(${(sheen * 2 - 1) * 70}%) skewX(-12deg)`,
            mixBlendMode: 'screen',
          }}
        />

        <span data-testid="prism-hex-pod-bracket" aria-hidden className="pointer-events-none absolute left-2 top-2 h-4 w-4 rounded-tl border-t border-l border-cyan-300/70" />
        <span data-testid="prism-hex-pod-bracket" aria-hidden className="pointer-events-none absolute right-2 top-2 h-4 w-4 rounded-tr border-t border-r border-cyan-300/70" />
        <span data-testid="prism-hex-pod-bracket" aria-hidden className="pointer-events-none absolute bottom-2 left-2 h-4 w-4 rounded-bl border-b border-l border-cyan-300/70" />
        <span data-testid="prism-hex-pod-bracket" aria-hidden className="pointer-events-none absolute bottom-2 right-2 h-4 w-4 rounded-br border-b border-r border-cyan-300/70" />

        <div
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent ${
            reduced ? 'top-8' : 'animate-[prism-scan_5s_linear_infinite]'
          }`}
        />

        <div className="relative z-10 flex items-center justify-between px-4 pt-3">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-200/90">
            <Waves className="h-3.5 w-3.5 text-cyan-300" aria-hidden />
            {label}
          </span>
          <ArrowUpRight className="h-4 w-4 text-white/35" aria-hidden />
        </div>

        <div data-testid="prism-hex-pod-metrics" className="relative z-10 flex flex-1 flex-col justify-center gap-2.5 px-5 py-3">
          {rows.map((r) => (
            <div key={r.key} data-testid="prism-hex-pod-row" className="flex items-center gap-2.5">
              <span className="w-20 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
                {r.label}
              </span>
              <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                  data-testid="prism-hex-pod-bar"
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-teal-300 to-fuchsia-400"
                  style={{ width: bar(r.pct) }}
                />
              </div>
              <span className="w-10 text-right font-mono text-[10px] tabular-nums text-cyan-100">
                {r.val}
              </span>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-2.5">
            <span className="w-20 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
              THERMAL
            </span>
            <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-amber-200">
              <Thermometer className="h-3 w-3 text-amber-300" aria-hidden />
              {fmtNum(metrics.temp)}°C
            </span>
          </div>
        </div>

        <style data-css="prism-hex-pod">{`
          @keyframes prism-scan {
            0% { top: 0%; opacity: 0; }
            12% { opacity: 1; }
            88% { opacity: 1; }
            100% { top: 100%; opacity: 0; }
          }
        `}</style>
      </motion.div>
    </div>
  );
}
