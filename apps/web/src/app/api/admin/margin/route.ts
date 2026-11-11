import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/serverAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENGINE_URL = () => (process.env.ENGINE_URL || 'http://localhost:8400').replace(/\/$/, '');

/**
 * GET /api/admin/margin
 * Proxies the engine's /admin/margin/report, injecting the internal
 * billing key server-side. BILLING_INTERNAL_SECRET never reaches the browser.
 * The caller's Firebase bearer token is forwarded for the engine's admin check.
 */
export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth.ok === false) return auth.response;

  try {
    const res = await fetch(`${ENGINE_URL()}/admin/margin/report`, {
      headers: {
        Authorization: request.headers.get('authorization') || '',
        'X-Billing-Internal-Key': process.env.BILLING_INTERNAL_SECRET || '',
      },
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({ error: `Engine HTTP ${res.status}` }));
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Engine unreachable', code: 'engine_unreachable' },
      { status: 502 },
    );
  }
}
