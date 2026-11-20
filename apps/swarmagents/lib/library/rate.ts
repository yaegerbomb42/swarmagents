/**
 * Publish rate limit for the public library.
 *
 * Publishing is the only public-library action that writes shared state, so
 * it gets its own per-account fixed-window budget (default 10 per hour,
 * `SWARM_LIBRARY_PUBLISH_PER_HOUR`). It is independent of the app-wide API
 * bucket in lib/rate-limit so a burst of publishes cannot consume a user's
 * normal request budget, and vice versa.
 *
 * The state is in-process, like the rest of the runtime control plane.
 */

const WINDOW_MS = 60 * 60 * 1000;
const MAX_KEYS = 10_000;

interface Window {
  startedAt: number;
  count: number;
}

const windows = new Map<string, Window>();

/** Configured publishes allowed per hour (invalid values fall back to 10). */
export function publishLimitPerHour(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.SWARM_LIBRARY_PUBLISH_PER_HOUR);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10;
}

export interface PublishRateDecision {
  allowed: boolean;
  /** Seconds until the window resets (0 when allowed). */
  retryAfter: number;
  limit: number;
  remaining: number;
}

/** Consume one publish from `userId`'s hourly budget. */
export function consumePublishRate(
  userId: string,
  now: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): PublishRateDecision {
  const limit = publishLimitPerHour(env);
  let window = windows.get(userId);
  if (!window || now - window.startedAt >= WINDOW_MS) {
    window = { startedAt: now, count: 0 };
    if (!windows.has(userId) && windows.size >= MAX_KEYS) {
      const oldest = windows.keys().next().value;
      if (oldest !== undefined) windows.delete(oldest);
    }
    windows.set(userId, window);
  }
  if (window.count >= limit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1000)),
      limit,
      remaining: 0,
    };
  }
  window.count += 1;
  return { allowed: true, retryAfter: 0, limit, remaining: limit - window.count };
}

/** Test hook: clear all windows. */
export function resetPublishRateLimit(): void {
  windows.clear();
}
