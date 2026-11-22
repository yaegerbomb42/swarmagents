import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "About — SwarmAgents",
  description: "What SwarmAgents is and what it does.",
};

/**
 * Public About page: what SwarmAgents is, how it runs (BYOK/BYOC), and how
 * runs stay sandboxed and visible. The tagline here is the canonical one —
 * keep it in sync with package.json, app/layout.tsx, and
 * app/manifest.webmanifest.
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
          <p className="text-base text-white/90">
            One chat bar. One agent. Every tool. Nothing hidden.
          </p>
          <p>
            SwarmAgents is a single chat bar that drives an autonomous agent
            running on its own Linux computer. You describe what you want —
            build something, fetch something, run a command — and the agent
            plans the work, runs it in its VM, and shows you what it did,
            step by step. You can watch it work live and take over the
            desktop at any moment.
          </p>
          <p>
            It runs on your terms: bring your own compute (BYOC) and your own
            provider keys (BYOK). The agent works in a pipeline of roles you
            can reorder, against the providers you configure — your keys are
            stored per account and encrypted at rest. Add at least one
            provider key and the agent can run; every run uses your keys, on
            your compute.
          </p>
          <p>
            Every run is sandboxed. The agent works inside an isolated VM,
            not on your machine, and risky actions wait for your approval
            before they happen. Nothing is hidden: you see the plan, the
            commands, the files it touched, and the result.
          </p>
          <p>
            Ready to try it?{" "}
            <a href="/login" className="text-cyan-300 underline underline-offset-2 hover:text-cyan-200">
              Sign in or create an account
            </a>{" "}
            and add a provider key to run your first task. Service status
            lives on the{" "}
            <a href="/status" className="text-cyan-300 underline underline-offset-2 hover:text-cyan-200">
              status page
            </a>
            .
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
