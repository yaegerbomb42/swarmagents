import Link from 'next/link';
import { ArrowLeft, Shield, Mail, Lock, Database } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';

export const metadata = {
  title: 'Privacy Policy — SwarmAgents',
  description: 'Privacy Policy for SwarmAgents platform. Official contact email: support@swarmagents.codes.',
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#09090b] text-[#fafafa] flex flex-col justify-between">
      <SiteHeader subtitle="Privacy Policy" />

      <main className="max-w-4xl mx-auto px-5 py-16 md:py-24 w-full">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-xs font-mono text-[#a1a1aa] hover:text-[#fafafa] transition-colors mb-8"
        >
          <ArrowLeft size={14} />
          Back to Home
        </Link>

        <article className="prose prose-invert max-w-none space-y-8">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-950/40 text-cyan-300 text-xs font-mono mb-4">
              Last Updated: July 2026
            </div>
            <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-[#fafafa]">
              Privacy Policy
            </h1>
            <p className="text-base text-[#a1a1aa] leading-relaxed mt-4">
              At SwarmAgents (<code className="text-cyan-300">swarmagents.codes</code>), we treat data privacy and local model sovereignty as core foundational principles. This policy explains what information we collect, how it is handled, and how your privacy is protected.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-[#121215] border border-[#27272a] text-sm text-[#a1a1aa] flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Mail className="text-cyan-400 shrink-0" size={20} />
              <span>For privacy requests, data deletion, or questions:</span>
            </div>
            <a
              href="mailto:support@swarmagents.codes"
              className="font-mono text-cyan-300 hover:underline shrink-0"
            >
              support@swarmagents.codes
            </a>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
            <div className="p-4 rounded-xl bg-[#121215] border border-[#27272a]">
              <Lock className="text-cyan-400 mb-2" size={20} />
              <h3 className="font-semibold text-sm text-[#fafafa] mb-1">Zero Secrets Storage</h3>
              <p className="text-xs text-[#71717a]">
                API keys are never stored unencrypted. Local runtime endpoints stay within your self-hosted infrastructure.
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#121215] border border-[#27272a]">
              <Database className="text-cyan-400 mb-2" size={20} />
              <h3 className="font-semibold text-sm text-[#fafafa] mb-1">No Model Training</h3>
              <p className="text-xs text-[#71717a]">
                We never train AI models on your proprietary prompt inputs, code context, or multi-agent workspace logs.
              </p>
            </div>
            <div className="p-4 rounded-xl bg-[#121215] border border-[#27272a]">
              <Shield className="text-cyan-400 mb-2" size={20} />
              <h3 className="font-semibold text-sm text-[#fafafa] mb-1">Admin Isolation</h3>
              <p className="text-xs text-[#71717a]">
                High-tier reasoning endpoints run in isolated environments with strict authentication protocols.
              </p>
            </div>
          </div>

          <section className="space-y-4 pt-4">
            <h2 className="text-xl font-bold text-[#fafafa]">1. Information We Collect</h2>
            <p className="text-sm text-[#a1a1aa] leading-relaxed">
              We collect minimal account information required for service operation: your account email address, authentication credentials, telemetry performance metrics, and model routing parameters.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-xl font-bold text-[#fafafa]">2. Data Usage & Agent Communication</h2>
            <p className="text-sm text-[#a1a1aa] leading-relaxed">
              Workspace data, agent messages, and task decomposition trees are transmitted strictly to fulfill execution requests across configured model endpoints. Your code remains your property.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-xl font-bold text-[#fafafa]">3. Contacting Privacy Support</h2>
            <p className="text-sm text-[#a1a1aa] leading-relaxed">
              To request account deletion, export your data, or submit privacy inquiries, use{" "}
              <Link href="/data-deletion" className="text-cyan-300 hover:underline">
                swarmagents.codes/data-deletion
              </Link>{" "}
              or email:
            </p>
            <div className="p-3 rounded-lg bg-[#121215] border border-[#27272a] font-mono text-cyan-300 text-sm inline-block">
              support@swarmagents.codes
            </div>
          </section>
        </article>
      </main>

      <SiteFooter />
    </div>
  );
}
