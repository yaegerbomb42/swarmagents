'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';

export interface ScanRevealProps {
  children: ReactNode;
  className?: string;
  delay?: number;
}

export default function ScanReveal({ children, className = '', delay = 0 }: ScanRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: '-40px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <motion.div
      ref={ref}
      className={`hyper-scan-reveal ${visible ? 'hyper-scan-reveal--visible' : ''} ${className}`}
      initial={{ opacity: 0, y: 20 }}
      animate={visible ? { opacity: 1, y: 0 } : {}}
      transition={{ delay, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
    >
      {visible ? <span className="hyper-scan-reveal__beam" aria-hidden /> : null}
      {children}
    </motion.div>
  );
}
