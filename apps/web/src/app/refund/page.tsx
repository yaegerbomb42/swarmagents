import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Refund Policy — SwarmAgents',
  description: 'Refund and return policy for SwarmAgents dataset purchases.',
};

export default function RefundPage() {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <div className="min-h-screen bg-[#09090b] text-[#fafafa]">
      <header className="border-b border-white/5 px-5 md:px-8 py-4 max-w-4xl mx-auto w-full flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 group">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/swarm-icon-fast.gif" alt="SwarmAgents logo" width={24} height={24} className="rounded-sm" />
          <span className="text-[14px] font-semibold tracking-[-0.03em] text-[#fafafa] font-mono">swarmagents.codes</span>
        </Link>
        <Link href="/" className="text-[13px] text-[#71717a] hover:text-[#fafafa] transition-colors font-mono">← Home</Link>
      </header>

      <main className="max-w-3xl mx-auto px-5 md:px-8 py-16">
        <div className="mb-10">
          <p className="text-[12px] font-mono text-cyan-400 tracking-widest uppercase mb-3">Legal</p>
          <h1 className="text-[clamp(2rem,5vw,3rem)] font-extrabold tracking-[-0.04em] leading-tight mb-4">Refund Policy</h1>
          <p className="text-[#71717a] text-sm font-mono">Last updated: {today}</p>
        </div>

        <div className="space-y-10 text-[#a1a1aa] leading-relaxed text-[15px]">
          <section>
            <h2 className="text-[#fafafa] font-semibold text-lg mb-3">Overview</h2>
            <p>SwarmAgents sells digital dataset archives for AI model fine-tuning. Because products are delivered instantly as digital downloads, <strong className="text-[#fafafa]">all sales are final</strong> once the download link has been accessed or the license activated.</p>
          </section>

          <section>
            <h2 className="text-[#fafafa] font-semibold text-lg mb-3">Eligibility for Refund or Credit</h2>
            <p className="mb-4">We will issue a full refund or account credit in these circumstances:</p>
            <ul className="list-disc list-inside space-y-2 pl-2">
              <li>You were charged but never received a download link due to a technical failure on our end.</li>
              <li>You were charged multiple times for the same product (duplicate charge).</li>
              <li>The dataset archive is corrupted or fails SHA-256 checksum verification provided at download.</li>
              <li>You contact us within <strong className="text-[#fafafa]">30 days</strong> of purchase with a verifiable technical issue we cannot resolve.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-[#fafafa] font-semibold text-lg mb-3">Non-Refundable Cases</h2>
            <ul className="list-disc list-inside space-y-2 pl-2">
              <li>Change of mind after a successful download.</li>
              <li>Incompatibility with your hardware, software stack, or use case.</li>
              <li>Partial use of a dataset bundle.</li>
              <li>Requests made more than 30 days after purchase.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-[#fafafa] font-semibold text-lg mb-3">How to Request a Refund</h2>
            <p className="mb-4">Email <a href="mailto:james@swarmagents.codes" className="text-cyan-400 hover:text-cyan-300 transition-colors">james@swarmagents.codes</a> with subject <code className="bg-white/5 px-1.5 py-0.5 rounded text-sm font-mono">Refund Request — [Order ID]</code>.</p>
            <p>Please include:</p>
            <ul className="list-disc list-inside space-y-2 pl-2 mt-2">
              <li>Your Stripe payment / order ID (from your confirmation email).</li>
              <li>A brief description of the issue.</li>
              <li>SHA-256 output if the archive appears corrupted.</li>
            </ul>
            <p className="mt-4">We respond within <strong className="text-[#fafafa]">2 business days</strong>. Approved refunds are returned to your original payment method within 5–10 business days.</p>
          </section>

          <section>
            <h2 className="text-[#fafafa] font-semibold text-lg mb-3">Disputes &amp; Chargebacks</h2>
            <p>Please contact us before initiating a chargeback. We will always work in good faith to resolve legitimate issues.</p>
          </section>

          <section>
            <h2 className="text-[#fafafa] font-semibold text-lg mb-3">Contact</h2>
            <p>Questions? <a href="mailto:james@swarmagents.codes" className="text-cyan-400 hover:text-cyan-300 transition-colors">james@swarmagents.codes</a></p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-white/5 flex gap-6 text-[13px] font-mono text-[#52525b]">
          <Link href="/terms" className="hover:text-[#fafafa] transition-colors">Terms</Link>
          <Link href="/privacy" className="hover:text-[#fafafa] transition-colors">Privacy</Link>
          <Link href="/datasets" className="hover:text-[#fafafa] transition-colors">Datasets</Link>
        </div>
      </main>
    </div>
  );
}
