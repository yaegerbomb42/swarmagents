'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSwarmTelemetry } from '@/hooks/useSwarmTelemetry';

// ════════════════════════════════════════════════════════════
//  LatentWorldModel — the swarm's collective inner world model
//
//  Renders a 2-D projection of agent state as a dither grid.
//  Each cell maps to a region of latent space; brightness
//  encodes activation, hue encodes the dominant agent cluster
//  (reasoner / executor / validator / memory / perception).
//
//  When the model "thinks", new thoughts ripple outward from
//  the cell representing that agent's neuron position.
//
//  Falls back to a coherent perlin-ish pattern when no live
//  telemetry exists, so the marketing visual still works.
// ════════════════════════════════════════════════════════════

type Cluster = 'reasoner' | 'executor' | 'validator' | 'memory' | 'perception' | 'orchestrator';

const CLUSTER_HUE: Record<Cluster, [number, number, number]> = {
  reasoner:     [94, 234, 212],  // cyan-300
  executor:     [103, 232, 249], // sky-300
  validator:    [110, 231, 183], // emerald-300
  memory:       [196, 181, 253], // violet-300
  perception:   [253, 224, 71],  // amber-300
  orchestrator: [244, 114, 182], // pink-400
};

// Cheap hash → [0,1)
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) * 16777619;
  }
  return ((h >>> 0) % 100000) / 100000;
}

function inferCluster(id: string, provider?: string): Cluster {
  const s = (id + (provider || '')).toLowerCase();
  if (s.includes('orch') || s.includes('plan')) return 'orchestrator';
  if (s.includes('reason') || s.includes('hamil')) return 'reasoner';
  if (s.includes('exec') || s.includes('code') || s.includes('cere') || s.includes('groq')) return 'executor';
  if (s.includes('valid') || s.includes('safe') || s.includes('crit')) return 'validator';
  if (s.includes('mem') || s.includes('know')) return 'memory';
  if (s.includes('percep') || s.includes('nav') || s.includes('intent')) return 'perception';
  return ['reasoner','executor','validator','memory','perception'][Math.floor(hash01(id)*5)] as Cluster;
}

// Map an id to a stable (x,y) in latent space [0,1]×[0,1]
function projectId(id: string): [number, number] {
  return [hash01(id + ':x'), hash01(id + ':y')];
}

export interface LatentWorldModelProps {
  /** Grid resolution (chars across). */
  cols?: number;
  /** Grid resolution (chars down). */
  rows?: number;
  /** Cell font size in px. */
  cellPx?: number;
  /** Display caption beneath the grid. */
  caption?: string;
  /** Show the small label overlay. */
  showOverlay?: boolean;
  /** Background color. */
  bg?: string;
  className?: string;
}

const CHAR_RAMP = ' .·:+×#█'; // light → dense

export function LatentWorldModel({
  cols = 96,
  rows = 32,
  cellPx = 9,
  caption = 'inner world model — agent activations projected to 2-D latent space',
  showOverlay = true,
  bg = '#040414',
  className = '',
}: LatentWorldModelProps) {
  const tele = useSwarmTelemetry(3000);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(performance.now());
  const ripplesRef = useRef<Array<{ x: number; y: number; t0: number; cluster: Cluster; intensity: number }>>([]);
  const lastJournalLenRef = useRef<number>(0);

  // Build a stable list of "anchors" (one per worker) in latent space + their cluster
  const anchors = useMemo(() => {
    const ws = tele.workers.length ? tele.workers : [
      // mock anchors so the visual works in marketing/offline mode
      { id: 'orch-0',     provider: 'orchestrator' },
      { id: 'ham-0',      provider: 'hamiltonian' },
      { id: 'reason-0',   provider: 'reasoner' },
      { id: 'reason-1',   provider: 'reasoner' },
      { id: 'exec-0',     provider: 'cerebras' },
      { id: 'exec-1',     provider: 'groq' },
      { id: 'valid-0',    provider: 'validator' },
      { id: 'valid-1',    provider: 'safety' },
      { id: 'mem-0',      provider: 'memory' },
      { id: 'mem-1',      provider: 'episodic' },
      { id: 'percep-0',   provider: 'perception' },
      { id: 'nav-0',      provider: 'navigator' },
    ];
    return ws.map(w => {
      const [x, y] = projectId(w.id);
      return {
        id: w.id,
        x, y,
        cluster: inferCluster(w.id, w.provider),
        baseActivation: 'status' in w && w.status === 'busy' ? 1.0 : 0.6,
      };
    });
  }, [tele.workers]);

  // Watch journal — emit ripples on new entries
  useEffect(() => {
    const j = tele.journal;
    if (j.length > lastJournalLenRef.current) {
      const newOnes = j.slice(lastJournalLenRef.current);
      lastJournalLenRef.current = j.length;
      const now = performance.now();
      // bind each new thought to a (random-stable) anchor
      newOnes.slice(-3).forEach((entry, i) => {
        const anchor = anchors[Math.floor(hash01(entry + i) * anchors.length)];
        if (!anchor) return;
        ripplesRef.current.push({
          x: anchor.x,
          y: anchor.y,
          t0: now,
          cluster: anchor.cluster,
          intensity: 1.0,
        });
      });
    }
  }, [tele.journal, anchors]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = cols * cellPx;
    const H = rows * cellPx;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    const drawFrame = () => {
      const tMs = performance.now();
      const t = (tMs - startRef.current) / 1000;

      // Clear
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // Field: at each cell compute (a) base perlin-ish wave + (b) anchor contributions + (c) ripples
      ctx.font = `${cellPx}px ui-monospace, monospace`;
      ctx.textBaseline = 'top';

      // Prune dead ripples
      const RIPPLE_LIFE = 2.2; // s
      ripplesRef.current = ripplesRef.current.filter(r => (tMs - r.t0) / 1000 < RIPPLE_LIFE);

      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const nx = cx / cols;
          const ny = cy / rows;

          // Background wave (slow, makes the "field" feel alive even when idle)
          const wave =
            0.5 + 0.25 * Math.sin(t * 0.7 + nx * 6.3 + Math.sin(ny * 4.0)) +
                  0.15 * Math.sin(t * 0.3 + (nx + ny) * 9.0);

          // Anchor contributions (RBF kernel around each agent's latent location)
          let weightedR = 0, weightedG = 0, weightedB = 0;
          let anchorMass = 0;
          for (const a of anchors) {
            const dx = nx - a.x;
            const dy = ny - a.y;
            const d2 = dx * dx + dy * dy;
            const sigma = 0.10; // softness
            const k = Math.exp(-d2 / (2 * sigma * sigma));
            // gentle modulation per anchor over time
            const beat = 0.7 + 0.3 * Math.sin(t * (1 + hash01(a.id) * 1.5) + hash01(a.id) * 6.28);
            const w = k * a.baseActivation * beat;
            anchorMass += w;
            const [r, g, b] = CLUSTER_HUE[a.cluster];
            weightedR += w * r;
            weightedG += w * g;
            weightedB += w * b;
          }
          if (anchorMass > 0) {
            weightedR /= anchorMass;
            weightedG /= anchorMass;
            weightedB /= anchorMass;
          } else {
            weightedR = 94; weightedG = 234; weightedB = 212;
          }

          // Ripple contributions
          let rippleE = 0;
          for (const r of ripplesRef.current) {
            const dx = nx - r.x;
            const dy = ny - r.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            const age = (tMs - r.t0) / 1000;
            const radius = age * 0.55;       // expansion speed
            const ring = Math.exp(-((d - radius) ** 2) / 0.0008);
            const decay = 1 - age / RIPPLE_LIFE;
            rippleE += ring * decay * r.intensity;
            if (ring * decay > 0.6) {
              const [rr, gg, bb] = CLUSTER_HUE[r.cluster];
              weightedR = weightedR * 0.5 + rr * 0.5;
              weightedG = weightedG * 0.5 + gg * 0.5;
              weightedB = weightedB * 0.5 + bb * 0.5;
            }
          }

          // Composite activation in [0,1]
          let act = 0.45 * wave + 0.45 * Math.min(1, anchorMass) + 0.6 * rippleE;
          act = Math.max(0, Math.min(1, act));

          // Pick glyph
          const glyphIdx = Math.min(CHAR_RAMP.length - 1, Math.floor(act * CHAR_RAMP.length));
          const ch = CHAR_RAMP[glyphIdx];
          if (ch === ' ') continue;

          const alpha = 0.30 + 0.70 * act;
          ctx.fillStyle = `rgba(${(weightedR | 0)}, ${(weightedG | 0)}, ${(weightedB | 0)}, ${alpha.toFixed(3)})`;
          ctx.fillText(ch, cx * cellPx, cy * cellPx);
        }
      }

      rafRef.current = requestAnimationFrame(drawFrame);
    };

    rafRef.current = requestAnimationFrame(drawFrame);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [cols, rows, cellPx, anchors, bg]);

  return (
    <div className={`relative ${className}`} style={{ width: cols * cellPx, height: rows * cellPx }}>
      <canvas ref={canvasRef} className="block" />
      {showOverlay && (
        <>
          <div className="pointer-events-none absolute left-2 top-2 text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-300/80">
            latent state · {tele.engineReachable ? 'LIVE' : 'demo'}
          </div>
          <div className="pointer-events-none absolute right-2 top-2 text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-300/60">
            {anchors.length} neurons · {tele.phase}
          </div>
          <div className="pointer-events-none absolute left-2 bottom-2 text-[9px] font-mono text-cyan-200/50 max-w-[80%] leading-tight">
            {caption}
          </div>
          {/* tiny legend */}
          <div className="pointer-events-none absolute right-2 bottom-2 text-[9px] font-mono text-cyan-200/60 flex gap-2 items-center">
            {(['reasoner','executor','validator','memory','perception'] as Cluster[]).map(c => (
              <span key={c} className="flex items-center gap-1">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ background: `rgb(${CLUSTER_HUE[c].join(',')})` }}
                />
                {c[0]}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default LatentWorldModel;
