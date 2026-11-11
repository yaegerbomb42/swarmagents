import { test, expect } from '@playwright/test';
import { mockDecompositionEngine } from './fixtures/mockEngine';

/**
 * (c) Decompose flow: submit a goal → NeonTree renders. The engine is mocked
 * at the Next rewrite boundary (/api/engine/api/decomposition/*) with
 * page.route — no LLM keys, no engine process.
 *
 * NOTE: decompositionApi.getWebSocketUrl deliberately skips the socket when
 * no engine WS URL is configured (self-contained mode), so the mocked tree
 * renders immediately without WebSocket chatter.
 */
test.describe('decompose', () => {
  test.beforeEach(async ({ page }) => {
    await mockDecompositionEngine(page);
  });

  test('renders task input', async ({ page }) => {
    await page.goto('/decompose');
    await expect(page.getByPlaceholder(/describe the huge project/i)).toBeVisible();
  });

  test('submit goal → tree renders with nodes', async ({ page }) => {
    await page.goto('/decompose');
    await page.getByPlaceholder(/describe the huge project/i).fill('E2E goal: build a thing');

    await page.getByRole('button', { name: /create tree/i }).click();

    // createProject + initial tree fetch resolve → NeonTree mounts the SVG canvas.
    const canvas = page.locator('.neon-tree-container > svg');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    // Tree descriptions render in SVG <text> nodes (truncated at 20 chars).
    await expect(canvas.locator('text', { hasText: /E2E goal/i }).first()).toBeVisible();
    await expect(canvas).toContainText('Research phase');
    await expect(page.locator('text=engine exploded')).toHaveCount(0);
  });

  test('engine failure renders error panel', async ({ page }) => {
    await page.unroute('**/api/engine/api/decomposition/projects');
    await page.route('**/api/engine/api/decomposition/projects', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'engine exploded', detail: 'llm unavailable' }),
      }),
    );

    await page.goto('/decompose');
    await page.getByPlaceholder(/describe the huge project/i).fill('E2E goal: explode');
    await page.getByRole('button', { name: /create tree/i }).click();

    await expect(page.locator('text=/engine exploded|API request failed/i').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
