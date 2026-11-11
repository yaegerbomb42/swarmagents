'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Loader2 } from 'lucide-react';
import ConsoleShell from '@/components/ConsoleShell';

const PLANS = [
  {
    id: 'beta',
    name: 'Beta',
    price: '$0',
    points: [
      'Account + engine auth',
      'BYOK or shared DeepSeek Flash quota',
      'Full decomp → gates → deliverable loop',
    ],
    cta: 'Start free',
    href: '/signup?next=/decomp',
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 'Soon',
    points: [
      'Higher concurrency & priority routing',
      'Team agents + usage dashboard',
      'Stripe checkout (waitlist until live)',
    ],
    cta: 'Join waitlist',
    href: '#waitlist',
  },
];

export default function BillingPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/public/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, plan: 'pro', source: 'billing' }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed');
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConsoleShell missionHint="Billing & plans">
    <div className="min-h-[calc(100svh-3rem)] bg-[#09090b] text-[#fafafa]">
      <div className="max-w-4xl mx-auto px-5 py-14 md:py-20">
        <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-[#71717a] mb-3">
          Billing
        </p>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-[-0.03em] mb-3">
          Quota now. Stripe next.
        </h1>
        <p className="text-[#a1a1aa] text-[15px] max-w-2xl mb-10">
          Public beta is free with bring-your-own-key or shared Flash quota. Paid plans are on the
          waitlist until checkout ships.
        </p>

        <div className="grid md:grid-cols-2 gap-4 mb-14">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className="border border-white/[0.07] rounded-2xl p-6 bg-white/[0.02] flex flex-col"
            >
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="text-lg font-medium">{plan.name}</h2>
                <span className="text-[13px] font-mono text-[#a1a1aa]">{plan.price}</span>
              </div>
              <ul className="space-y-2 mb-6 flex-1">
                {plan.points.map((p) => (
                  <li key={p} className="text-[13px] text-[#a1a1aa]">
                    · {p}
                  </li>
                ))}
              </ul>
              <Link
                href={plan.href}
                className="inline-flex items-center justify-center gap-1.5 rounded-full bg-[#fafafa] text-[#09090b] px-4 py-2.5 text-[13px] font-medium"
              >
                {plan.cta}
                <ArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>

        <section id="waitlist" className="border border-white/[0.07] rounded-2xl p-6 md:p-8">
          <h2 className="text-xl font-medium tracking-tight mb-2">Pro waitlist</h2>
          <p className="text-[13px] text-[#a1a1aa] mb-6">
            We’ll email when Stripe checkout and team agents open.
          </p>
          {done ? (
            <p className="text-[14px] text-emerald-300/90">You’re on the list.</p>
          ) : (
            <form onSubmit={onSubmit} className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                placeholder="Name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm"
              />
              <input
                type="email"
                required
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-[1.4] bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm"
              />
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#fafafa] text-[#09090b] px-4 py-2.5 text-[13px] font-medium disabled:opacity-60"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                Join
              </button>
            </form>
          )}
          {error ? <p className="text-xs text-red-300/90 mt-3">{error}</p> : null}
        </section>

        <p className="mt-8 text-[12px] text-[#52525b]">
          Already have an account?{' '}
          <Link href="/decomp" className="text-[#a1a1aa] hover:text-[#fafafa]">
            Open console
          </Link>
          {' · '}
          <Link href="/settings" className="text-[#a1a1aa] hover:text-[#fafafa]">
            Provider quota
          </Link>
        </p>
      </div>
    </div>
    </ConsoleShell>
  );
}
