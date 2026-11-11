'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

// ════════════════════════════════════════════════════════════
//  AsciiArt — Convert any image to text-art via canvas
//  Inspired by Aceternity AsciiArt component
// ════════════════════════════════════════════════════════════

const CHAR_RAMP_DENSE = '@%#*+=-:. ';
const CHAR_RAMP_SPARSE = '@#=-. ';

export interface AsciiArtProps {
  src: string;
  resolution?: number;
  color?: string;
  animationStyle?: 'fade' | 'typewriter' | 'none';
  animationDuration?: number;
  animateOnView?: boolean;
  ramp?: 'dense' | 'sparse';
  className?: string;
}

function imageToAscii(img: HTMLImageElement, resolution: number, ramp: string): string[] {
  const canvas = document.createElement('canvas');
  const ratio = img.height / img.width;
  // ASCII chars are ~2x taller than wide — compensate
  const charAspect = 0.5;
  const width = resolution;
  const height = Math.max(1, Math.round(resolution * ratio * charAspect));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, width, height);

  const lines: string[] = [];
  for (let y = 0; y < height; y++) {
    const data = ctx.getImageData(0, y, width, 1).data;
    let row = '';
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) * (a / 255);
      const idx = Math.min(ramp.length - 1, Math.floor((lum / 255) * (ramp.length - 1)));
      row += ramp[ramp.length - 1 - idx];
    }
    lines.push(row);
  }
  return lines;
}

export function AsciiArt({
  src,
  resolution = 100,
  color = 'currentColor',
  animationStyle = 'fade',
  animationDuration = 1.5,
  animateOnView = false,
  ramp = 'dense',
  className = '',
}: AsciiArtProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(0);
  const [visible, setVisible] = useState(!animateOnView);
  const ref = useRef<HTMLPreElement | null>(null);

  // Convert image when src/resolution changes
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    img.onload = () => {
      try {
        const rampStr = ramp === 'dense' ? CHAR_RAMP_DENSE : CHAR_RAMP_SPARSE;
        setLines(imageToAscii(img, resolution, rampStr));
      } catch (e) {
        console.warn('[AsciiArt] failed to render', e);
      }
    };
    img.onerror = () => console.warn('[AsciiArt] failed to load', src);
  }, [src, resolution, ramp]);

  // Intersection observer for animateOnView
  useEffect(() => {
    if (!animateOnView || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [animateOnView]);

  // Typewriter reveal
  useEffect(() => {
    if (animationStyle !== 'typewriter' || !visible || lines.length === 0) return;
    setRevealed(0);
    const stepMs = (animationDuration * 1000) / lines.length;
    const iv = setInterval(() => {
      setRevealed((r) => {
        if (r >= lines.length) {
          clearInterval(iv);
          return r;
        }
        return r + 1;
      });
    }, Math.max(stepMs, 8));
    return () => clearInterval(iv);
  }, [animationStyle, visible, lines, animationDuration]);

  if (animationStyle === 'typewriter') {
    return (
      <pre
        ref={ref}
        className={`font-mono leading-[1] text-[6px] sm:text-[7px] md:text-[8px] whitespace-pre overflow-hidden ${className}`}
        style={{ color }}
      >
        {visible ? lines.slice(0, revealed).join('\n') : ''}
      </pre>
    );
  }

  if (animationStyle === 'fade') {
    return (
      <motion.pre
        ref={ref as any}
        initial={{ opacity: 0 }}
        animate={visible ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: animationDuration, ease: 'easeInOut' }}
        className={`font-mono leading-[1] text-[6px] sm:text-[7px] md:text-[8px] whitespace-pre overflow-hidden ${className}`}
        style={{ color }}
      >
        {lines.join('\n')}
      </motion.pre>
    );
  }

  return (
    <pre
      ref={ref}
      className={`font-mono leading-[1] text-[6px] sm:text-[7px] md:text-[8px] whitespace-pre overflow-hidden ${className}`}
      style={{ color }}
    >
      {lines.join('\n')}
    </pre>
  );
}

export default AsciiArt;
