import Link from 'next/link';
import { Mail, Clock, ShieldCheck, ArrowLeft, MessageSquare, Globe } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';

export const metadata = {
  title: 'Contact Us — SwarmAgents',
  description: 'Get in touch with the SwarmAgents team. Official contact and support email: support@swarmagents.codes.',
};

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-[#09090b] text-[#fafafa] flex flex-col justify-between">
      <SiteHeader subtitle="Contact Us" />

      <main className="max-w-4xl mx-auto px-5 py-16 md:py-24 w-full">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-xs font-mono text-[#a1a1aa] hover:text-[#fafafa] transition-colors mb-8"
        >
          <ArrowLeft size={14} />
          Back to Home
        </Link>

        <div className="space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-950/40 text-cyan-300 text-xs font-mono">
            Official Support & Inquiries
          </div>

          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-[#fafafa]">
            Contact Us
          </h1>
          <p className="text-lg text-[#a1a1aa] max-w-2xl leading-relaxed">
            Have questions about SwarmAgents, custom enterprise deployments, API limits, or account support? Reach out directly to our team via our official domain email.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-8">
            {/* Primary Email Card */}
            <div className="p-6 rounded-2xl bg-[#121215] border border-[#27272a] hover:border-cyan-500/50 transition-all shadow-lg flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2.5 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                    <Mail size={22} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-[#fafafa]">Official Domain Email</h3>
                    <span className="text-xs text-[#71717a]">Primary Contact Channel</span>
                  </div>
                </div>
                <p className="text-sm text-[#a1a1aa] leading-relaxed mb-4">
                  For general inquiries, account assistance, security disclosures, and platform technical support:
                </p>
                <div className="p-3 rounded-lg bg-[#09090b] border border-[#27272a] font-mono text-cyan-300 text-sm break-all font-semibold selection:bg-cyan-500/30">
                  support@swarmagents.codes
                </div>
              </div>
              <div className="pt-6">
                <a
                  href="mailto:support@swarmagents.codes"
                  className="inline-flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-sm font-medium border border-cyan-500/30 transition-all"
                >
                  <Mail size={16} />
                  Send Email to support@swarmagents.codes
                </a>
              </div>
            </div>

            {/* Support SLA & Info Card */}
            <div className="p-6 rounded-2xl bg-[#121215] border border-[#27272a] flex flex-col justify-between space-y-6">
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <Clock className="text-cyan-400 mt-1 shrink-0" size={18} />
                  <div>
                    <h4 className="text-sm font-semibold text-[#fafafa]">Response SLA</h4>
                    <p className="text-xs text-[#71717a] mt-0.5">
                      Our engineering team monitors emails 24/7. We typically respond within 1–4 business hours.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <ShieldCheck className="text-cyan-400 mt-1 shrink-0" size={18} />
                  <div>
                    <h4 className="text-sm font-semibold text-[#fafafa]">Security & Bug Reports</h4>
                    <p className="text-xs text-[#71717a] mt-0.5">
                      Security vulnerability reports are prioritized immediately. Email support@swarmagents.codes with details.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <Globe className="text-cyan-400 mt-1 shrink-0" size={18} />
                  <div>
                    <h4 className="text-sm font-semibold text-[#fafafa]">Domain Verification</h4>
                    <p className="text-xs text-[#71717a] mt-0.5">
                      Official communications will only ever be sent from @swarmagents.codes addresses.
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-[#09090b] border border-[#27272a] text-xs text-[#71717a] flex items-center gap-2">
                <MessageSquare size={16} className="text-cyan-400 shrink-0" />
                <span>Need immediate console help? Visit the Decomp workbench in your dashboard.</span>
              </div>
            </div>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
