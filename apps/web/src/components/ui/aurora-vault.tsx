'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  Cpu,
  Gauge,
  Orbit,
  Radar as RadarIcon,
  Sparkles,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════
   AuroraVault — generative holographic aurora + particle vortex
   hero visual. Canvas-driven, deterministic simulation exposed
   as pure functions for unit testing. Reduced-motion aware.
   ════════════════════════════════════════════════════════════ */

export interface Particle {
  angle0: number;
  radius0: number;
  phase: number;
  speed: number;
  size: number;
  hue: number;
}

export interface VaultTelemetry {
  nodes: number;
  threads: number;
  errorRate: number;
  uplink: number; // 0..1
}

/** FNV-1a style deterministic hash → [0, 1). Pure & stable across calls. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  return (h % 1_000_003) / 1_000_003;
}

/** Normalize a raw t into a soft looping time domain (fraction of a period). */
export function loopTime(t: number, period = 18): number {
  const phi = ((t % period) + period) % period;
  return phi / period; // 0..1 across the whole loop
}

/** Aurora curtain elevation at horizontal position x for a given band. 0..1. */
export function auroraCurtain(
  x: number,
  t: number,
  seed: number,
  band: number,
): number {
  const s = seed * 137.5;
  const w1 = Math.sin(x * 0.9 + t * 1.1 + band * 1.7 + s);
  const w2 = Math.sin(x * 2.3 - t * 0.7 + band + s * 2.0);
  const w3 = Math.sin(x * 4.1 + t * 0.35 + band * 2.4 + s);
  return 0.32 + 0.28 * w1 + 0.22 * w2 + 0.18 * w3;
}

/** Deterministic set of orbiting vortex particles for a given seed. */
export function orbitParticles(count: number, seed: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const r1 = hashSeed(`${seed}:${i}:r`);
    const r2 = hashSeed(`${seed}:${i}:p`);
    const r3 = hashSeed(`${seed}:${i}:s`);
    const r4 = hashSeed(`${seed}:${i}:h`);
    out.push({
      angle0: r1 * Math.PI * 2,
      radius0: 0.18 + r2 * 0.5,
      phase: r3 * Math.PI * 2,
      speed: 0.35 + r3 * 0.8,
      size: 0.012 + r2 * 0.05,
      hue: Math.floor(150 + r4 * 160), // cyan → magenta band
    });
  }
  return out;
}

/** Deterministic telemetry snapshot derived purely from seed + elapsed time. */
export function simulateTelemetry(
  count: number,
  elapsedSec: number,
  seed: number,
): VaultTelemetry {
  const beat = Math.sin(elapsedSec * 0.6 + seed * 40);
  const nodes = Math.max(4, Math.round(count * (0.82 + 0.18 * beat)));
  const threadFrac = (Math.sin(elapsedSec * 0.9 + seed * 7) + 1) / 2;
  const threads = Math.max(8, Math.round(nodes * (2.1 + threadFrac * 1.4)));
  const errFrac = hashSeed(`${seed}:${Math.floor(elapsedSec / 4)}`);
  const errorRate = 0.002 + errFrac * 0.03;
  const uplinkFrac = (Math.sin(elapsedSec * 0.45 + seed * 13) + 1) / 2;
  return {
    nodes,
    threads,
    errorRate,
    uplink: 0.7 + uplinkFrac * 0.28,
  };
}

const fmtInt = (n: number): string => n.toString().padStart(4, '0');
const fmtPct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export interface AuroraVaultProps {
  className?: string;
  seed?: string;
  particleCount?: number;
}

export default function AuroraVault({
  className = '',
  seed = 'swarmagents.aurora.v1',
  particleCount = 220,
}: AuroraVaultProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const reduced = useReducedMotion();

  const seedNum = useMemo(() => hashSeed(seed), [seed]);
  const particles = useMemo(
    () => orbitParticles(particleCount, seedNum),
    [particleCount, seedNum],
  );

  const [telemetry, setTelemetry] = useState<VaultTelemetry>(() =>
    simulateTelemetry(particleCount, 0, seedNum),
  );
  const [elapsed, setElapsed] = useState(0);
  const [canvasBroken, setCanvasBroken] = useState(false);

  const draw = useCallback(
    (now: number): boolean => {
      const canvas = canvasRef.current;
      if (!canvas) return false;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setCanvasBroken(true);
        return false;
      }

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      if (canvas.width !== Math.floor(w * dpr)) canvas.width = Math.floor(w * dpr);
      if (canvas.height !== Math.floor(h * dpr)) canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const tSec = startRef.current > 0 ? (now - startRef.current) / 1000 : 0;
      const lt = loopTime(tSec);
      const cx = w / 2;
      const cy = h / 2;

      ctx.clearRect(0, 0, w, h);

      // ── Aurora curtains ────────────────────────────────────────
      ctx.globalCompositeOperation = 'lighter';
      for (let band = 0; band < 3; band++) {
        ctx.beginPath();
        for (let px = 0; px <= w; px += 6) {
          const n = px / w;
          const elev = auroraCurtain(n, lt, seedNum, band);
          const y = cy + (band - 1) * h * 0.18 + elev * h * 0.42;
          if (px === 0) ctx.moveTo(px, y);
          else ctx.lineTo(px, y);
        }
        const bandHue = 175 + band * 32;
        const grad = ctx.createLinearGradient(0, cy - h * 0.35, 0, cy + h * 0.45);
        grad.addColorStop(0, `hsla(${bandHue}, 100%, 62%, 0)`);
        grad.addColorStop(0.45, `hsla(${bandHue}, 100%, 60%, ${0.16 - band * 0.04})`);
        grad.addColorStop(1, `hsla(${bandHue}, 100%, 55%, 0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 22 - band * 6;
        ctx.stroke();
      }

      // ── Orbiting particle vortex ───────────────────────────────
      const orbitT = lt * Math.PI * 2;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const ang = p.angle0 + orbitT * p.speed * (p.radius0 + 0.2);
        const orbitR =
          Math.min(w, h) * (0.16 + p.radius0 * 0.6) *
          (1 + 0.05 * Math.sin(p.phase + orbitT * 2));
        const px = cx + Math.cos(ang) * orbitR;
        const py = cy + Math.sin(ang) * orbitR * 0.62;
        const tw = 0.4 + 0.6 * ((Math.sin(p.phase + orbitT * 3) + 1) / 2);
        ctx.beginPath();
        ctx.fillStyle = `hsla(${p.hue}, 95%, ${58 + tw * 22}%, ${0.35 + tw * 0.5})`;
        ctx.arc(px, py, Math.max(0.6, p.size * Math.min(w, h) * 0.5 * tw), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      // ── Scan sweep ─────────────────────────────────────────────
      const sx = cx + Math.cos(orbitT) * Math.min(w, h) * 0.55;
      const sy = cy + Math.sin(orbitT) * Math.min(w, h) * 0.55;
      const sweep = ctx.createRadialGradient(sx, sy, 4, sx, sy, Math.min(w, h) * 0.5);
      sweep.addColorStop(0, 'rgba(103,232,249,0.14)');
      sweep.addColorStop(1, 'rgba(103,232,249,0)');
      ctx.fillStyle = sweep;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.min(w, h) * 0.5, 0, Math.PI * 2);
      ctx.fill();

      return true;
    },
    [particles, seedNum],
  );

// Telemetry ticker — independent of canvas health.
  useEffect(() => {
    const tick = () => {
      const now = performance.now();
      const t = startRef.current > 0 ? (now - startRef.current) / 1000 : 0;
      setElapsed(t);
      setTelemetry(simulateTelemetry(particleCount, t, seedNum));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [particleCount, seedNum]);

  // Animation loop.
  useEffect(() => {
    if (reduced) {
      startRef.current = 0;
      draw(1);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const loop = (now: number) => {
      if (startRef.current === 0) startRef.current = now;
      draw(now);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    const onResize = () => draw(performance.now());
    window.addEventListener('resize', onResize);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', onResize);
    };
  }, [draw, reduced]);

  const crosshair = [
    { label: 'PULSE', value: fmtInt(Math.round(elapsed * 10)) },
    { label: 'UPLINK', value: fmtPct(telemetry.uplink) },
    { label: 'ERROR', value: fmtPct(telemetry.errorRate) },
  ];

  return (
    <section
      data-testid="aurora-vault"
      role="region"
      aria-label="AuroraVault generative telemetry visual"
      className="relative isolate overflow-hidden rounded-3xl border border-white/10 bg-[#0a0d18]/60 shadow-[0_0_60px_-18px_rgba(6,182,212,0.55)]"
    >
      <canvas
        ref={canvasRef}
        data-testid="aurora-vault-canvas"
        aria-hidden
        className={`absolute inset-0 h-full w-full ${reduced ? '' : 'animate-[aurora-breathe_9s_ease-in-out_infinite]'}`}
        style={{ pointerEvents: 'none' }}
      />

      {/* Top-left crosshair / HUD frame */}
      <motion.div
        data-testid="aurora-vault-hud"
        className="pointer-events-none absolute left-4 top-4 flex items-center gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2 backdrop-blur-md"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.6 }}
      >
        <div className="grid grid-cols-3 gap-3 font-mono">
          {crosshair.map((c) => (
            <div key={c.label} className="flex flex-col">
              <span className="text-[8px] uppercase tracking-[0.25em] text-cyan-400/70">
                {c.label}
              </span>
              <span className="text-[13px] font-semibold tabular-nums text-cyan-100">
                {c.value}
              </span>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Bottom glass telemetry strip */}
      <motion.div
        data-testid="aurora-vault-telemetry"
        className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-3 py-2 backdrop-blur-md"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.45, duration: 0.6 }}
      >
        <span className="flex items-center gap-1.5 pr-2 text-[9px] uppercase tracking-[0.22em] text-white/40">
          <Sparkles className="h-3 w-3 text-cyan-300" aria-hidden /> Aurora Vault
        </span>
        <span className="flex items-center gap-1.5 rounded-md border border-cyan-500/20 bg-cyan-500/[0.06] px-2 py-1 font-mono text-[10px] text-cyan-200">
          <Cpu className="h-3 w-3" aria-hidden /> {telemetry.nodes} nodes
        </span>
        <span className="flex items-center gap-1.5 rounded-md border border-fuchsia-500/20 bg-fuchsia-500/[0.06] px-2 py-1 font-mono text-[10px] text-fuchsia-200">
          <Orbit className="h-3 w-3" aria-hidden /> {telemetry.threads} threads
        </span>
        <span className="flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/[0.06] px-2 py-1 font-mono text-[10px] text-emerald-200">
          <Activity className="h-3 w-3" aria-hidden /> {fmtPct(1 - telemetry.errorRate)} stable
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] text-white/45">
          <Gauge className="h-3 w-3 text-cyan-400" aria-hidden />
          <span className="text-emerald-300">{fmtPct(telemetry.uplink)}</span>
        </span>
        {!reduced && (
          <span className="hidden items-center gap-1 sm:flex">
            <RadarIcon
              className="h-3 w-3 animate-[aurora-radar_3.2s_linear_infinite] text-cyan-400"
              aria-hidden
            />
          </span>
        )}
      </motion.div>

      {canvasBroken && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" aria-live="polite">
          <p className="px-4 text-center font-mono text-[11px] text-cyan-300/70">
            canvas unavailable — rendering fallback aura
          </p>
        </div>
      )}

      <style jsx>{`
        @keyframes aurora-breathe {
          0%,
          100% { opacity: 1; }
          50% { opacity: 0.82; }
        }
        @keyframes aurora-radar {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </section>
  );
}