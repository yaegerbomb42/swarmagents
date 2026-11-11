'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'sa.intro.v1';
const DURATION_MS = 3200;

type Node = { x: number; y: number; vx: number; vy: number; r: number; hue: number };

export default function SwarmIntro() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const done = useCallback(() => {
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      /* ignore */
    }
    setExiting(true);
    window.setTimeout(() => setVisible(false), 480);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    try {
      if (sessionStorage.getItem(KEY)) return;
    } catch {
      /* show once anyway */
    }
    setVisible(true);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let t0 = performance.now();
    const nodes: Node[] = [];
    const N = 9;
    const packets: { a: number; b: number; p: number; s: number }[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const cx = () => window.innerWidth / 2;
    const cy = () => window.innerHeight / 2 - 12;

    for (let i = 0; i < N; i++) {
      nodes.push({
        x: cx(),
        y: cy(),
        vx: 0,
        vy: 0,
        r: i === 0 ? 5.5 : 3.2 + (i % 3) * 0.4,
        hue: i === 0 ? 192 : 190 + (i % 3) * 12,
      });
    }
    for (let i = 0; i < 14; i++) {
      packets.push({
        a: 0,
        b: 1 + (i % (N - 1)),
        p: Math.random(),
        s: 0.004 + Math.random() * 0.006,
      });
    }

    const tick = (now: number) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const elapsed = now - t0;
      const spawn = Math.min(1, elapsed / 900);
      ctx.fillStyle = 'rgba(4, 7, 13, 0.28)';
      ctx.fillRect(0, 0, w, h);

      const root = nodes[0];
      root.x += (cx() - root.x) * 0.08;
      root.y += (cy() - root.y) * 0.08;

      for (let i = 1; i < N; i++) {
        const ring = 0.55 + (i % 3) * 0.22;
        const ang = (i / (N - 1)) * Math.PI * 2 + elapsed * 0.00035 * (i % 2 === 0 ? 1 : -1);
        const rad = Math.min(w, h) * 0.16 * ring * spawn;
        const tx = cx() + Math.cos(ang) * rad * (1 + 0.08 * Math.sin(elapsed * 0.002 + i));
        const ty = cy() + Math.sin(ang) * rad * 0.82;
        nodes[i].x += (tx - nodes[i].x) * 0.07;
        nodes[i].y += (ty - nodes[i].y) * 0.07;
      }

      ctx.lineWidth = 1;
      for (let i = 1; i < N; i++) {
        const n = nodes[i];
        const g = ctx.createLinearGradient(root.x, root.y, n.x, n.y);
        g.addColorStop(0, 'rgba(0, 240, 255, 0.65)');
        g.addColorStop(1, 'rgba(0, 150, 255, 0.2)');
        ctx.strokeStyle = g;
        ctx.beginPath();
        ctx.moveTo(root.x, root.y);
        ctx.quadraticCurveTo(
          (root.x + n.x) / 2 + Math.sin(elapsed * 0.001 + i) * 18,
          (root.y + n.y) / 2,
          n.x,
          n.y,
        );
        ctx.stroke();
      }
      for (let i = 1; i < N; i++) {
        const j = 1 + (i % (N - 1));
        if (j === i) continue;
        ctx.strokeStyle = 'rgba(0, 240, 255, 0.08)';
        ctx.beginPath();
        ctx.moveTo(nodes[i].x, nodes[i].y);
        ctx.lineTo(nodes[j].x, nodes[j].y);
        ctx.stroke();
      }

      for (const pk of packets) {
        pk.p += pk.s;
        if (pk.p > 1) pk.p -= 1;
        const a = nodes[pk.a];
        const b = nodes[pk.b];
        const x = a.x + (b.x - a.x) * pk.p;
        const y = a.y + (b.y - a.y) * pk.p;
        ctx.fillStyle = 'rgba(0, 240, 255, 0.95)';
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const n of nodes) {
        ctx.shadowColor = `rgba(0, 240, 255, 0.8)`;
        ctx.shadowBlur = 18;
        ctx.fillStyle = `rgba(180, 248, 255, 0.95)`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      raf = requestAnimationFrame(tick);
    };
    ctx.fillStyle = '#04070d';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    raf = requestAnimationFrame(tick);
    const to = window.setTimeout(done, DURATION_MS);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(to);
      window.removeEventListener('resize', resize);
    };
  }, [visible, done]);

  if (!visible) return null;

  return (
    <div
      role="presentation"
      onClick={done}
      className={`fixed inset-0 z-[80] cursor-pointer bg-[#04070d] transition-opacity duration-500 flex flex-col items-center justify-center ${
        exiting ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <canvas ref={canvasRef} className="absolute inset-0 opacity-75" />
      
      {/* Video Overlay with electric cyan luminescence */}
      <div className="relative z-10 flex flex-col items-center justify-center max-w-xl w-full px-6 pointer-events-none">
        <div className="relative w-full max-w-[460px] aspect-[16/9] flex items-center justify-center overflow-hidden rounded-2xl">
          <video
            autoPlay
            loop
            muted
            playsInline
            className="w-full h-full object-contain mix-blend-screen drop-shadow-[0_0_24px_rgba(0,240,255,0.45)]"
          >
            <source src="/brand/loading_icon.mp4" type="video/mp4" />
          </video>
        </div>

        <div className="flex flex-col items-center text-center mt-2">
          <p className="font-mono text-[11px] tracking-[0.45em] uppercase text-cyan-400 font-semibold mb-2 drop-shadow-[0_0_10px_rgba(0,240,255,0.5)]">
            multi-agent substrate
          </p>
          <p className="mt-1 text-[12px] text-cyan-200/60 font-mono tracking-wide">
            one goal · many agents · shared blackboard
          </p>
        </div>
      </div>
    </div>
  );
}
