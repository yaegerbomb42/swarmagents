import { NextRequest, NextResponse } from 'next/server';
import { verifyDatasetCheckoutSession } from '@/lib/datasetStripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const sku = typeof body.sku === 'string' ? body.sku : undefined;

    const result = await verifyDatasetCheckoutSession(sessionId, sku);

    if (!result.ok) {
      const errRes = result as { ok: false; paid: boolean; sku?: string; customer_email?: string | null; amount_total?: number | null; error: string; status: number };
      return NextResponse.json(
        {
          ok: false,
          paid: errRes.paid,
          sku: errRes.sku,
          customer_email: errRes.customer_email ?? null,
          amount_total: errRes.amount_total ?? null,
          error: errRes.error,
        },
        { status: errRes.status }
      );
    }

    return NextResponse.json({
      ok: true,
      paid: true,
      sku: result.sku,
      customer_email: result.customer_email,
      amount_total: result.amount_total,
    });
  } catch (err: unknown) {
    console.error('Dataset verification error:', err);
    const message = err instanceof Error ? err.message : 'Verification failed';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
