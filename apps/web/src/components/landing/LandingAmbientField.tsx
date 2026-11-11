'use client';

import { useEffect, useRef } from 'react';

type Blob = { x: number; y: number; r: number; hue: number; phase: number; speed: number };

export default function LandingAmbientField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: 0.5, y: 0.3, active: false });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const blobs: Blob[] = [
      { x: 0.25, y: 0.2, r: 0.3, hue: 200, phase: 0, speed: 0.00012 },
      { x: 0.7, y: 0.3, r: 0.25, hue: 220, phase: 1.2, speed: 0.0001 },
      { x: 0.5, y: 0.65, r: 0.28, hue: 210, phase: 2.4, speed: 0.00011 },
      { x: 0.2, y: 0.6, r: 0.2, hue: 195, phase: 0.8, speed: 0.00013 },
    ];
    const particles: { x: number; y: number; vx: number; vy: number; a: number }[] = [];
    for (let i = 0; i < 48; i++) {
      particles.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.00008,
        vy: (Math.random() - 0.5) * 0.00006 - 0.00002,
        a: 0.1 + Math.random() * 0.2,
      });
    }

    const onMove = (e: MouseEvent) => {
      mouseRef.current = {
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
        active: true,
      };
    };
    const onLeave = () => {
      mouseRef.current.active = false;
    };

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
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);

    const tick = (now: number) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      for (const b of blobs) {
        const t = now * b.speed + b.phase;
        const bx = (b.x + Math.sin(t) * 0.06) * w;
        const by = (b.y + Math.cos(t * 0.7) * 0.05) * h;
        const br = b.r * Math.min(w, h);
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, `hsla(${b.hue}, 60%, 60%, 0.07)`);
        g.addColorStop(0.5, `hsla(${b.hue}, 50%, 50%, 0.025)`);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }

      const mx = mouseRef.current;
      if (mx.active) {
        const sx = mx.x * w;
        const sy = mx.y * h;
        const spot = ctx.createRadialGradient(sx, sy, 0, sx, sy, 220);
        spot.addColorStop(0, 'rgba(0, 245, 255, 0.05)');
        spot.addColorStop(0.4, 'rgba(168, 85, 247, 0.02)');
        spot.addColorStop(1, 'transparent');
        ctx.fillStyle = spot;
        ctx.fillRect(0, 0, w, h);
      }

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = 1;
        if (p.x > 1) p.x = 0;
        if (p.y < 0) p.y = 1;
        if (p.y > 1) p.y = 0;
        ctx.fillStyle = `rgba(180, 210, 230, ${p.a * 0.5})`;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 0.8, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[1] opacity-60 mix-blend-screen"
    />
  );
}
