import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/serverAuth';
import { getEngineBillingClient } from '@/lib/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/billing/balance
 * Returns the current balance for the authenticated user.
 * user_id is resolved from the Bearer token — never trust client-supplied user_id.
 */
export async function GET(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth.ok === false) return auth.response;

  let userId: string | null = null;
  try {
    const engineUrl = (process.env.ENGINE_URL || 'http://localhost:8400').replace(/\/$/, '');
    const meRes = await fetch(`${engineUrl}/api/auth/me`, {
      headers: { Authorization: request.headers.get('authorization') || '' },
      cache: 'no-store',
    });
    if (meRes.ok) {
      const me = (await meRes.json()) as { id?: string };
      userId = me?.id ?? null;
    }
  } catch (err) {
    console.error('balance: auth/me lookup failed', err);
  }
  if (!userId) {
    return NextResponse.json(
      { error: 'Could not resolve authenticated user', code: 'user_resolution_failed' },
      { status: 401 }
    );
  }

  const engine = getEngineBillingClient();
  const balance = await engine.getBalance(userId);

  if (!balance) {
    return NextResponse.json({
      user_id: userId,
      credits: 0,
      free_grant_used: false,
      free_grant_available: true,
    });
  }

  return NextResponse.json({
    user_id: balance.user_id,
    credits: balance.credits,
    free_grant_used: balance.free_grant_used,
    free_grant_available: !balance.free_grant_used,
  });
}
