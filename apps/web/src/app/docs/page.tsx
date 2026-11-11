import Link from 'next/link';
import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';

export const metadata = {
  title: 'Docs — SwarmAgents',
  description: 'How SwarmAgents works: product, lab, pricing, datasets, and authentication.',
};

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#050508] text-zinc-100">
      <SiteHeader subtitle="Documentation" />
      <main className="mx-auto max-w-3xl px-5 py-12 lg:px-8">
        <p className="text-[11px] font-mono uppercase tracking-widest text-cyan-400 mb-3">
          Product docs
        </p>
        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white mb-4">
          How SwarmAgents works
        </h1>
        <p className="text-zinc-400 leading-relaxed mb-8">
          SwarmAgents is a multi-agent workbench. You describe a goal, the console decomposes it
          into parallel agents, and the lab lets you forge the roles those agents run. Datasets are
          a separate commercial catalog for post-training — not a substitute for a product agent.
        </p>

        <section className="mb-10 space-y-4">
          <h2 className="text-lg font-semibold text-white">Product flow</h2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-zinc-300 leading-relaxed">
            <li>
              Open the console and submit a mission. The orchestrator decomposes the goal into a
              tree of agents (coder, verifier, researcher, and custom roles).
            </li>
            <li>
              Optionally forge or fork roles in the Lab, then bind them into a run.
            </li>
            <li>
              Subscribe on Pricing when you need higher quota, team agents, or included credits.
            </li>
            <li>
              Dataset packs are licensed separately via Stripe and unlocked only after payment
              verification.
            </li>
          </ol>
        </section>

        <section className="mb-10">
          <h2 className="text-lg font-semibold text-white mb-3">Places to start</h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <li>
              <Link href="/decomp" className="block rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 hover:border-cyan-400/40 hover:text-white text-zinc-300">
                <span className="font-semibold text-white">Product / Decomp</span>
                <span className="block text-xs text-zinc-500 mt-1">Console workbench and mission tree</span>
              </Link>
            </li>
            <li>
              <Link href="/lab" className="block rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 hover:border-cyan-400/40 hover:text-white text-zinc-300">
                <span className="font-semibold text-white">Lab</span>
                <span className="block text-xs text-zinc-500 mt-1">Forge roles and inspect prompt DNA</span>
              </Link>
            </li>
            <li>
              <Link href="/pricing" className="block rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 hover:border-cyan-400/40 hover:text-white text-zinc-300">
                <span className="font-semibold text-white">Pricing</span>
                <span className="block text-xs text-zinc-500 mt-1">Starter, Pro, Team, and Enterprise</span>
              </Link>
            </li>
            <li>
              <Link href="/datasets" className="block rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 hover:border-cyan-400/40 hover:text-white text-zinc-300">
                <span className="font-semibold text-white">Datasets</span>
                <span className="block text-xs text-zinc-500 mt-1">Commercial post-training packs</span>
              </Link>
            </li>
          </ul>
        </section>

        <section className="rounded-2xl border border-amber-500/20 bg-amber-950/20 p-5 text-sm text-amber-100/90">
          <h2 className="text-base font-semibold text-white mb-2">Authentication</h2>
          <p className="leading-relaxed text-zinc-300">
            Console, Lab, and billed features require a SwarmAgents account.{' '}
            <Link href="/signup?next=%2Fdecomp" className="text-cyan-300 underline">
              Create an account
            </Link>{' '}
            or{' '}
            <Link href="/login?next=%2Fdecomp" className="text-cyan-300 underline">
              sign in
            </Link>
            . Dataset downloads unlock only after Stripe verifies a paid checkout session — a
            session ID alone is not enough.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
