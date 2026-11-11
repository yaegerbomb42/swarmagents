/**
 * Client-side billing helpers. All sensitive math stays server-side.
 */

'use client';

import { authHeaders } from './auth';

export interface BalanceResponse {
  user_id: string;
  credits: number;
  free_grant_used: boolean;
  free_grant_available: boolean;
}

export interface PricingResponse {
  credit_usd: number;
  margin_multiplier: number;
  packs: Array<{
    packId: 'starter' | 'pro' | 'team';
    label: string;
    usdCents: number;
    credits: number;
    bonusLabel: string | null;
  }>;
  models: Array<{
    modelId: string;
    creditsPer1KInput: number;
    creditsPer1KOutput: number;
    azureListUsdPer1KInput: number;
    azureListUsdPer1KOutput: number;
  }>;
}

export interface BillingError {
  error: string;
  code?: string;
  detail?: string;
}

export type BillingResult<T> =
  | { ok: true; data: T; error?: never }
  | { ok: false; status: number; error: BillingError };

async function parse<T>(res: Response): Promise<BillingResult<T>> {
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    const err = (data as BillingError) || { error: res.statusText || `HTTP ${res.status}` };
    return { ok: false, status: res.status, error: err };
  }
  return { ok: true, data: data as T };
}

export async function fetchBalance(): Promise<BillingResult<BalanceResponse>> {
  try {
    const res = await fetch('/api/billing/balance', {
      headers: authHeaders(),
      cache: 'no-store',
    });
    return parse<BalanceResponse>(res);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: { error: e instanceof Error ? e.message : 'Network error', code: 'network' },
    };
  }
}

export async function fetchPricing(): Promise<BillingResult<PricingResponse>> {
  try {
    const res = await fetch('/api/billing/pricing', { cache: 'no-store' });
    return parse<PricingResponse>(res);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: { error: e instanceof Error ? e.message : 'Network error', code: 'network' },
    };
  }
}

export async function createCheckoutSession(packId: 'starter' | 'pro' | 'team'): Promise<
  BillingResult<{ url: string; session_id: string }>
> {
  try {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ pack_id: packId }),
    });
    return parse<{ url: string; session_id: string }>(res);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: { error: e instanceof Error ? e.message : 'Network error', code: 'network' },
    };
  }
}

export const LOW_BALANCE_THRESHOLD = 50;
export const CRITICAL_BALANCE_THRESHOLD = 10;

export function isPaymentRequiredError(status: number, code?: string): boolean {
  return status === 402 || code === 'insufficient_credits';
}

/** Shape of the 402 body the engine returns on debit refusal. */
export interface InsufficientCreditsDetail {
  credits_required?: number;
  credits_available?: number;
}

/**
 * Pull {credits_required, credits_available} out of an engine error detail payload.
 * Handles both flat bodies ({credits_required, ...}) and FastAPI-style
 * {detail: {credits_required, ...}} wrappers. Returns null when absent.
 */
export function extractInsufficientCredits(detail: unknown): InsufficientCreditsDetail | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  const inner =
    d.detail && typeof d.detail === 'object' ? (d.detail as Record<string, unknown>) : d;
  const required = inner.credits_required;
  const available = inner.credits_available;
  if (typeof required !== 'number' && typeof available !== 'number') return null;
  return {
    credits_required: typeof required === 'number' ? required : undefined,
    credits_available: typeof available === 'number' ? available : undefined,
  };
}
