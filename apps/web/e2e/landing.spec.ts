import { test, expect } from '@playwright/test';

/**
 * (a) Landing page loads and top-nav routes resolve.
 * No mocks needed — the landing page is static marketing content.
 */
test.describe('landing', () => {
  test('loads with hero and brand', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/.+/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Header nav (scoped — the footer has duplicate links).
    const nav = page.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: /sign in/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /start building/i })).toBeVisible();
  });

  test('nav to login works', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation')
      .first()
      .getByRole('link', { name: /sign in/i })
      .click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  });

  test('nav to signup works', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation')
      .first()
      .getByRole('link', { name: /start building/i })
      .click();
    await expect(page).toHaveURL(/\/signup/);
  });
});
