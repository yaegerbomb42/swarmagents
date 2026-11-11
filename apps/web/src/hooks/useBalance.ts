'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBalance, type BalanceResponse } from '@/lib/billingClient';

export interface UseBalanceOptions {
  /** Poll interval in ms. 0 disables polling. Default 30s. */
  intervalMs?: number;
}

export interface UseBalanceResult {
  balance: BalanceResponse | null;
  loaded: boolean;
  /** True once an unauthenticated / failed response was observed. */
  unavailable: boolean;
  refresh: () => Promise<BalanceResponse | null>;
}

export const BALANCE_REFRESH_EVENT = 'swarmagents:balance-refresh';

/** Ask every mounted useBalance consumer to refetch (e.g. after an execution). */
export function requestBalanceRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BALANCE_REFRESH_EVENT));
}

/**
 * Shared balance hook: initial fetch, optional interval polling, manual refresh,
 * and a window event so non-hook code paths (execution loop) can trigger refetch.
 */
export function useBalance(options: UseBalanceOptions = {}): UseBalanceResult {
  const { intervalMs = 30_000 } = options;
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<BalanceResponse | null> => {
    const r = await fetchBalance();
    if (!mountedRef.current) return r.ok ? r.data : null;
    setLoaded(true);
    if (r.ok) {
      setBalance(r.data);
      setUnavailable(false);
      return r.data;
    }
    setBalance(null);
    setUnavailable(true);
    return null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const onRefresh = () => { void refresh(); };
    window.addEventListener(BALANCE_REFRESH_EVENT, onRefresh);
    let timer: ReturnType<typeof setInterval> | null = null;
    if (intervalMs > 0) {
      timer = setInterval(() => { void refresh(); }, intervalMs);
    }
    return () => {
      mountedRef.current = false;
      window.removeEventListener(BALANCE_REFRESH_EVENT, onRefresh);
      if (timer) clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { balance, loaded, unavailable, refresh };
}
