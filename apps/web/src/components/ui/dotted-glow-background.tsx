'use client';

import React, { useEffect, useRef } from 'react';

// ════════════════════════════════════════════════════════════
//  DottedGlowBackground — Animated dotted pattern w/ random glows
//  Pure canvas, no deps
// ════════════════════════════════════════════════════════════

export interface DottedGlowBackgroundProps {
  className?: string;
  opacity?: number;
  gap?: number;
  radius?: number;
  colorLightVar?: string;
  glowColorLightVar?: string;
  colorDarkVar?: string;
  glowColorDarkVar?: string;
  backgroundOpacity?: number;
  speedMin?: number;
  speedMax?: number;
  speedScale?: number;
}

export function DottedGlowBackground({
  className = '',
  opacity = 1,
  gap = 10,
  radius = 1.6,
  colorLightVar = '--color-neutral-500',
  glowColorLightVar = '--color-neutral-600',
  colorDarkVar = '--color-neutral-500',
  glowColorDarkVar = '--color-sky-800',
  backgroundOpacity = 0,
  speedMin = 0.3,
  speedMax = 1.6,
  speedScale = 1,
}: DottedGlowBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const dotsRef = useRef<Array<{ x: number; y: number; phase: number; speed: number }>>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resolveColor = (varName: string, fallback: string): string => {
      try {
        const trimmed = varName.startsWith('--') ? varName : `--${varName}`;
        const val = getComputedStyle(document.documentElement).getPropertyValue(trimmed).trim();
        return val || fallback;
      } catch {
        return fallback;
      }
    };

    const isDark =
      typeof window !== 'undefined' &&
      document.documentElement.classList.contains('dark');

    const dotColor = resolveColor(isDark ? colorDarkVar : colorLightVar, '#6b7280');
    const glowColor = resolveColor(isDark ? glowColorDarkVar : glowColorLightVar, '#0369a1');

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const cols = Math.ceil(rect.width / gap);
      const rows = Math.ceil(rect.height / gap);
      const dots: Array<{ x: number; y: number; phase: number; speed: number }> = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          dots.push({
            x: c * gap + gap / 2,
            y: r * gap + gap / 2,
            phase: Math.random() * Math.PI * 2,
            speed: (speedMin + Math.random() * (speedMax - speedMin)) * speedScale,
          });
        }
      }
      dotsRef.current = dots;
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let last = performance.now();
    const render = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      const rect = canvas.getBoundingClientRect();

      ctx.clearRect(0, 0, rect.width, rect.height);
      if (backgroundOpacity > 0) {
        ctx.fillStyle = `rgba(0,0,0,${backgroundOpacity})`;
        ctx.fillRect(0, 0, rect.width, rect.height);
      }

      const dots = dotsRef.current;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        d.phase += dt * d.speed;
        const intensity = (Math.sin(d.phase) + 1) / 2; // 0..1
        const alpha = opacity * (0.3 + intensity * 0.7);
        ctx.beginPath();
        ctx.arc(d.x, d.y, radius * (0.7 + intensity * 0.6), 0, Math.PI * 2);
        if (intensity > 0.7) {
          ctx.fillStyle = glowColor;
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = 8 * intensity;
        } else {
          ctx.fillStyle = dotColor;
          ctx.shadowBlur = 0;
        }
        ctx.globalAlpha = alpha;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      animationRef.current = requestAnimationFrame(render);
    };
    animationRef.current = requestAnimationFrame(render);

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      ro.disconnect();
    };
  }, [opacity, gap, radius, colorLightVar, glowColorLightVar, colorDarkVar, glowColorDarkVar, backgroundOpacity, speedMin, speedMax, speedScale]);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full ${className}`}
      style={{ pointerEvents: 'none' }}
    />
  );
}

export default DottedGlowBackground;
