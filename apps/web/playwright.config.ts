import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config — chromium only, fully self-mocking.
 *
 * The suite runs against `next dev` (or `next start` after `next build`)
 * WITHOUT real Azure / Stripe / Firebase keys:
 *   - All engine traffic is intercepted at the browser boundary with
 *     `page.route` (see e2e/fixtures/mockEngine.ts) — no ENGINE_URL needed.
 *   - Firebase Auth REST endpoints (identitytoolkit.googleapis.com) are
 *     route-mocked, so no NEXT_PUBLIC_FIREBASE_* keys are required.
 *   - Stripe checkout is never hit; billing specs mock /api/billing/balance.
 *
 * Env overrides:
 *   BASE_URL            — point at an already-running server (skips webServer).
 *   E2E_USE_BUILD=1     — use `next start` (requires a prior `next build`)
 *                         instead of `next dev` for the managed webServer.
 *   E2E_PORT            — managed server port (default 3100).
 *   CI=1                — retries + serial workers (standard Playwright).
 *
 * The managed server sets RATE_LIMIT_ENABLED=false (edge middleware anonymous
 * tier would otherwise throttle the suite) and dummy-but-well-formed
 * NEXT_PUBLIC_FIREBASE_* values so lib/firebase.ts initializes — every
 * Firebase network call is intercepted by page.route.
 */

const PORT = Number(process.env.E2E_PORT || 3100);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const useBuild = process.env.E2E_USE_BUILD === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: useBuild ? 'npm run start' : 'npm run dev',
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: {
          PORT: String(PORT),
          RATE_LIMIT_ENABLED: 'false',
          NEXT_PUBLIC_FIREBASE_API_KEY: 'e2e-fake-api-key',
          NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'e2e-fake.firebaseapp.com',
          NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'e2e-fake-project',
          NEXT_PUBLIC_FIREBASE_APP_ID: '1:000000000000:web:e2efake',
        },
      },
});
