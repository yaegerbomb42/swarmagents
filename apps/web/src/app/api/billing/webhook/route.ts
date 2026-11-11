import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getEngineBillingClient } from '@/lib/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/webhook
 * Handles:
 *   - checkout.session.completed (credit packs one-time; parent of subscription signup)
 *   - customer.subscription.created / .updated / .deleted (plan tier mirror)
 *   - invoice.payment_succeeded (subscription renewal → grant monthly credits)
 *
 * Idempotency:
 *   - Credit grant keyed on stripe_session_id (or invoice id): duplicate handler calls no-op.
 *   - Subscription upsert is keyed on stripe_subscription_id — last write wins for status.
 *
 * Auth: Stripe signature via STRIPE_WEBHOOK_SECRET. No user JWT.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !whSecret) {
    return NextResponse.json(
      { error: 'Stripe webhook not configured', code: 'webhook_unconfigured' },
      { status: 503 }
    );
  }

  const stripe = new Stripe(secret, { typescript: true });

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature', code: 'no_sig' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, whSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid signature';
    console.error('webhook: signature verification failed', msg);
    return NextResponse.json({ error: msg, code: 'invalid_signature' }, { status: 400 });
  }

  const engine = getEngineBillingClient();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      // If this checkout was for a subscription, we'll get a follow-up
      // customer.subscription.created with full metadata — skip credit grant here.
      if (session.mode === 'subscription') {
        return NextResponse.json({ received: true, mode: 'subscription' });
      }
      // Otherwise it's a one-time credit pack purchase.
      const userId = session.metadata?.user_id;
      const packId = session.metadata?.pack_id;
      const creditsStr = session.metadata?.credits;
      if (!userId || !packId || !creditsStr) {
        console.error('webhook: missing metadata on session', session.id);
        return NextResponse.json(
          { error: 'Session missing required metadata', code: 'bad_metadata' },
          { status: 400 }
        );
      }
      const credits = Number(creditsStr);
      if (!Number.isFinite(credits) || credits <= 0) {
        return NextResponse.json(
          { error: 'Invalid credits metadata', code: 'bad_credits' },
          { status: 400 }
        );
      }
      const r = await engine.creditPurchase({
        userId,
        packId,
        credits,
        stripeSessionId: session.id,
      });
      if (!r.ok) {
        console.error('webhook: engine credit-purchase failed', r.error);
        return NextResponse.json(
          { error: 'Credit grant failed', code: 'engine_error', detail: r.error },
          { status: 500 }
        );
      }
      return NextResponse.json({
        received: true,
        session_id: session.id,
        duplicate: r.duplicate === true,
        balance_after: r.balance_after,
      });
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = (sub.metadata as Record<string, unknown>)?.user_id as string | undefined;
      // For checkout-started subs the metadata lives on the session; mirror from
      // subscription items on the plan radio. user_id should be on the sub, but
      // fall back to fetching customer if absent.
      let resolvedUserId = userId;
      if (!resolvedUserId && typeof sub.customer === 'string') {
        try {
          const customer = await stripe.customers.retrieve(sub.customer);
          if (!('deleted' in customer) && customer.metadata?.user_id) {
            resolvedUserId = customer.metadata.user_id as string;
          }
        } catch (err) {
          console.error('webhook: customer fetch failed', err);
        }
      }
      if (!resolvedUserId) {
        console.warn('webhook: subscription without resolvable user_id', sub.id);
        return NextResponse.json({ received: true, ignored: 'no_user' });
      }

      // Map Stripe price back to plan tier via env lookup.
      const planMeta = sub.metadata?.plan as string | undefined;
      const tier = planMeta === 'team' ? 'team' : planMeta === 'pro' ? 'pro' : 'free';
      const intervalMeta = (sub.metadata?.interval as string) || 'month';
      const status =
        event.type === 'customer.subscription.deleted' ? 'canceled' : (sub.status as string);

      const r = await engine.upsertPlan({
        userId: resolvedUserId,
        tier,
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : undefined,
        stripeSubscriptionId: sub.id,
        status,
        interval: intervalMeta === 'year' ? 'year' : 'month',
        currentPeriodEndUnix: (sub as any).current_period_end ?? null,
      });
      if (!r.ok) {
        console.error('webhook: upsert plan failed', r.error);
        return NextResponse.json(
          { error: 'Plan upsert failed', code: 'engine_error', detail: r.error },
          { status: 500 }
        );
      }
      return NextResponse.json({ received: true, tier, status });
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      // For subscriptions (billing_reason = subscription_create|subscription_cycle)
      // grant the plan's monthly credits once per invoice. For one-time invoices
      // (overage metered), engine tracks them separately.
      const billingReason = (invoice as any).billing_reason as string | undefined;
      if (!billingReason || !billingReason.startsWith('subscription')) {
        return NextResponse.json({ received: true, ignored: billingReason });
      }
      const subId = (invoice as any).subscription as string | undefined;
      if (!subId) {
        return NextResponse.json({ received: true, ignored: 'no_subscription' });
      }

      const r = await engine.planRenewalGrant({
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: subId,
      });
      if (!r.ok) {
        console.error('webhook: plan renewal grant failed', r.error);
        return NextResponse.json(
          { error: 'Renewal grant failed', code: 'engine_error', detail: r.error },
          { status: 500 }
        );
      }
      return NextResponse.json({
        received: true,
        invoice_id: invoice.id,
        credits_granted: r.credits_granted,
        duplicate: r.duplicate === true,
      });
    }

    default:
      return NextResponse.json({ received: true, ignored: event.type });
  }
}
