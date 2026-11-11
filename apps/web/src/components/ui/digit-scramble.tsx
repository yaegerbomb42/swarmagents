'use client';

import { useEffect, useRef, useState } from 'react';

const CHARSET = '0123456789ABCDEF▪░▒';

export type DigitScrambleProps = {
  value: string | number;
  className?: string;
  duration?: number;
};

export default function DigitScramble({
  value,
  className = '',
  duration = 420,
}: DigitScrambleProps) {
  const target = String(value);
  const [display, setDisplay] = useState(target);
  const prevRef = useRef(target);

  useEffect(() => {
    if (prevRef.current === target) return;
    prevRef.current = target;

    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setDisplay(target);
      return;
    }

    const start = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      const reveal = Math.floor(ease * target.length);

      let out = '';
      for (let i = 0; i < target.length; i++) {
        if (i < reveal) out += target[i];
        else if (target[i] === ' ') out += ' ';
        else out += CHARSET[Math.floor(Math.random() * CHARSET.length)];
      }
      setDisplay(out);

      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(target);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return (
    <span className={`tabular-nums font-mono ${className}`} aria-label={target}>
      {display}
    </span>
  );
}
