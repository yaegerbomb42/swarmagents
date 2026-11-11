import { NextResponse } from 'next/server';
import { CREDIT_PACKS, MODEL_PRICES, CREDIT_USD, MARGIN_MULTIPLIER } from '@/lib/modelPricing';

export const runtime = 'nodejs';
export const dynamic = 'force-static';

/**
 * GET /api/billing/pricing
 * Public price table. No auth required.
 */
export async function GET() {
  return NextResponse.json({
    credit_usd: CREDIT_USD,
    margin_multiplier: MARGIN_MULTIPLIER,
    packs: CREDIT_PACKS,
    models: Object.values(MODEL_PRICES),
  });
}
