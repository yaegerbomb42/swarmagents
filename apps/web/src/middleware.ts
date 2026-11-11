/**
 * Edge middleware: rate limits user-facing LLM/agent/task API routes.
 *
 * Tiers (requests/minute, key = user_id || ip):
 * - anonymous: 10 RPM
 * - authed free: 60 RPM
 * - paid: 300 RPM (`x-user-plan: paid` header, set by a trusted upstream
 *   only after TASK-06 auth lands — spoofing is defeated engine-side)
 *
 * NOTE: when deployed as a true Edge bundle, REDIS_URL-backed limiting uses
 * the in-memory fallback (dev only). Run with a Node-compatible middleware
 * runtime or set REDIS_URL on the Node API side for production enforcement.
 */

import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rateLimit';

const RPM_ANONYMOUS = Number(process.env.RATE_LIMIT_RPM_ANONYMOUS || 10);
const RPM_AUTHED_FREE = Number(process.env.RATE_LIMIT_RPM_AUTHED_FREE || 60);
const RPM_PAID = Number(process.env.RATE_LIMIT_RPM_PAID || 300);

export const config = {
  matcher: ['/api/llm/:path*', '/api/agent/:path*', '/api/tasks/:path*', '/api/harness/:path*'],
};

function limitFor(req: NextRequest): { limit: number; key: string } {
  const auth = req.headers.get('authorization') || '';
  const authed = auth.toLowerCase().startsWith('bearer ') && auth.length > 12;
  const plan = req.headers.get('x-user-plan') === 'paid' ? 'paid' : 'free';
  // x-real-ip is set by the reverse proxy (nginx proxy manager) and cannot be forged by the
  // client; the first x-forwarded-for hop can, so it is only a fallback.
  const ip =
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',').pop()?.trim() ||
    'unknown';
  const key = authed ? `user:${auth.slice(7, 19)}` : `ip:${ip}`;
  if (!authed) return { limit: RPM_ANONYMOUS, key };
  return { limit: plan === 'paid' ? RPM_PAID : RPM_AUTHED_FREE, key };
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const enabled = (process.env.RATE_LIMIT_ENABLED || 'true') !== 'false';
  if (!enabled) return NextResponse.next();

  const { limit, key } = limitFor(req);
  const result = await rateLimit(`${req.nextUrl.pathname}:${key}`, limit);
  if (!result.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', limit, retry_after: result.retryAfter },
      {
        status: 429,
        headers: {
          'Retry-After': String(result.retryAfter),
          'X-RateLimit-Limit': String(limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Backend': result.backend,
        },
      },
    );
  }
  const res = NextResponse.next();
  res.headers.set('X-RateLimit-Limit', String(limit));
  res.headers.set('X-RateLimit-Remaining', String(result.remaining));
  return res;
}
