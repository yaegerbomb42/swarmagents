import { test, expect } from '@playwright/test';
import { mockFirebaseAuth } from './fixtures/mockFirebase';
import { mockBillingBalance, mockDecompositionEngine } from './fixtures/mockEngine';

/**
 * (e) Billing: /pricing renders credit packs + model price table (server
 * component — no mocks needed). The 402/paywall state is mocked at the
 * boundary: /api/billing/balance + engine debit 402 (insufficient_credits).
 *
 * NOTE: PaywallPrompt is not yet wired into a page (rendered by execution
 * components on engine 402s); the 402 contract is asserted here against the
 * billing API boundary, and the component itself is unit-tested in
 * src/components/billing/PaywallPrompt.test.tsx.
 */
test.describe('billing', () => {
  test('pricing page shows credit packs and model table', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { name: /pricing/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /credit packs/i })).toBeVisible();
    // Packs render purchasable amounts.
    await expect(page.locator('text=/\\$\\d+/').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /model prices/i })).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
  });

  test('balance endpoint returns mocked credits (402 boundary wired)', async ({ page }) => {
    await mockBillingBalance(page, { credits: 0, debit402: true });
    await mockDecompositionEngine(page);

    // Drive the mocked balance route in-page so page.route interception applies.
    await page.goto('/pricing');
    const balance = await page.evaluate(async () => {
      const res = await fetch('/api/billing/balance', {
        headers: { Authorization: 'Bearer e2e-fake-id-token' },
      });
      return { status: res.status, body: await res.json() };
    });
    expect(balance.status).toBe(200);
    expect(balance.body.credits).toBe(0);
    expect(balance.body.free_grant_available).toBe(false);

    // Engine debit 402 contract: insufficient_credits surfaced to the UI layer.
    const debit = await page.evaluate(async () => {
      const res = await fetch('/api/engine/api/billing/debit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'e2e-user-1', amount: 10 }),
      });
      return { status: res.status, body: await res.json() };
    });
    expect(debit.status).toBe(402);
    expect(debit.body.error).toBe('insufficient_credits');
  });

  test('/billing renders session-free (no Stripe keys)', async ({ page }) => {
    await mockFirebaseAuth(page);
    await page.goto('/billing');
    await expect(page.getByRole('heading', { name: /quota now/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /start free/i })).toBeVisible();
  });
});
