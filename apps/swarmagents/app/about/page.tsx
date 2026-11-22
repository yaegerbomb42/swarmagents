import type { Metadata } from "next";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    absolute: "SwarmAgents — Give it a task. It has its own computer.",
  },
  description:
    "SwarmAgents runs one autonomous agent inside your own persistent Linux VM. Describe the work, watch every step live, take over anytime. Free — bring your own model keys.",
  openGraph: {
    title: "SwarmAgents — Give it a task. It has its own computer.",
    description:
      "One chat bar. One agent. Every tool. Nothing hidden. Your agent works in its own Linux VM while you watch, steer, or take over. Free and open source.",
    type: "website",
  },
};

/**
 * Public landing page: hero, how it works, trust & control, pricing, and
 * starter tasks. The root route (/) is the console itself, so this page is
 * the marketing surface for signed-out visitors. The tagline is canonical —
 * keep it in sync with package.json, app/layout.tsx, and
 * app/manifest.webmanifest.
 */

const EXAMPLE_TASKS = [
  "Fix the failing tests in this repo and open a PR.",
  "Research these three competitors and build me a comparison doc.",
  "Every morning, summarize yesterday's errors and file issues for the worst ones.",
  "Set up a dev environment for this project and show me it running.",
];

const STEPS = [
  {
    n: "01",
    title: "Describe the task",
    body: "One chat bar, plain language. Say what done looks like — the agent plans the work.",
  },
  {
    n: "02",
    title: "Watch it work",
    body: "Its own computer, every step streamed live: shell, files, browser, desktop.",
  },
  {
    n: "03",
    title: "Steer or take over",
    body: "Approve, redirect, or grab the keyboard and mouse yourself, mid-task.",
  },
  {
    n: "04",
    title: "Keep the result",
    body: "Files, PRs, reports — and a VM that remembers where you left off.",
  },
];

const FEATURES = [
  {
    title: "Its own computer, not a chat window",
    body: "Your agent gets a real, persistent Linux VM — shell, files, browser, and a desktop it can drive. It installs, builds, tests, and clicks through its own work, and the machine remembers between runs.",
  },
  {
    title: "Nothing hidden. You're always in control",
    body: "Every tool call, command, and screen streams to you as it happens. Sensitive actions pause for your approval, and one click hands you the controls mid-task. Autonomy you can watch — and interrupt.",
  },
  {
    title: "Your keys. Your machine. Your rules",
    body: "Connect your own provider keys and route each task to the model you choose — or run the agent on your own hardware with the BYOC node. The platform is free and open source (AGPL-3.0). No seats, no credits, no token markup.",
  },
];

const STARTERS = [
  {
    name: "Bug fixer",
    body: "Hand it a failing test; get a tested pull request.",
  },
  {
    name: "Researcher",
    body: "Multi-source briefs with sources you can check.",
  },
  {
    name: "Data wrangler",
    body: "Messy CSV in, clean report out.",
  },
  {
    name: "Night-shift maintainer",
    body: "Scheduled chores that run while you sleep.",
  },
];

const TRUST_POINTS = [
  {
    title: "Sandboxed by design",
    body: "Your agent works inside your own Linux VM — not on your laptop, not in a shared pool. Each account gets its own isolated machine.",
  },
  {
    title: "Approval before risky actions",
    body: "Commands and changes that matter wait for your go-ahead. You set the autonomy level; the agent works inside it.",
  },
  {
    title: "Takeover, anytime",
    body: "Watch the live stream and take the controls whenever you want — for a login, a CAPTCHA, or just to show it how.",
  },
  {
    title: "Your keys stay yours",
    body: "Model keys are stored per account, encrypted at rest, and used only for your runs. They are never pooled or shared with other users.",
  },
];

export default function AboutPage() {
  return (
    <main className="min-h-dvh bg-[#07070a] text-white antialiased">
      {/* Header */}
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-300/80">
            SwarmAgents
          </p>
          <nav className="flex items-center gap-5 text-sm text-white/70">
            <Link href="/status" className="hover:text-white">
              Status
            </Link>
            <a
              href="https://github.com/yaegerbomb42/swarmagents"
              className="hover:text-white"
              rel="noreferrer"
              target="_blank"
            >
              GitHub
            </a>
            <Link
              href="/login"
              className="rounded-md bg-cyan-400 px-3 py-1.5 font-medium text-black hover:bg-cyan-300"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-5 pb-16 pt-20 text-center">
        <h1 className="mx-auto max-w-3xl text-4xl font-semibold leading-tight sm:text-5xl">
          Give it a task. It has its own computer.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">
          SwarmAgents runs one autonomous agent inside your own persistent
          Linux VM. Describe the work in one chat bar, watch every step stream
          live, and take over whenever you want. Free to use — bring your own
          model keys, or bring your own machine.
        </p>
        <p className="mt-4 font-mono text-xs uppercase tracking-[0.18em] text-cyan-300/70">
          One chat bar. One agent. Every tool. Nothing hidden.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/login"
            className="rounded-md bg-cyan-400 px-5 py-2.5 font-medium text-black hover:bg-cyan-300"
          >
            Start your first run — free
          </Link>
          <a
            href="#how-it-works"
            className="rounded-md border border-white/20 px-5 py-2.5 font-medium text-white/90 hover:border-white/40 hover:text-white"
          >
            See how it works
          </a>
        </div>

        {/* Example tasks */}
        <div className="mx-auto mt-12 max-w-2xl text-left">
          <p className="text-center font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
            Try asking it to…
          </p>
          <ul className="mt-4 space-y-2">
            {EXAMPLE_TASKS.map((task) => (
              <li
                key={task}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/80"
              >
                <span className="mr-2 text-cyan-300">›</span>
                {task}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="border-t border-white/10">
        <div className="mx-auto max-w-5xl px-5 py-16">
          <h2 className="text-2xl font-semibold">How it works</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <div
                key={step.n}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
              >
                <p className="font-mono text-sm text-cyan-300">{step.n}</p>
                <h3 className="mt-2 font-medium">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/60">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-white/10">
        <div className="mx-auto max-w-5xl px-5 py-16">
          <h2 className="text-2xl font-semibold">Built to be watched</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
              >
                <h3 className="font-medium">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-white/60">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust & control */}
      <section className="border-t border-white/10">
        <div className="mx-auto max-w-5xl px-5 py-16">
          <h2 className="text-2xl font-semibold">You're in control</h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/60">
            An agent with a computer is only useful if you can trust what it's
            doing. SwarmAgents is built so you never have to wonder.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {TRUST_POINTS.map((point) => (
              <div
                key={point.title}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
              >
                <h3 className="font-medium">{point.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/60">
                  {point.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="border-t border-white/10">
        <div className="mx-auto max-w-5xl px-5 py-16">
          <h2 className="text-2xl font-semibold">Free. Really.</h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/60">
            SwarmAgents doesn't sell you tokens. You connect your own provider
            keys — or run the agent on your own hardware — and pay only for
            what you use, to them.
          </p>
          <div className="mt-8 overflow-hidden rounded-xl border border-white/10">
            <table className="w-full text-left text-sm">
              <tbody>
                <tr className="border-b border-white/10">
                  <td className="px-5 py-4 font-medium">SwarmAgents</td>
                  <td className="px-5 py-4 text-white/70">
                    Free — open source under AGPL-3.0
                  </td>
                </tr>
                <tr className="border-b border-white/10">
                  <td className="px-5 py-4 font-medium">Model usage</td>
                  <td className="px-5 py-4 text-white/70">
                    Your provider keys (BYOK), at their prices — no markup
                  </td>
                </tr>
                <tr>
                  <td className="px-5 py-4 font-medium">Compute</td>
                  <td className="px-5 py-4 text-white/70">
                    Your VM here, or your own machine with the BYOC node
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-white/50">
            No seats. No credits. No token markup.
          </p>
        </div>
      </section>

      {/* Starters */}
      <section className="border-t border-white/10">
        <div className="mx-auto max-w-5xl px-5 py-16">
          <h2 className="text-2xl font-semibold">Start from a template</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STARTERS.map((starter) => (
              <div
                key={starter.name}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
              >
                <h3 className="font-medium text-cyan-200">{starter.name}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/60">
                  {starter.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-white/10">
        <div className="mx-auto max-w-5xl px-5 py-16 text-center">
          <h2 className="text-2xl font-semibold">
            Your agent's computer is waiting
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-white/60">
            Create an account, add a provider key, and type your first task.
            You'll watch your VM boot and get to work.
          </p>
          <Link
            href="/login"
            className="mt-7 inline-block rounded-md bg-cyan-400 px-5 py-2.5 font-medium text-black hover:bg-cyan-300"
          >
            Start your first run — free
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-xs text-white/40">
          <p>
            SwarmAgents — open source (AGPL-3.0). One chat bar. One agent.
            Every tool. Nothing hidden.
          </p>
          <nav className="flex items-center gap-4">
            <Link href="/" className="text-cyan-300 hover:text-cyan-200">
              Console
            </Link>
            <Link href="/status" className="text-cyan-300 hover:text-cyan-200">
              Status
            </Link>
            <a
              href="https://github.com/yaegerbomb42/swarmagents"
              className="text-cyan-300 hover:text-cyan-200"
              rel="noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}
