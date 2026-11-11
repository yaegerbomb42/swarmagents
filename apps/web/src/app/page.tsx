'use client';

import Link from 'next/link';
import Image from 'next/image';
import { motion } from 'framer-motion';
import SameModelProof from '@/components/landing/SameModelProof';
import TechnicalMoat from '@/components/landing/TechnicalMoat';
import SwarmIntro from '@/components/landing/SwarmIntro';
import LandingAuthCtas from '@/components/landing/LandingAuthCtas';
import LandingMissionLauncher from '@/components/landing/LandingMissionLauncher';
import LandingAmbientField from '@/components/landing/LandingAmbientField';
import SwarmTelemetryMarquee from '@/components/landing/SwarmTelemetryMarquee';
import { HoloShimmerText } from '@/components/ui/holo-shimmer-text';
import HyperAmbient from '@/components/ui/HyperAmbient';
import HolographicBadge from '@/components/ui/HolographicBadge';
import { Backlight } from '@/components/ui/backlight';
import ScanReveal from '@/components/ui/scan-reveal';
import NeonSectionDivider from '@/components/ui/NeonSectionDivider';
import MagneticTilt from '@/components/ui/MagneticTilt';
import LiveSystemClock from '@/components/ui/LiveSystemClock';
import DataStreamTicker from '@/components/ui/DataStreamTicker';
import LandingRoleLab from '@/components/landing/LandingRoleLab';

export default function LandingPage() {
  return (
    <div className="landing-root relative min-h-[100svh] bg-[#09090b] text-[#fafafa] overflow-x-hidden landing-noise">
      <SwarmIntro />
      <HyperAmbient />
      <LandingAmbientField />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            radial-gradient(ellipse 90% 60% at 50% -20%, rgba(255,255,255,0.07), transparent 55%),
            radial-gradient(ellipse 50% 40% at 80% 60%, rgba(120,140,160,0.06), transparent 50%),
            linear-gradient(180deg, #09090b 0%, #0c0c0e 50%, #09090b 100%)
          `,
        }}
      />

      <header className="hyper-header-shimmer relative z-30 flex items-center justify-between px-5 md:px-8 py-4 max-w-6xl mx-auto w-full">
        <Link href="/" className="flex items-center gap-2 group">
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <Image
              src="/brand/swarm-icon-fast.gif"
              alt="SwarmAgents logo"
              width={28}
              height={28}
              className="rounded-sm"
              unoptimized
            />
          </motion.div>
          <span className="text-[15px] font-semibold tracking-[-0.03em] text-[#fafafa] font-mono">
            swarmagents.codes
          </span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          <LandingAuthCtas />
        </nav>
      </header>

      <SwarmTelemetryMarquee />

      <DataStreamTicker className="relative z-20" />

      <main className="relative z-10">
        <section className="relative flex flex-col items-center px-5 pt-16 md:pt-24 pb-20 md:pb-28 min-h-[calc(100svh-4.5rem)] text-center overflow-hidden">
          <div className="pointer-events-none absolute inset-0 cyber-grid-overlay opacity-40" aria-hidden />
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="mb-8 animate-float-y"
          >
            <HolographicBadge label="swarmagents.codes" variant="cyan" />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="max-w-4xl mb-6"
          >
            <HoloShimmerText
              as="h1"
              className="text-[clamp(2.5rem,7vw,4.75rem)] font-extrabold tracking-[-0.04em] leading-[1.08] drop-shadow-sm"
            >
              swarmagents.codes
            </HoloShimmerText>
          </motion.div>

          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="text-[clamp(1.1rem,2.5vw,1.5rem)] font-normal tracking-[-0.02em] text-[#a1a1aa] max-w-2xl leading-snug mb-5"
          >
            A company of autonomous agents on your models.
          </motion.p>

          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.65 }}
            className="text-[15px] md:text-base text-[#71717a] max-w-lg leading-relaxed mb-10 font-normal"
          >
            Decompose complex goals into parallel execution chains, optimize leverage, and ship software through a shared workspace — like Cursor for an entire engineering org.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.65 }}
            className="w-full"
          >
            <LandingAuthCtas variant="hero" />
            <Backlight intensity={0.65} blur={48} className="mt-2">
              <LandingMissionLauncher />
            </Backlight>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.55 }}
              className="mt-4"
            >
              <Link
                href="/command"
                className="hyper-magnetic inline-flex items-center gap-2 text-[13px] font-mono text-cyan-400/90 hover:text-cyan-300 border border-cyan-500/25 rounded-lg px-4 py-2 bg-cyan-950/30 transition shadow-[0_0_24px_-8px_rgba(6,182,212,0.35)]"
              >
                Open Mission Command Center →
              </Link>
            </motion.div>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7, duration: 0.8 }}
            className="mt-auto pt-16 text-[12px] text-[#52525b] tracking-[-0.01em]"
          >
            Runs on your providers · Pure seat spawner · Shared blackboard
          </motion.p>

          <div className="absolute bottom-0 left-0 right-0 h-32 cyber-scanner-floor pointer-events-none opacity-40" aria-hidden>
            <div className="scanner-grid absolute inset-0" />
          </div>
        </section>

        <NeonSectionDivider className="my-4 px-5" />

        <SameModelProof />
        <NeonSectionDivider className="my-4 px-5" />
        <TechnicalMoat />
        <LandingRoleLab />

        <section className="relative border-t border-[#18181b] px-5 py-20 md:py-28">
          <div className="neon-divider relative max-w-5xl mx-auto mb-14 h-px" aria-hidden>
            <div className="neon-divider__beam absolute inset-0 h-px" />
            <div className="neon-divider__glow absolute left-1/2 -translate-x-1/2 -top-2 w-32 h-4" />
          </div>
          <div className="max-w-5xl mx-auto">
            <p className="text-[13px] font-medium text-[#71717a] tracking-[-0.01em] mb-3">
              Why it feels different
            </p>
            <h2 className="text-[clamp(1.75rem,4vw,2.5rem)] font-semibold tracking-[-0.035em] text-[#fafafa] max-w-lg leading-tight mb-14">
              Built for thousand-step work, not one-shot chat.
            </h2>
            <div className="grid md:grid-cols-3 gap-10 md:gap-12">
              {[
                {
                  title: 'Decompose anything',
                  body: 'Time-scaled trees that deepen until the work is leaf-sized — then keep going.',
                },
                {
                  title: 'Spawn a real team',
                  body: 'Dynamic seats invent their own roles, own paths, and work concurrently like a company.',
                },
                {
                  title: 'Share one workspace',
                  body: 'Blackboard, heatmap, and context keep every agent oriented without you babysitting.',
                },
              ].map((item, i) => (
                <MagneticTilt key={item.title} intensity={8} className="rounded-xl">
                  <ScanReveal delay={i * 0.08}>
                    <motion.div
                      className="holo-card hyper-panel rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 md:border-l-0 md:pl-5 h-full"
                    >
                      <div className="flex items-center gap-2 mb-3">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 pulse-ring shadow-[0_0_8px_rgba(34,211,238,0.6)]" />
                        <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-500/60">
                          0{i + 1}
                        </span>
                      </div>
                      <h3 className="text-[17px] font-medium tracking-[-0.02em] text-[#fafafa] mb-2">
                        {item.title}
                      </h3>
                      <p className="text-[14px] leading-relaxed text-[#71717a]">{item.body}</p>
                    </motion.div>
                  </ScanReveal>
                </MagneticTilt>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-[#18181b] px-5 py-8">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4">
            <span className="text-[13px] font-mono font-semibold tracking-tight text-[#a1a1aa]">swarmagents.codes</span>
            <LiveSystemClock />
          </div>
          <div className="flex items-center gap-5 text-[13px] text-[#52525b]">
            <Link href="/login" className="hover:text-[#a1a1aa] transition-colors">
              Sign in
            </Link>
            <Link href="/decomp" className="hover:text-[#a1a1aa] transition-colors">
              Console
            </Link>
            <span>swarmagents.codes</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
