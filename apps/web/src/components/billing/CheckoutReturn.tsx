'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useBalance, requestBalanceRefresh } from '@/hooks/useBalance';

/**
 * Shown on /pricing when the URL carries ?session_id (Stripe Checkout success
 * return) or ?cancelled=1. Refreshes the global balance indicators and offers
 * a deep link back to the orchestrator with ?session_id preserved so a paused
 * execution can auto-resume once credits land.
 */
export default function CheckoutReturn() {
  const params = useSearchParams();
  const sessionId = params.get('session_id');
  const cancelled = params.get('cancelled');
  const { refresh } = useBalance({ intervalMs: 0 });
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let cancelledFlag = false;
    const poll = async () => {
      const fresh = await refresh();
      if (cancelledFlag) return;
      requestBalanceRefresh();
      // Webhook may still be in flight — poll a few times before settling.
      if (fresh && fresh.credits > 0) {
        setConfirmed(true);
      } else {
        setTimeout(poll, 3_000);
      }
    };
    void poll();
    return () => {
      cancelledFlag = true;
    };
  }, [sessionId, refresh]);

  if (cancelled) {
    return (
      <div className="mb-8 border border-zinc-700 bg-zinc-900/60 text-zinc-300 rounded-lg p-4 text-sm">
        Checkout cancelled — no charge was made.
      </div>
    );
  }
  if (!sessionId) return null;

  return (
    <div className="mb-8 border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 rounded-lg p-4">
      <h3 className="font-semibold text-emerald-100 mb-1">
        {confirmed ? 'Credits added to your balance' : 'Confirming your purchase…'}
      </h3>
      <p className="text-sm text-emerald-200/80 mb-3">
        {confirmed
          ? 'Your balance has been topped up and the header indicator is refreshed.'
          : 'This usually takes a few seconds while the Stripe webhook posts the credits.'}
      </p>
      <Link
        href={`/decomp?session_id=${encodeURIComponent(sessionId)}`}
        className="inline-block px-3 py-1.5 text-sm rounded bg-emerald-500 text-black font-medium hover:bg-emerald-400"
      >
        Return to orchestrator &amp; resume
      </Link>
    </div>
  );
}
