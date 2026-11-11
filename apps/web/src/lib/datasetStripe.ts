import Stripe from 'stripe';
import { DATASET_PRODUCTS } from '@/lib/datasetPurchases';

export const runtimeHint = 'nodejs' as const;

export type DatasetVerifyResult =
  | {
      ok: true;
      paid: true;
      sku: string;
      customer_email: string | null;
      amount_total: number | null;
    }
  | {
      ok: false;
      paid: boolean;
      sku?: string;
      customer_email?: string | null;
      amount_total?: number | null;
      error: string;
      status: number;
    };

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { typescript: true });
}

export function isValidCheckoutSessionId(sessionId: string): boolean {
  return (
    typeof sessionId === 'string' &&
    (sessionId.startsWith('cs_live_') || sessionId.startsWith('cs_test_'))
  );
}

function skuFromAmountTotal(amountTotal: number | null | undefined): string | null {
  if (amountTotal == null) return null;
  for (const product of Object.values(DATASET_PRODUCTS)) {
    if (product.priceCents === amountTotal) return product.sku;
  }
  return null;
}

function inferSkuFromSession(
  session: Stripe.Checkout.Session,
  requestedSku?: string
): { sku: string | null; matchedBy: string | null } {
  const metaSku =
    (session.metadata && typeof session.metadata.sku === 'string' && session.metadata.sku) ||
    null;
  if (metaSku && DATASET_PRODUCTS[metaSku]) {
    return { sku: metaSku, matchedBy: 'metadata.sku' };
  }

  const ref =
    typeof session.client_reference_id === 'string' ? session.client_reference_id : null;
  if (ref && DATASET_PRODUCTS[ref]) {
    return { sku: ref, matchedBy: 'client_reference_id' };
  }

  // Best-effort: payment_link id is not a SKU; use amount_total against known prices
  const fromAmount = skuFromAmountTotal(session.amount_total);
  if (fromAmount) {
    return { sku: fromAmount, matchedBy: 'amount_total' };
  }

  // Line items expand (best-effort product name / description containing sku)
  const lineItems = session.line_items?.data;
  if (lineItems && lineItems.length > 0) {
    for (const item of lineItems) {
      const desc = (item.description || '').toLowerCase();
      for (const sku of Object.keys(DATASET_PRODUCTS)) {
        if (desc.includes(sku.toLowerCase())) {
          return { sku, matchedBy: 'line_items.description' };
        }
      }
      const amount = item.amount_total ?? item.price?.unit_amount ?? null;
      const fromItem = skuFromAmountTotal(amount);
      if (fromItem) {
        return { sku: fromItem, matchedBy: 'line_items.amount' };
      }
    }
  }

  if (requestedSku && DATASET_PRODUCTS[requestedSku]) {
    const expected = DATASET_PRODUCTS[requestedSku].priceCents;
    if (session.amount_total === expected) {
      return { sku: requestedSku, matchedBy: 'requested_sku_amount_match' };
    }
  }

  return { sku: null, matchedBy: null };
}

/**
 * Retrieve a Checkout Session and confirm it is paid and maps to a known dataset SKU.
 */
export async function verifyDatasetCheckoutSession(
  sessionId: string,
  requestedSku?: string
): Promise<DatasetVerifyResult> {
  if (!isValidCheckoutSessionId(sessionId)) {
    return {
      ok: false,
      paid: false,
      error: 'Invalid Stripe checkout session ID (expected cs_live_ or cs_test_)',
      status: 400,
    };
  }

  const stripe = getStripe();
  if (!stripe) {
    return {
      ok: false,
      paid: false,
      error: 'Payment verification service unavailable',
      status: 503,
    };
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'line_items.data.price'],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to retrieve Stripe session';
    return { ok: false, paid: false, error: message, status: 400 };
  }

  if (session.payment_status !== 'paid') {
    return {
      ok: false,
      paid: false,
      sku: requestedSku,
      customer_email: session.customer_details?.email ?? null,
      amount_total: session.amount_total ?? null,
      error: 'Payment not completed or unverified',
      status: 402,
    };
  }

  const inferred = inferSkuFromSession(session, requestedSku);
  const email = session.customer_details?.email ?? null;
  const amountTotal = session.amount_total ?? null;

  // Paid + SKU resolution rules
  if (requestedSku) {
    if (!DATASET_PRODUCTS[requestedSku]) {
      return {
        ok: false,
        paid: true,
        sku: requestedSku,
        customer_email: email,
        amount_total: amountTotal,
        error: 'Unknown dataset SKU',
        status: 400,
      };
    }

    const requestedCents = DATASET_PRODUCTS[requestedSku].priceCents;
    const amountMatches = amountTotal === requestedCents;
    const metaMatches =
      session.metadata?.sku === requestedSku ||
      session.client_reference_id === requestedSku ||
      inferred.sku === requestedSku;

    if (metaMatches || amountMatches) {
      return {
        ok: true,
        paid: true,
        sku: requestedSku,
        customer_email: email,
        amount_total: amountTotal,
      };
    }

    // Inferred a different sku and cannot reconcile → 403
    if (inferred.sku && inferred.sku !== requestedSku) {
      return {
        ok: false,
        paid: true,
        sku: inferred.sku,
        customer_email: email,
        amount_total: amountTotal,
        error: `SKU mismatch: session maps to ${inferred.sku}, requested ${requestedSku}`,
        status: 403,
      };
    }

    return {
      ok: false,
      paid: true,
      sku: requestedSku,
      customer_email: email,
      amount_total: amountTotal,
      error: 'Unable to confirm SKU for paid session',
      status: 403,
    };
  }

  // No requested SKU: use inferred or default carefully
  const sku = inferred.sku;
  if (!sku) {
    return {
      ok: false,
      paid: true,
      customer_email: email,
      amount_total: amountTotal,
      error: 'Paid session but could not map to a dataset SKU',
      status: 403,
    };
  }

  return {
    ok: true,
    paid: true,
    sku,
    customer_email: email,
    amount_total: amountTotal,
  };
}
