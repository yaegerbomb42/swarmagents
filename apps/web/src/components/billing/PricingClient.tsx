'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import type { PlanSpec } from '@/lib/plans';
import { authHeaders } from '@/lib/auth';
import { getFirebaseAuth } from '@/lib/firebase';

interface Props {
  plans: PlanSpec[];
}

type Interval = 'month' | 'year';

export default function PricingClient({ plans }: Props) {
  const router = useRouter();
  const [interval, setInterval] = useState<Interval>('month');
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = async (plan: PlanSpec) => {
    setError(null);
    if (plan.tier === 'enterprise') {
      router.push('/contact?reason=enterprise');
      return;
    }
    if (plan.tier === 'free') {
      router.push('/signup');
      return;
    }
    setBusyFor(plan.tier);
    try {
      let token: string | undefined = undefined;
      try {
        token = (await getFirebaseAuth().currentUser?.getIdToken()) || undefined;
      } catch {
        // If Firebase is not configured, fall back to local token
        token = authHeaders()['Authorization']?.replace('Bearer ', '');
      }
      if (!token) {
        const next = encodeURIComponent('/pricing');
        const planParam = encodeURIComponent(plan.tier);
        router.push(`/signup?next=${next}&plan=${planParam}`);
        return;
      }
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({ plan: plan.tier, interval }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.detail || `HTTP ${res.status}`);
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
      setBusyFor(null);
    }
  };

  return (
    <section className="mb-12">
      {/* Interval toggle */}
      <div className="flex justify-center mb-8">
        <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-zinc-900 border border-zinc-800 text-sm">
          <button
            type="button"
            onClick={() => setInterval('month')}
            className={`px-4 py-1.5 rounded-md transition ${
              interval === 'month'
                ? 'bg-zinc-800 text-zinc-50'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setInterval('year')}
            className={`px-4 py-1.5 rounded-md transition inline-flex items-center gap-2 ${
              interval === 'year'
                ? 'bg-zinc-800 text-zinc-50'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Annual
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-900">
              2 months free
            </span>
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-3 rounded-lg border border-rose-900 bg-rose-950/30 text-rose-300 text-sm">
          {error}
        </div>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        {plans.map((plan) => {
          const isBusy = busyFor === plan.tier;
          const monthly = plan.monthlyUsdCents / 100;
          const annual = plan.annualUsdCents / 100;
          const showAnnual = interval === 'year' && annual > 0;

          return (
            <div
              key={plan.tier}
              className={`relative rounded-2xl border p-6 flex flex-col gap-4 transition ${
                plan.highlight
                  ? 'border-emerald-600 bg-gradient-to-b from-emerald-950/20 to-zinc-900 shadow-lg shadow-emerald-900/20'
                  : 'border-zinc-800 bg-zinc-900/50'
              }`}
            >
              {plan.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-emerald-600 text-[10px] font-semibold uppercase tracking-wider text-emerald-50">
                  Most popular
                </div>
              )}
              <div>
                <h3 className="text-xl font-bold text-zinc-50">{plan.label}</h3>
                <p className="text-xs text-zinc-500 mt-0.5">{plan.tagline}</p>
              </div>
              <div>
                {plan.tier === 'free' || plan.tier === 'enterprise' ? (
                  <div className="text-3xl font-bold text-zinc-50">
                    {plan.tier === 'free' ? '$0' : 'Custom'}
                  </div>
                ) : showAnnual ? (
                  <div>
                    <div className="text-3xl font-bold text-zinc-50">
                      ${Math.round(annual / 12)}
                      <span className="text-sm font-normal text-zinc-500">/mo</span>
                    </div>
                    <div className="text-xs text-emerald-400 mt-1">
                      Billed ${annual.toLocaleString()} annually
                    </div>
                  </div>
                ) : (
                  <div className="text-3xl font-bold text-zinc-50">
                    ${monthly}
                    <span className="text-sm font-normal text-zinc-500">/mo</span>
                  </div>
                )}
                {plan.monthlyCredits > 0 && (
                  <div className="text-xs text-zinc-500 mt-1">
                    ${(plan.monthlyCredits / 1000).toFixed(0)} in credits every month
                  </div>
                )}
              </div>
              <ul className="space-y-2 text-sm text-zinc-300 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check size={14} className="text-emerald-500 shrink-0 mt-0.5" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => startCheckout(plan)}
                disabled={isBusy}
                className={`w-full rounded-md py-2 text-sm font-semibold transition ${
                  plan.highlight
                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                    : plan.tier === 'enterprise'
                      ? 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700'
                      : plan.tier === 'free'
                        ? 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700'
                        : 'bg-zinc-100 text-zinc-900 hover:bg-white'
                } disabled:opacity-50 inline-flex items-center justify-center gap-2`}
              >
                {isBusy && <Loader2 size={14} className="animate-spin" />}
                {plan.tier === 'free'
                  ? 'Start free'
                  : plan.tier === 'enterprise'
                    ? 'Contact sales'
                    : `Start ${plan.label}`}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
