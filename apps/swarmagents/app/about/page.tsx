import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "About — SwarmAgents",
  description: "What SwarmAgents is and what it does.",
};

/**
 * Minimal honest About page. There is no separate docs/FAQ site yet — those
 * pages are being added on their own branches — so this page says only what
 * the product actually is today.
 */
export default function AboutPage() {
  return (
    <main className="min-h-dvh bg-[#07070a] text-white antialiased">
      <div className="mx-auto max-w-2xl px-5 py-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-300/70">
          SwarmAgents
        </p>
        <h1 className="mt-3 text-3xl font-semibold">About</h1>
        <div className="mt-6 space-y-4 text-sm leading-relaxed text-white/70">
          <p>
            SwarmAgents is a single chat bar that drives an autonomous agent
            running on its own Linux computer. You describe what you want —
            build something, fetch something, run a command — and the agent
            plans the work, runs it in the VM, and shows you what it did.
          </p>
          <p>
            One prompt bar, one agent, every tool. The agent works in a
            pipeline of roles you can reorder, against providers you bring
            yourself — your own API keys, stored per account and encrypted at
            rest. You need at least one provider configured before the agent can
            run; with none set up, a run errors until you add one.
          </p>
          <p>
            SwarmAgents is under active development. Some pages linked from
            the product are still being written; this page and the{" "}
            <a href="/status" className="text-cyan-300 underline underline-offset-2 hover:text-cyan-200">
              status page
            </a>{" "}
            are the public pages that exist today.
          </p>
        </div>
        <p className="mt-10 border-t border-white/10 pt-6 text-xs text-white/40">
          <a href="/" className="text-cyan-300 hover:text-cyan-200">
            ← Back to the console
          </a>
        </p>
      </div>
    </main>
  );
}
