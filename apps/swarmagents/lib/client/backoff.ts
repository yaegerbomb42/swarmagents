/**
 * Reconnect backoff schedule shared by client stream hooks: exponential
 * (base doubling per attempt), capped at `maxMs`, so a flapping server is
 * polled at most every 30s instead of hammering it.
 */

export interface BackoffOptions {
  /** Delay after the first failure. */
  baseMs?: number;
  /** Ceiling for the computed delay. */
  maxMs?: number;
}

export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;

export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = Math.max(0, options.baseMs ?? DEFAULT_BACKOFF_BASE_MS);
  const maxMs = Math.max(baseMs, options.maxMs ?? DEFAULT_BACKOFF_MAX_MS);
  const n = Math.max(0, Math.floor(attempt));
  // 2**n overflows to Infinity past ~1024; clamp the exponent so the cap wins.
  const exp = Math.min(n, 60);
  return Math.min(baseMs * 2 ** exp, maxMs);
}
