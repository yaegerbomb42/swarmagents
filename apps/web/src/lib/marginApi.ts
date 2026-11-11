/**
 * Admin margin API client — fetches the engine's /admin/margin/live endpoint
 * through the dashboard's /api/engine/* proxy. Auth is the engine-side
 * BILLING_INTERNAL_SECRET supplied as the X-Billing-Internal-Key header and
 * stored in sessionStorage by the admin page (never in localStorage).
 */

const KEY_STORAGE = 'swarmagents.admin_internal_key';
const LIVE_PATH = '/api/engine/admin/margin/live';

export type WindowHours = 1 | 24 | 168; // 1h / 24h / 7d

export interface LiveModelMargin {
  model: string;
  gross_usd: number;
  cost_usd: number;
  margin_usd: number;
  margin_pct: number | null;
  calls: number;
}

export interface LiveMarginTotals {
  gross_usd: number;
  cost_usd: number;
  margin_usd: number;
  margin_pct: number | null;
  calls: number;
}

export interface LiveMarginResponse {
  ok: boolean;
  window_hours: number;
  generated_at: string;
  models: LiveModelMargin[];
  totals: LiveMarginTotals;
}

export interface LiveMarginError {
  status: number;
  message: string;
  unauthorized: boolean;
}

export function getAdminKey(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(KEY_STORAGE);
}

export function setAdminKey(key: string): void {
  if (typeof window === 'undefined') return;
  if (key) {
    window.sessionStorage.setItem(KEY_STORAGE, key);
  } else {
    window.sessionStorage.removeItem(KEY_STORAGE);
  }
}

export function clearAdminKey(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(KEY_STORAGE);
}

export async function fetchLiveMargin(
  windowHours: WindowHours,
  adminKey: string,
): Promise<LiveMarginResponse> {
  const url = `${LIVE_PATH}?window_hours=${encodeURIComponent(windowHours)}`;
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      'X-Billing-Internal-Key': adminKey,
    },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: { error?: string } | string; error?: string };
      if (typeof body?.detail === 'object' && body.detail?.error) message = body.detail.error;
      else if (typeof body?.detail === 'string') message = body.detail;
      else if (body?.error) message = body.error;
    } catch {
      /* keep default message */
    }
    const err: LiveMarginError = {
      status: res.status,
      message,
      unauthorized: res.status === 401 || res.status === 403,
    };
    throw err;
  }
  return (await res.json()) as LiveMarginResponse;
}
