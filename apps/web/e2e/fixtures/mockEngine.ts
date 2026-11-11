import type { Page } from '@playwright/test';

/**
 * Route-mocks the engine boundary. The dashboard talks to the engine via
 * same-origin paths (`/api/engine/*`, rewritten to ENGINE_URL) and via
 * Next API routes (`/api/tasks/*`, `/api/billing/*`). Specs intercept at the
 * browser with page.route so the suite needs no running engine, no Azure
 * keys, and no Stripe keys.
 */

const NOW = new Date().toISOString();

export function makeTree(projectId = 'proj-e2e-1') {
  return {
    id: 'tree-e2e-1',
    tree_id: 'tree-e2e-1',
    project_id: projectId,
    root_node_id: 'root',
    root_description: 'E2E goal: build a thing',
    status: 'decomposing',
    nodes: {
      root: {
        id: 'root',
        tree_id: 'tree-e2e-1',
        parent_id: null,
        type: 'root',
        status: 'decomposing',
        description: 'E2E goal: build a thing',
        requirements: [],
        acceptance_criteria: [],
        time_budget: 60,
        actual_duration: 0,
        created_at: NOW,
        children: ['child-1', 'child-2'],
        metadata: { deliverable_type: 'document' },
      },
      'child-1': {
        id: 'child-1',
        tree_id: 'tree-e2e-1',
        parent_id: 'root',
        type: 'leaf',
        status: 'pending',
        description: 'Research phase',
        requirements: [],
        acceptance_criteria: [],
        time_budget: 20,
        actual_duration: 0,
        created_at: NOW,
        children: [],
        metadata: {},
      },
      'child-2': {
        id: 'child-2',
        tree_id: 'tree-e2e-1',
        parent_id: 'root',
        type: 'leaf',
        status: 'pending',
        description: 'Implementation phase',
        requirements: [],
        acceptance_criteria: [],
        time_budget: 40,
        actual_duration: 0,
        created_at: NOW,
        children: [],
        metadata: {},
      },
    },
    branches: [],
    created_at: NOW,
    started_at: null,
    completed_at: null,
    total_time_budget: 60,
    time_consumed: 0,
    total_nodes: 3,
    completed_nodes: 0,
    failed_nodes: 0,
    deliverable_type: 'document',
    deliverable_path: null,
    progress_percent: 0,
    metadata: {},
  };
}

/** Mock the decomposition engine endpoints used by lib/decompositionApi. */
export async function mockDecompositionEngine(page: Page): Promise<void> {
  await page.route('**/api/engine/api/decomposition/projects', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          project_id: 'proj-e2e-1',
          tree_id: 'tree-e2e-1',
          status: 'decomposing',
          message: 'created',
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.route('**/api/engine/api/decomposition/projects/*/tree', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeTree()),
    }),
  );

  // Engine auth provisioning (called after login/signup).
  await page.route('**/api/engine/auth/provision', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provisioned: true, free_credits: 500 }),
    }),
  );

  // Engine auth identity resolution used by /api/billing/balance.
  await page.route('**/api/engine/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e2e-user-1', email: 'e2e@swarmagents.dev' }),
    }),
  );
}

/** Mock the dashboard billing proxy routes. */
export async function mockBillingBalance(
  page: Page,
  opts: { credits?: number; debit402?: boolean } = {},
): Promise<void> {
  const { credits = 120, debit402 = false } = opts;

  await page.route('**/api/billing/balance', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user_id: 'e2e-user-1',
        credits,
        free_grant_used: true,
        free_grant_available: false,
      }),
    }),
  );

  if (debit402) {
    // Any engine debit attempt returns 402 Payment Required → paywall UX.
    await page.route('**/api/engine/api/billing/debit', (route) =>
      route.fulfill({
        status: 402,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'insufficient_credits',
          detail: 'Balance is 0 credits',
          required: 10,
          available: 0,
        }),
      }),
    );
  }
}
