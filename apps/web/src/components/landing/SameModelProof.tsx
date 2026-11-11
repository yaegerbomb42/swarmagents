'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import {
  BUNDLED_LANDING_LIFT,
  type LandingLiftDemo,
} from '@/lib/landingLiftDemo';

function SideColumn({
  side,
  accent,
}: {
  side: LandingLiftDemo['chat'];
  accent: 'fail' | 'pass';
}) {
  const ok = side.passed;
  return (
    <div
      className={`rounded-2xl border p-5 md:p-6 ${
        accent === 'pass'
          ? 'border-emerald-500/25 bg-emerald-500/[0.04]'
          : 'border-white/[0.08] bg-white/[0.02]'
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-[15px] font-medium tracking-[-0.02em] text-[#fafafa]">
            {side.label}
          </p>
          <p className="text-[12px] text-[#71717a] mt-1 leading-snug">{side.subtitle}</p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${
            ok
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-red-500/10 text-red-300/90'
          }`}
        >
          {ok ? <Check size={12} strokeWidth={2.5} /> : <X size={12} strokeWidth={2.5} />}
          {ok ? 'Passed gates' : 'Failed gates'}
        </span>
      </div>
      <p className="text-[13px] text-[#a1a1aa] leading-relaxed mb-4">{side.outcome}</p>
      <div className="flex flex-wrap gap-1.5">
        {side.artifacts.slice(0, 6).map((f) => (
          <code
            key={f}
            className="text-[10px] font-mono text-[#71717a] bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5"
          >
            {f}
          </code>
        ))}
      </div>
      <p className="mt-4 text-[11px] text-[#52525b] tabular-nums">
        {(side.ms / 1000).toFixed(1)}s wall time
      </p>
    </div>
  );
}

/**
 * Landing proof: same prompt + same model — one-shot chat vs SwarmAgents.
 */
export default function SameModelProof() {
  const [demo, setDemo] = useState<LandingLiftDemo>(BUNDLED_LANDING_LIFT);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/public/lift', { cache: 'no-store' });
        const data = await res.json();
        if (!cancelled && data?.ok && data.demo) setDemo(data.demo);
      } catch {
        /* bundled fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="relative border-t border-[#18181b] px-5 py-20 md:py-28">
      <div className="max-w-5xl mx-auto">
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-[13px] font-medium text-[#71717a] tracking-[-0.01em] mb-3"
        >
          Same prompt · same model
        </motion.p>
        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.05 }}
          className="text-[clamp(1.75rem,4vw,2.5rem)] font-semibold tracking-[-0.035em] text-[#fafafa] max-w-2xl leading-tight mb-3"
        >
          What ChatGPT-style one-shot gets wrong — and SwarmAgents ships.
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.1 }}
          className="text-[14px] text-[#71717a] max-w-xl leading-relaxed mb-8"
        >
          Not a different model. The framework: agents, verification gates, and repair. Measured on{' '}
          <span className="text-[#a1a1aa] font-mono text-[13px]">{demo.model}</span>.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.12 }}
          className="mb-8 hologram-border-wrap rounded-2xl"
        >
          <div className="hologram-border-inner rounded-2xl border border-white/[0.06] p-4 md:p-5 phosphor-screen">
            <p className="text-[10px] font-mono uppercase tracking-wider text-[#52525b] mb-2">
              Prompt
            </p>
            <pre className="text-[12px] md:text-[13px] text-[#a1a1aa] leading-relaxed whitespace-pre-wrap font-sans">
              {demo.prompt}
            </pre>
          </div>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-4 md:gap-5 mb-6">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.15 }}
          >
            <SideColumn side={demo.chat} accent="fail" />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.22 }}
          >
            <SideColumn side={demo.swarm} accent="pass" />
          </motion.div>
        </div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="text-[13px] text-[#a1a1aa] font-medium tracking-[-0.01em] mb-2"
        >
          {demo.liftPercentagePoints > 0
            ? `+${demo.liftPercentagePoints}pp lift on this fixture`
            : demo.headline}
        </motion.p>
        <p className="text-[11px] text-[#52525b] leading-relaxed max-w-2xl">
          {demo.methodNote}
        </p>
      </div>
    </section>
  );
}
