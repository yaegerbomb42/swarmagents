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
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  return (h % 1_000_003) / 1_000_003;
}

export function hudTelemetry(t: number, seed: number): HudMetrics {
  const sig = (Math.sin(t * 0.5 + seed * 4) + 1) / 2;
  const dft = (Math.sin(t * 1.7 + seed * 9) + 1) / 2;
  const ld = (Math.sin(t * 0.85 + seed * 2) + 1) / 2;
  const temp = 38 + 18 * ((Math.sin(t * 0.3 + seed * 11) + 1) / 2);
  return {
    signal: 0.4 + sig * 0.58,
    drift: Math.min(1, Math.max(0, dft)),
    load: 0.25 + ld * 0.7,
    temp,
  };
}

export function prismSheen(t: number): { angle: number; opacity: number } {
  const angle = ((t * 22) % 360);
  const opacity = 0.25 + 0.35 * ((Math.sin(t * 1.2) + 1) / 2);
  return { angle, opacity };
}

export function tiltFromPointer(
  relX: number,
  relY: number,
  width: number,
  height: number,
  maxDeg = 8,
): { rx: number; ry: number } {
  if (width <= 0 || height <= 0) return { rx: 0, ry: 0 };
  const nx = (relX / width) * 2 - 1;
  const ny = (relY / height) * 2 - 1;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    rx: clamp(-ny) * maxDeg,
    ry: clamp(nx) * maxDeg,
  };
}

const fmtNum = (n: number, dp = 1): string => n.toFixed(dp);

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export interface PrismHudProps {
  className?: string;
  seed?: string;
  label?: string;
}

export default function PrismHud({
  className = '',
  seed = 'swarmagents.prism.v1',
  label = 'PRISM CORE',
}: PrismHudProps) {
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
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      const tilt = tiltFromPointer(relX, relY, rect.width, rect.height);
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

  const rows = [
    { icon: Activity, key: 'signal', label: 'SIGNAL', pct: metrics.signal, val: fmtNum(metrics.signal * 100, 0) },
    { icon: TrendingUp, key: 'drift', label: 'DRIFT', pct: 1 - metrics.drift, val: fmtNum(metrics.drift * 100, 0) },
    { icon: Gauge, key: 'load', label: 'LOAD', pct: metrics.load, val: fmtNum(metrics.load * 100, 0) },
  ];

  return (
    <motion.div
      ref={podRef}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{
        rotateX: sRx,
        rotateY: sRy,
        transformPerspective: 800,
      }}
      className={`relative overflow-hidden rounded-xl border border-cyan-500/20 bg-[#0c0c16]/80 p-4 backdrop-blur-md ${className}`}
    >
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-300"
        style={{
          background: `linear-gradient(${sheen.angle}deg, rgba(6,182,212,0.12) 0%, transparent 60%)`,
          opacity: sheen.opacity,
        }}
      />
      <div className="relative z-10 flex items-center justify-between border-b border-white/5 pb-2 mb-3">
        <span className="font-mono text-xs font-semibold tracking-wider text-cyan-300">{label}</span>
        <span className="font-mono text-[10px] text-zinc-400">{fmtNum(metrics.temp)}°C</span>
      </div>
      <div className="space-y-2">
        {rows.map((r) => {
          const Icon = r.icon;
          return (
            <div key={r.key} className="flex items-center gap-2 font-mono text-xs">
              <Icon className="h-3.5 w-3.5 text-zinc-400" />
              <span className="w-12 text-zinc-500 text-[10px]">{r.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-indigo-500 transition-all duration-300"
                  style={{ width: bar(r.pct) }}
                />
              </div>
              <span className="w-8 text-right text-[10px] text-zinc-300">{r.val}%</span>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
