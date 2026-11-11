'use client';

import Link from 'next/link';
import { LOW_BALANCE_THRESHOLD, CRITICAL_BALANCE_THRESHOLD } from '@/lib/billingClient';
import { useBalance } from '@/hooks/useBalance';

export type BalanceTier = 'ok' | 'low' | 'critical';

export function balanceTier(credits: number): BalanceTier {
  if (credits <= CRITICAL_BALANCE_THRESHOLD) return 'critical';
  if (credits < LOW_BALANCE_THRESHOLD) return 'low';
  return 'ok';
}

const TIER_STYLES: Record<BalanceTier, string> = {
  ok: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  low: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  critical: 'border-red-500/50 bg-red-500/10 text-red-300 animate-pulse',
};

/**
 * Persistent balance pill for the global header. Polls on an interval (via the
 * shared useBalance hook) and subscribes to refresh events fired after each
 * execution. Renders nothing when unauthenticated.
 */
export default function BalanceIndicator() {
  const { balance, loaded } = useBalance({ intervalMs: 30_000 });

  if (!loaded) {
    return <span className="text-xs text-zinc-500">…</span>;
  }
  if (!balance) return null;

  const tier = balanceTier(balance.credits);
  return (
    <Link
      href="/pricing"
      className={`text-xs font-mono px-2 py-1 rounded border ${TIER_STYLES[tier]}`}
      title={
        tier === 'ok'
          ? 'Credit balance — click to top up'
          : tier === 'low'
            ? 'Balance running low — click to top up'
            : 'Balance nearly exhausted — executions may be blocked'
      }
    >
      {tier !== 'ok' ? '⚠ ' : ''}
      {balance.credits.toLocaleString(undefined, { maximumFractionDigits: 1 })} cr
    </Link>
  );
}
