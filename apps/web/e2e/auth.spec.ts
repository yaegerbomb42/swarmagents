import { test, expect } from '@playwright/test';
import { mockFirebaseAuth, E2E_ID_TOKEN } from './fixtures/mockFirebase';
import { mockDecompositionEngine } from './fixtures/mockEngine';

/**
 * (b) Login renders; full auth flow runs against route-mocked Firebase
 * Identity Toolkit + engine /auth/provision. No real Firebase credentials —
 * playwright.config.ts injects dummy NEXT_PUBLIC_FIREBASE_* values and every
 * network call the SDK makes is intercepted.
 */
test.describe('auth', () => {
  test.beforeEach(async ({ page }) => {
    await mockFirebaseAuth(page);
    await mockDecompositionEngine(page);
    // Fail fast if any unmocked Google auth endpoint slips through.
    await page.route('**/identitytoolkit.googleapis.com/**', (route) => {
      const url = route.request().url();
      if (
        url.includes('signInWithPassword') ||
        url.includes('accounts:lookup') ||
        url.includes('recaptchaConfig')
      ) {
        return route.fallback();
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
  });

  test('login page renders form', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /forgot password/i })).toBeVisible();
  });

  test('email/password login succeeds and redirects', async ({ page }) => {
    await page.goto('/login?next=/settings');
    await page.locator('input[type="email"]').fill('e2e@swarmagents.dev');
    await page.locator('input[type="password"]').fill('e2e-password-123');
    await page.locator('form button[type="submit"]').click();

    // Real Firebase SDK exchanges the mocked REST response for a session,
    // caches auth_token in localStorage, then LoginInner routes to `next`.
    await expect(page).toHaveURL(/\/settings/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('auth_token')), { timeout: 10_000 })
      .toBe(E2E_ID_TOKEN);
  });

  test('failed login surfaces error message', async ({ page }) => {
    await page.unroute('**/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword**');
    await page.route('**/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword**', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }),
      }),
    );

    await page.goto('/login');
    await page.locator('input[type="email"]').fill('nope@swarmagents.dev');
    await page.locator('input[type="password"]').fill('wrong-password-1');
    await page.locator('form button[type="submit"]').click();

    await expect(page.locator('text=/invalid|incorrect|failed/i').first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
