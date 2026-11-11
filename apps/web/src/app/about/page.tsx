import Link from 'next/link';
import { ArrowLeft, Cpu, Layers, Zap, Mail, ArrowRight } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';

export const metadata = {
  title: 'About Us — SwarmAgents',
  description: 'Learn about SwarmAgents autonomous multi-agent orchestration substrate. Contact: support@swarmagents.codes.',
};

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-[#09090b] text-[#fafafa] flex flex-col justify-between">
      <SiteHeader subtitle="About Us" />

      <main className="max-w-4xl mx-auto px-5 py-16 md:py-24 w-full">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-xs font-mono text-[#a1a1aa] hover:text-[#fafafa] transition-colors mb-8"
        >
          <ArrowLeft size={14} />
          Back to Home
        </Link>

        <div className="space-y-10">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-950/40 text-cyan-300 text-xs font-mono mb-4">
              Autonomous Agent Substrate
            </div>
            <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-[#fafafa]">
              About SwarmAgents
            </h1>
            <p className="text-lg text-[#a1a1aa] leading-relaxed mt-4">
              SwarmAgents is designed to turn complex software goals into parallel, self-organizing agent trees — operating like Cursor for an entire engineering organization.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 rounded-2xl bg-[#121215] border border-[#27272a] space-y-3">
              <div className="p-2.5 w-fit rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                <Layers size={20} />
              </div>
              <h3 className="font-semibold text-[#fafafa]">Task Decomposition</h3>
              <p className="text-xs text-[#71717a] leading-relaxed">
                Breaks high-level goals into leaf-sized work units and executes them concurrently using optimized agents.
              </p>
            </div>

            <div className="p-6 rounded-2xl bg-[#121215] border border-[#27272a] space-y-3">
              <div className="p-2.5 w-fit rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                <Cpu size={20} />
              </div>
              <h3 className="font-semibold text-[#fafafa]">Multi-Tier LLM Routing</h3>
              <p className="text-xs text-[#71717a] leading-relaxed">
                Pairs high-tier reasoning engines with fast local worker models (Ollama, MLX, Modal) for maximum leverage.
              </p>
            </div>

            <div className="p-6 rounded-2xl bg-[#121215] border border-[#27272a] space-y-3">
              <div className="p-2.5 w-fit rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                <Zap size={20} />
              </div>
              <h3 className="font-semibold text-[#fafafa]">Shared Blackboard</h3>
              <p className="text-xs text-[#71717a] leading-relaxed">
                Maintains global state, execution history, and heatmaps so every agent stays oriented without human babysitting.
              </p>
            </div>
          </div>

          <div className="p-8 rounded-2xl bg-gradient-to-b from-[#121215] to-[#09090b] border border-[#27272a] space-y-6">
            <h2 className="text-2xl font-bold text-[#fafafa]">Get in Touch</h2>
            <p className="text-sm text-[#a1a1aa] leading-relaxed max-w-2xl">
              We are constantly evolving the substrate and building partnerships with engineering teams and AI researchers. Reach out to our official domain email for inquiries, feedback, or custom integrations:
            </p>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 pt-2">
              <a
                href="mailto:support@swarmagents.codes"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-sm font-mono border border-cyan-500/30 transition-all"
              >
                <Mail size={16} />
                support@swarmagents.codes
              </a>
              <Link
                href="/contact"
                className="inline-flex items-center gap-1.5 text-xs text-[#a1a1aa] hover:text-[#fafafa] transition-colors"
              >
                <span>Visit Contact Page</span>
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
