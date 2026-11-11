/**
 * Fixed-window rate limiter for user-facing API routes (Edge-safe).
 *
 * Backend selection (first match wins):
 * - `REDIS_REST_URL` + `REDIS_REST_TOKEN` → Upstash-style Redis REST API via
 *   `fetch` (Edge-compatible, multi-instance safe). Set these in production.
 * - Otherwise → in-memory Map.
 *
 * WARNING: the in-memory Map is a DEV-ONLY fallback. Counters are per
 * instance, per serverless invocation context, and reset on deploy/restart.
 * It must never be relied on for production enforcement.
 */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
  backend: 'redis' | 'memory';
}

interface Window {
  count: number;
  resetAt: number;
}

const WINDOWS = new Map<string, Window>();
const MAX_WINDOWS = 100_000;
const WINDOW_MS = 60_000;

const REST_URL = (process.env.REDIS_REST_URL || '').replace(/\/$/, '');
const REST_TOKEN = process.env.REDIS_REST_TOKEN || '';

async function redisCommand(command: (string | number)[]): Promise<unknown> {
  const resp = await fetch(`${REST_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!resp.ok) throw new Error(`redis_rest_${resp.status}`);
  const body = (await resp.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(`redis_${body.error}`);
  return body.result;
}

function memoryIncr(key: string, limit: number, windowMs = WINDOW_MS): RateLimitResult {
  const now = Date.now();
  if (WINDOWS.size > MAX_WINDOWS) WINDOWS.clear(); // bound dev memory
  let win = WINDOWS.get(key);
  if (!win || now >= win.resetAt) {
    win = { count: 0, resetAt: now + windowMs };
    WINDOWS.set(key, win);
  }
  const retryAfter = Math.max(1, Math.ceil((win.resetAt - now) / 1000));
  if (win.count >= limit) {
    return { allowed: false, limit, remaining: 0, retryAfter, backend: 'memory' };
  }
  win.count += 1;
  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - win.count),
    retryAfter: 0,
    backend: 'memory',
  };
}

export async function rateLimit(key: string, limit: number): Promise<RateLimitResult> {
  if (REST_URL && REST_TOKEN) {
    try {
      const redisKey = `dash:rl:${key}`;
      const count = Number(await redisCommand(['INCR', redisKey]));
      if (count === 1) await redisCommand(['PEXPIRE', redisKey, WINDOW_MS]);
      if (count > limit) {
        const ttlMs = Number(await redisCommand(['PTTL', redisKey]));
        return {
          allowed: false,
          limit,
          remaining: 0,
          retryAfter: Math.max(1, Math.ceil(ttlMs / 1000)),
          backend: 'redis',
        };
      }
      return { allowed: true, limit, remaining: Math.max(0, limit - count), retryAfter: 0, backend: 'redis' };
    } catch (err) {
      console.warn('[rateLimit] Redis REST error, in-memory fallback:', err instanceof Error ? err.message : err);
    }
  }
  return memoryIncr(key, limit);
}

/** Test hook — reset in-memory state. */
export function __resetRateLimitForTests(): void {
  WINDOWS.clear();
}
