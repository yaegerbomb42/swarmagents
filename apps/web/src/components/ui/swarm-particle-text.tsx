'use client';

import { useEffect, useRef, useCallback } from 'react';

interface SwarmParticleTextProps {
  text?: string;
  className?: string;
  fontSize?: number;
  gap?: number;
  reassignInterval?: number;
  reassignBatch?: number;
}

class Vec2 {
  constructor(public x: number, public y: number) {}
  add(v: Vec2) { this.x += v.x; this.y += v.y; return this; }
  sub(v: Vec2) { return new Vec2(this.x - v.x, this.y - v.y); }
  mult(n: number) { this.x *= n; this.y *= n; return this; }
  mag() { return Math.sqrt(this.x * this.x + this.y * this.y); }
  normalize() { const m = this.mag(); if (m > 0) { this.x /= m; this.y /= m; } return this; }
  limit(max: number) { if (this.mag() > max) { this.normalize(); this.mult(max); } return this; }
  clone() { return new Vec2(this.x, this.y); }
}

class SwarmDot {
  pos: Vec2;
  target: Vec2;
  vel: Vec2;
  size: number;
  settled = false;

  constructor(startX: number, startY: number, targetX: number, targetY: number) {
    this.pos = new Vec2(startX, startY);
    this.target = new Vec2(targetX, targetY);
    this.vel = new Vec2(0, 0);
    this.size = Math.random() * 1.2 + 0.6;
  }

  update() {
    const desired = this.target.clone().sub(this.pos);
    const dist = desired.mag();

    if (dist < 0.5) {
      this.settled = true;
      this.vel.mult(0);
      return;
    }

    this.settled = false;
    let speed = 6;
    if (dist < 60) speed = (dist / 60) * 6;
    desired.normalize().mult(speed);
    const steer = desired.sub(this.vel);
    steer.limit(0.25);
    this.vel.add(steer);
    this.vel.mult(0.94);
    this.pos.add(this.vel);
  }

  draw(ctx: CanvasRenderingContext2D) {
    const speed = this.vel.mag();
    const alpha = this.settled ? 0.6 : Math.min(speed / 3 + 0.4, 1);
    const hue = this.settled ? 195 : 185 + speed * 8;
    ctx.fillStyle = `hsla(${hue}, 75%, 70%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(this.pos.x, this.pos.y, this.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

export default function SwarmParticleText({
  text = 'SWARMAGENTS',
  className = '',
  fontSize,
  gap = 4,
  reassignInterval = 2500,
  reassignBatch = 40,
}: SwarmParticleTextProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<SwarmDot[]>([]);
  const targetsRef = useRef<{ x: number; y: number }[]>([]);
  const animRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const initText = useCallback((canvas: HTMLCanvasElement) => {
    const offCanvas = document.createElement('canvas');
    const offCtx = offCanvas.getContext('2d');
    if (!offCtx) return;
    offCanvas.width = canvas.width;
    offCanvas.height = canvas.height;

    const fSize = fontSize ?? Math.min(canvas.width / 7, 120);
    offCtx.font = `900 ${fSize}px "Inter", system-ui, sans-serif`;
    offCtx.fillStyle = 'white';
    offCtx.textAlign = 'center';
    offCtx.textBaseline = 'middle';
    offCtx.fillText(text, canvas.width / 2, canvas.height / 2);

    const data = offCtx.getImageData(0, 0, canvas.width, canvas.height).data;
    const targets: { x: number; y: number }[] = [];

    for (let y = 0; y < canvas.height; y += gap) {
      for (let x = 0; x < canvas.width; x += gap) {
        const alpha = data[(y * canvas.width + x) * 4 + 3];
        if (alpha > 128) targets.push({ x, y });
      }
    }

    targetsRef.current = targets;

    const existing = dotsRef.current;
    const diff = targets.length - existing.length;
    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        const t = targets[existing.length + i];
        existing.push(new SwarmDot(
          Math.random() * canvas.width,
          Math.random() * canvas.height,
          t.x, t.y
        ));
      }
    } else if (diff < 0) {
      existing.splice(targets.length);
    }
    existing.forEach((dot, i) => {
      if (targets[i]) {
        dot.target = new Vec2(targets[i].x, targets[i].y);
      }
    });
  }, [text, fontSize, gap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      initText(canvas);
    };
    resize();
    window.addEventListener('resize', resize);

    const loop = () => {
      ctx.fillStyle = 'rgba(5, 5, 8, 0.18)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const dot of dotsRef.current) {
        dot.update();
        dot.draw(ctx);
      }

      animRef.current = requestAnimationFrame(loop);
    };
    loop();

    // Autonomous reassignment: periodically swap some dots to new target positions
    timerRef.current = setInterval(() => {
      const dots = dotsRef.current;
      const targets = targetsRef.current;
      if (dots.length === 0 || targets.length === 0) return;

      const count = Math.min(reassignBatch, dots.length);
      const indices: number[] = [];
      while (indices.length < count) {
        const idx = Math.floor(Math.random() * dots.length);
        if (!indices.includes(idx)) indices.push(idx);
      }

      // Shuffle their targets among themselves
      const shuffledTargets = indices.map(i => targets[i] || targets[0]);
      for (let i = shuffledTargets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledTargets[i], shuffledTargets[j]] = [shuffledTargets[j], shuffledTargets[i]];
      }
      indices.forEach((dotIdx, i) => {
        const t = shuffledTargets[i];
        dots[dotIdx].target = new Vec2(t.x, t.y);
        dots[dotIdx].settled = false;
      });
    }, reassignInterval);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [initText, reassignInterval, reassignBatch]);

  return (
    <canvas
      ref={canvasRef}
      className={`w-full h-full ${className}`}
      style={{ background: 'transparent' }}
    />
  );
}
