/**
 * Billing server-side helpers.
 * Talks to the engine's billing endpoints (TASK-01 implements).
 * Never trust the client: all credit math happens here, prices come from
 * `modelPricing.ts`, balances come from the engine.
 */

import { CREDIT_PACKS, FREE_SIGNUP_CREDITS, type CreditPack } from './modelPricing';

const ENGINE_URL = () =>
  (process.env.ENGINE_URL || 'http://localhost:8400').replace(/\/$/, '');

export interface EngineBalance {
  user_id: string;
  credits: number;
  free_grant_used: boolean;
}

export interface EngineClient {
  getBalance(userId: string): Promise<EngineBalance | null>;
  grantSignup(userId: string): Promise<EngineBalance | null>;
  creditPurchase(opts: {
    userId: string;
    packId: string;
    credits: number;
    stripeSessionId: string;
  }): Promise<{ ok: boolean; duplicate?: boolean; balance_after?: number; error?: string }>;
  upsertPlan(opts: {
    userId: string;
    tier: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    status: string;
    interval: string;
    currentPeriodEndUnix: number | null;
  }): Promise<{ ok: boolean; tier?: string; status?: string; error?: string }>;
  planRenewalGrant(opts: {
    stripeInvoiceId: string;
    stripeSubscriptionId: string;
  }): Promise<{ ok: boolean; credits_granted?: number; duplicate?: boolean; error?: string }>;
}

async function engineFetch<T>(
  path: string,
  init?: RequestInit
): Promise<
  | { ok: true; data: T; status?: never; error?: never }
  | { ok: false; data?: never; status: number; error: string }
> {
  try {
    const res = await fetch(`${ENGINE_URL()}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Billing-Internal-Key': process.env.BILLING_INTERNAL_SECRET || '',
        ...(init?.headers || {}),
      },
      cache: 'no-store',
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* fall through */
    }
    if (!res.ok) {
      const err =
        (data as { error?: string })?.error || res.statusText || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: err };
    }
    return { ok: true, data: data as T };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'network' };
  }
}

export function getEngineBillingClient(): EngineClient {
  return {
    async getBalance(userId) {
      const r = await engineFetch<EngineBalance>(`/billing/balance?user_id=${encodeURIComponent(userId)}`);
      return r.ok ? r.data : null;
    },
    async grantSignup(userId) {
      const r = await engineFetch<EngineBalance>('/billing/grant-signup', {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, credits: FREE_SIGNUP_CREDITS }),
      });
      return r.ok ? r.data : null;
    },
    async creditPurchase(opts) {
      const r = await engineFetch<{ duplicate?: boolean; balance_after?: number }>(
        '/billing/credit-purchase',
        {
          method: 'POST',
          body: JSON.stringify({
            user_id: opts.userId,
            pack_id: opts.packId,
            credits: opts.credits,
            stripe_session_id: opts.stripeSessionId,
          }),
        }
      );
      return r.ok
        ? { ok: true, duplicate: r.data?.duplicate, balance_after: r.data?.balance_after }
        : { ok: false, error: r.error };
    },
    async upsertPlan(opts) {
      const r = await engineFetch<{ tier?: string; status?: string }>(
        '/billing/upsert-plan',
        {
          method: 'POST',
          body: JSON.stringify({
            user_id: opts.userId,
            tier: opts.tier,
            stripe_customer_id: opts.stripeCustomerId,
            stripe_subscription_id: opts.stripeSubscriptionId,
            status: opts.status,
            interval: opts.interval,
            current_period_end_unix: opts.currentPeriodEndUnix,
          }),
        }
      );
      return r.ok
        ? { ok: true, tier: r.data?.tier, status: r.data?.status }
        : { ok: false, error: r.error };
    },
    async planRenewalGrant(opts) {
      const r = await engineFetch<{ credits_granted?: number; duplicate?: boolean }>(
        '/billing/plan-renewal-grant',
        {
          method: 'POST',
          body: JSON.stringify({
            stripe_invoice_id: opts.stripeInvoiceId,
            stripe_subscription_id: opts.stripeSubscriptionId,
          }),
        }
      );
      return r.ok
        ? {
            ok: true,
            credits_granted: r.data?.credits_granted,
            duplicate: r.data?.duplicate,
          }
        : { ok: false, error: r.error };
    },
  };
}

export function getPacks(): CreditPack[] {
  return CREDIT_PACKS;
}
