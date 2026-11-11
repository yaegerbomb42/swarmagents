'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Clock, GitBranch, MessageSquare, Sliders, Terminal, Layers } from 'lucide-react';
import MagneticTilt from '@/components/ui/MagneticTilt';

const fadeIn = (delay: number) => ({
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-40px' },
  transition: { delay, duration: 0.6, ease: [0.21, 0.47, 0.32, 0.98] },
});

const MOATS = [
  {
    icon: Clock,
    title: 'Time-budget fit',
    desc: 'Decomposition scales to your wall-clock. A 1-hour mission becomes a dense tree of 1–3 minute leaves — not a shallow checklist.',
  },
  {
    icon: GitBranch,
    title: 'Auto-deepen for small models',
    desc: 'Oversized nodes split until every leaf fits a local / small LLM worker. More micro-tasks, less hallucination.',
  },
  {
    icon: MessageSquare,
    title: 'Live steering',
    desc: 'Pause, prefer, avoid, re-decompose, or inject leaves while the swarm runs — with applied vs queued honesty.',
  },
  {
    icon: Sliders,
    title: 'Role → model & quota',
    desc: 'Route architect, coding, research, validation, and browser work to different providers with RPM and daily $ caps.',
  },
  {
    icon: Terminal,
    title: 'Sandbox visibility',
    desc: 'Watch agents in shell or browser tiles under the neon DAG — tool calls and viewports as they work.',
  },
  {
    icon: Layers,
    title: 'Rich executable leaves',
    desc: 'Acceptance criteria, tools, dependencies, and deliverable paths on every leaf — not vague labels.',
  },
];

export default function TechnicalMoat() {
  return (
    <section className="w-full max-w-5xl mx-auto py-24 px-6 relative">
      <div className="text-center mb-14">
        <motion.p
          {...fadeIn(0)}
          className="text-[10px] font-mono uppercase tracking-[0.25em] text-cyan-400/70 mb-3"
        >
          Why it ships
        </motion.p>
        <motion.h2
          {...fadeIn(0.05)}
          className="text-3xl md:text-5xl font-bold mb-4 tracking-tight"
        >
          Built for <span className="text-cyan-300">budgeted swarms</span>
        </motion.h2>
        <motion.p {...fadeIn(0.1)} className="text-white/40 max-w-2xl mx-auto text-base md:text-lg">
          The product is a time-aware decomposition engine with live control — not a chat wrapper.
        </motion.p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {MOATS.map((item, i) => (
          <MagneticTilt key={item.title} intensity={5} className="rounded-xl h-full">
          <motion.div
            {...fadeIn(0.12 + i * 0.05)}
            className="tactile-panel holo-card hyper-panel group relative p-6 border border-cyan-500/10 bg-[#040408]/60 rounded-xl h-full"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center transition-all duration-150 group-hover:border-cyan-400/45 group-hover:shadow-[0_0_16px_rgba(0,245,255,0.25)] group-hover:scale-105">
                <item.icon className="w-4 h-4 text-cyan-400" />
              </div>
              <h3 className="text-lg font-semibold text-white/90 transition-colors group-hover:text-white">{item.title}</h3>
            </div>
            <p className="text-sm text-white/45 leading-relaxed">{item.desc}</p>
          </motion.div>
          </MagneticTilt>
        ))}
      </div>
    </section>
  );
}
