'use client';

import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import RoleForgeLab from '@/components/lab/RoleForgeLab';
import { Wand2, ArrowRight } from 'lucide-react';

export default function LandingRoleLab() {
  return (
    <section className="relative border-t border-[#18181b] px-5 py-20 md:py-28 overflow-hidden">
      {/* Ambient background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            radial-gradient(ellipse 60% 50% at 20% 40%, rgba(139,92,246,0.08), transparent 60%),
            radial-gradient(ellipse 50% 40% at 80% 60%, rgba(6,182,212,0.06), transparent 55%)
          `,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 cyber-grid-overlay opacity-[0.15]"
      />

      <div className="relative max-w-5xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="mb-10 md:mb-12"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-violet-500/25 bg-violet-500/10 mb-5">
            <Wand2 className="h-3.5 w-3.5 text-violet-300" />
            <span className="text-[11px] font-mono font-semibold uppercase tracking-widest text-violet-200/90">
              Role Forge Lab
            </span>
          </div>

          <h2 className="text-[clamp(1.75rem,4vw,2.75rem)] font-semibold tracking-[-0.035em] text-[#fafafa] max-w-lg leading-[1.1] mb-4">
            Describe an agent.
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-300 via-fuchsia-300 to-cyan-300">
              Get a model card.
            </span>
          </h2>

          <p className="text-[15px] text-[#71717a] max-w-xl leading-relaxed">
            Forge specialized LLM roles with prompt DNA and context specs. Plug them into workflows,
            decomposition trees, or let the orchestrator invoke them autonomously at runtime.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, delay: 0.08 }}
          className="relative rounded-2xl border border-white/[0.08] bg-[#0a0a0f]/90 backdrop-blur-sm p-4 md:p-6 shadow-[0_0_80px_-20px_rgba(139,92,246,0.2)]"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-400/40 to-transparent"
          />
          <RoleForgeLab embedded ownerId="landing-demo" ownerName="Guest" />
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.25 }}
          className="mt-8 flex justify-center"
        >
          <Link
            href="/lab"
            className="group inline-flex items-center gap-2.5 text-[13px] font-mono text-cyan-300/90 hover:text-cyan-200 border border-cyan-500/30 rounded-xl px-6 py-3 bg-cyan-950/40 hover:bg-cyan-950/60 transition shadow-[0_0_32px_-8px_rgba(6,182,212,0.35)]"
          >
            Open full Lab
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
