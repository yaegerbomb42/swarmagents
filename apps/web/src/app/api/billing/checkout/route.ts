import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { requireAuth } from '@/lib/serverAuth';
import { getPlan } from '@/lib/plans';
import { getPack } from '@/lib/modelPricing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const stripe = () =>
  new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    typescript: true,
  });

/**
 * POST /api/billing/checkout
 * Body:
 *   - { plan: 'pro'|'team', interval?: 'month'|'year' }  -> subscription checkout
 *   - { pack_id: 'starter'|'pro'|'team' }                 -> one-time credit pack (legacy overage top-up)
 *
 * Returns: { url } — Stripe Checkout Session URL to redirect to.
 * Auth: requires Bearer token. user_id resolved server-side from token — never trust client.
 */
export async function POST(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth.ok === false) return auth.response;

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { error: 'Stripe not configured', code: 'stripe_missing' },
      { status: 503 }
    );
  }

  let body: { plan?: string; interval?: 'month' | 'year'; pack_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON', code: 'bad_body' }, { status: 400 });
  }

  // Resolve user_id from the Bearer token via engine.
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
    console.error('checkout: auth/me lookup failed', err);
  }
  if (!userId) {
    return NextResponse.json(
      { error: 'Could not resolve authenticated user', code: 'user_resolution_failed' },
      { status: 401 }
    );
  }

  // ---------------- Subscription flow (plans) ----------------
  if (body.plan) {
    if (body.plan !== 'pro' && body.plan !== 'team') {
      return NextResponse.json(
        { error: 'plan must be pro or team (free/enterprise have no checkout)', code: 'bad_plan' },
        { status: 400 }
      );
    }
    const interval: 'month' | 'year' = body.interval === 'year' ? 'year' : 'month';
    const plan = getPlan(body.plan);
    const envName = interval === 'year' ? plan.stripeAnnualEnv : plan.stripeMonthlyEnv;
    const priceId = envName ? process.env[envName] : undefined;
    if (!priceId) {
      return NextResponse.json(
        {
          error: `Stripe price missing: set env ${envName}`,
          code: 'price_missing',
          detail: envName,
        },
        { status: 503 }
      );
    }

    try {
      const session = await stripe().checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: {
          user_id: userId,
          plan: body.plan,
          interval,
        },
        success_url: `${request.nextUrl.origin}/settings?plan_success=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${request.nextUrl.origin}/pricing?cancelled=1`,
        allow_promotion_codes: true,
        billing_address_collection: 'required', // invoices
        customer_email: undefined, // Stripe fetches via customer create
      });

      if (!session.url) {
        return NextResponse.json(
          { error: 'Stripe returned no checkout URL', code: 'checkout_failed' },
          { status: 502 }
        );
      }
      return NextResponse.json({ url: session.url, session_id: session.id });
    } catch (err) {
      console.error('checkout: stripe subscription error', err);
      return NextResponse.json(
        {
          error: 'Stripe error',
          code: 'stripe_error',
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 502 }
      );
    }
  }

  // ---------------- One-time pack flow (credit top-up) ----------------
  const packId = body.pack_id;
  if (!packId) {
    return NextResponse.json(
      { error: 'plan or pack_id required', code: 'bad_input' },
      { status: 400 }
    );
  }
  let pack;
  try {
    pack = getPack(packId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown pack', code: 'bad_pack' },
      { status: 400 }
    );
  }

  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: pack.usdCents,
            product_data: {
              name: `${pack.label} Credit Pack — SwarmAgents`,
              description: `${pack.credits.toLocaleString()} credits (1 credit = $0.001)${pack.bonusLabel ? ` — ${pack.bonusLabel}` : ''}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        user_id: userId,
        pack_id: pack.packId,
        credits: String(pack.credits),
      },
      success_url: `${request.nextUrl.origin}/settings?credits_success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${request.nextUrl.origin}/pricing?cancelled=1`,
    });

    if (!session.url) {
      return NextResponse.json(
        { error: 'Stripe returned no checkout URL', code: 'checkout_failed' },
        { status: 502 }
      );
    }
    return NextResponse.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('checkout: stripe pack error', err);
    return NextResponse.json(
      {
        error: 'Stripe error',
        code: 'stripe_error',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}
