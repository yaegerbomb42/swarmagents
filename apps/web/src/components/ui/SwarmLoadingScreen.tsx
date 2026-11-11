'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  phase: number; // 0: free, 1: forming, 2: settled
  settled: boolean;
}

interface LoadingScreenProps {
  onComplete: () => void;
  children: React.ReactNode;
}

function getTextParticles(text: string, w: number, h: number, fontSize: number): { x: number; y: number }[] {
  const off = document.createElement('canvas');
  const ctx = off.getContext('2d')!;
  off.width = w;
  off.height = h;
  ctx.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  const imageData = ctx.getImageData(0, 0, w, h);
  const pts: { x: number; y: number }[] = [];
  const step = 4;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (imageData.data[i + 3] > 100) {
        pts.push({ x, y });
      }
    }
  }
  return pts;
}

export default function SwarmLoadingScreen({ onComplete, children }: LoadingScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const startAnimation = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = canvas.width = canvas.offsetWidth;
    let h = canvas.height = canvas.offsetHeight;

    const fontSize = Math.min(w / 8, 68);
    const textPts = getTextParticles('swarmagents.codes', w, h, fontSize);
    const targetCount = Math.min(textPts.length, 1200);
    const sampledTargets = [];
    for (let i = 0; i < targetCount; i++) {
      const idx = Math.floor((i / targetCount) * textPts.length);
      sampledTargets.push(textPts[idx]);
    }

    // Start with a few particles at center
    const particles: Particle[] = [];
    for (let i = 0; i < 5; i++) {
      particles.push({
        x: w / 2 + (Math.random() - 0.5) * 20,
        y: h / 2 + (Math.random() - 0.5) * 20,
        vx: 0, vy: 0,
        targetX: 0, targetY: 0,
        phase: 0, settled: false,
      });
    }

    let startTime = performance.now();
    let divisionPhase = true;
    let formPhase = false;
    let completePhase = false;
    let animId: number;

    const animate = (t: number) => {
      const elapsed = t - startTime;

      // Division phase: particles multiply
      if (divisionPhase && elapsed < 4000) {
        if (particles.length < targetCount && Math.random() < 0.15) {
          const parent = particles[Math.floor(Math.random() * particles.length)];
          particles.push({
            x: parent.x + (Math.random() - 0.5) * 30,
            y: parent.y + (Math.random() - 0.5) * 30,
            vx: (Math.random() - 0.5) * 2,
            vy: (Math.random() - 0.5) * 2,
            targetX: 0, targetY: 0,
            phase: 0, settled: false,
          });
        }
      } else if (divisionPhase && elapsed >= 4000) {
        divisionPhase = false;
        formPhase = true;
        // Assign targets
        for (let i = 0; i < particles.length; i++) {
          const target = sampledTargets[i % sampledTargets.length];
          particles[i].targetX = target.x;
          particles[i].targetY = target.y;
          particles[i].phase = 1;
        }
      }

      // Forming phase: particles move to text shape
      if (formPhase && elapsed > 4000 && elapsed < 8000) {
        const progress = (elapsed - 4000) / 4000;
        for (const p of particles) {
          if (p.phase === 1) {
            p.vx += (p.targetX - p.x) * 0.003;
            p.vy += (p.targetY - p.y) * 0.003;
            p.vx *= 0.92;
            p.vy *= 0.92;
            p.x += p.vx;
            p.y += p.vy;
            if (progress > 0.85 && Math.abs(p.x - p.targetX) < 3 && Math.abs(p.y - p.targetY) < 3) {
              p.phase = 2;
              p.settled = true;
            }
          }
        }
      } else if (formPhase && elapsed >= 8000) {
        formPhase = false;
        completePhase = true;
        setFading(true);
        setTimeout(() => {
          setVisible(false);
          onComplete();
          setLoaded(true);
        }, 1500);
      }

      // Draw background with subtle vignette
      ctx.fillStyle = 'rgba(5, 5, 8, 0.22)';
      ctx.fillRect(0, 0, w, h);

      // Glow during formation
      if (formPhase) {
        const glowAlpha = Math.max(0, Math.sin(elapsed * 0.003) * 0.08 + 0.04);
        ctx.fillStyle = `rgba(6, 182, 212, ${glowAlpha})`;
        ctx.fillRect(0, 0, w, h);
      }

      // Connections — brighter during formation
      const connDist = formPhase ? 45 : 60;
      const connAlpha = formPhase ? 0.22 : 0.12;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(63, 231, 224, ${connAlpha})`;
      ctx.lineWidth = formPhase ? 0.8 : 0.5;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const p1 = particles[i], p2 = particles[j];
          const dx = p1.x - p2.x, dy = p1.y - p2.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < connDist) {
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
          }
        }
      }
      ctx.stroke();

      // Particles with glow during formation
      for (const p of particles) {
        if (p.phase === 0) {
          p.x += p.vx; p.y += p.vy;
          if (p.x < 0 || p.x > w) p.vx *= -1;
          if (p.y < 0 || p.y > h) p.vy *= -1;
        }
        const size = p.phase === 2 ? 2.2 : p.phase === 1 ? 1.8 : 2.4;
        const alpha = p.phase === 2 ? 0.9 : p.phase === 1 ? 0.7 : 0.5;

        // Glow for settled particles
        if (p.phase === 2 || p.phase === 1) {
          const glowSize = size * 3;
          const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowSize);
          glow.addColorStop(0, `rgba(6, 182, 212, ${alpha * 0.4})`);
          glow.addColorStop(1, 'rgba(6, 182, 212, 0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(p.x, p.y, glowSize, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = `rgba(125, 211, 252, ${alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // Text label beneath particles
      if (formPhase || completePhase) {
        ctx.font = `500 13px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.fillStyle = 'rgba(125, 211, 252, 0.35)';
        ctx.textAlign = 'center';
        ctx.fillText('swarmagents.codes', w / 2, h / 2 + fontSize * 0.65);
      }

      if (!completePhase) {
        animId = requestAnimationFrame(animate);
      }
    };

    animId = requestAnimationFrame(animate);

    const handleResize = () => {
      w = canvas.width = canvas.offsetWidth;
      h = canvas.height = canvas.offsetHeight;
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
    };
  }, [onComplete]);

  useEffect(() => {
    if (visible && canvasRef.current) {
      const cleanup = startAnimation();
      return cleanup;
    }
  }, [visible, startAnimation]);

  return (
    <>
      {visible && (
        <div
          className="fixed inset-0 z-[100] bg-[#050508] flex items-center justify-center transition-opacity duration-1500"
          style={{ opacity: fading ? 0 : 1, pointerEvents: fading ? 'none' : 'auto' }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
          {/* Animated logo pinned top-left during loading */}
          <div className="absolute top-4 left-5 z-10 flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/swarm-icon-fast.gif"
              alt="SwarmAgents"
              width={28}
              height={28}
              className="rounded-sm"
            />
            <span className="text-[13px] font-semibold tracking-[-0.03em] text-[#fafafa]/60 font-mono">
              swarmagents.codes
            </span>
          </div>
        </div>
      )}
      {loaded && children}
    </>
  );
}
