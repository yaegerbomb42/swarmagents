'use client';

import { useState } from 'react';
import { createCheckoutSession } from '@/lib/billingClient';

interface PackCardsProps {
  packs: Array<{
    packId: 'starter' | 'pro' | 'team';
    label: string;
    usdCents: number;
    credits: number;
    bonusLabel: string | null;
  }>;
}

export default function PackCards({ packs }: PackCardsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buy = async (packId: 'starter' | 'pro' | 'team') => {
    setBusy(packId);
    setError(null);
    const r = await createCheckoutSession(packId);
    setBusy(null);
    if (!r.ok) {
      setError(r.error.error || 'Checkout failed');
      return;
    }
    window.location.href = r.data.url;
  };

  return (
    <div>
      {error && (
        <div className="mb-4 border border-red-500/50 bg-red-500/10 text-red-200 text-sm rounded p-3">
          {error}
          {error.toLowerCase().includes('auth') && (
            <span className="block mt-1 text-xs opacity-80">
              You need to <a className="underline" href="/login?next=/pricing">sign in</a> first.
            </span>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {packs.map((p) => (
          <div
            key={p.packId}
            className="border border-zinc-800 rounded-lg p-6 bg-zinc-950 hover:border-zinc-700 transition-colors"
          >
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-lg font-semibold text-zinc-100">{p.label}</h3>
              {p.bonusLabel && (
                <span className="text-xs font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-0.5">
                  {p.bonusLabel}
                </span>
              )}
            </div>
            <div className="text-3xl font-bold text-zinc-50 mb-1">
              ${(p.usdCents / 100).toFixed(0)}
            </div>
            <div className="text-sm text-zinc-400 mb-4">{p.credits.toLocaleString()} credits</div>
            <ul className="text-xs text-zinc-500 mb-4 space-y-1">
              <li>1 credit = $0.001</li>
              <li>Never expires</li>
              <li>Use on any Azure model</li>
            </ul>
            <button
              onClick={() => buy(p.packId)}
              disabled={busy !== null}
              className="w-full py-2 rounded bg-zinc-50 text-zinc-950 font-medium hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              {busy === p.packId ? 'Redirecting…' : `Buy ${p.label}`}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
