import { test, expect } from '@playwright/test';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Team panel, end to end.
 *
 * No LLM, no engine: the run is served by a local SSE server and POST /api/team
 * is route-mocked. The point of the spec is the real browser path — mode toggle
 * → dispatch → live plan ticks → lane status → take over.
 */

const RUN_ID = 'team-e2e-1';
const SHOTS = path.join(__dirname, 'screenshots');

type Run = Record<string, any>;

const lane = (over: Partial<Run>): Run => ({
  agentId: 'a1',
  kind: 'worker',
  roleId: 'implementer',
  roleName: 'Implementer',
  glyph: 'I',
  color: 'from-emerald-400 to-teal-500',
  taskId: 't1',
  taskTitle: 'Design the schema',
  status: 'queued',
  currentAction: 'Queued',
  provider: 'Groq',
  model: 'llama-3.3-70b',
  worktree: `${RUN_ID}/a1`,
  attempts: 0,
  tokens: 0,
  costUsd: 0,
  startedAt: null,
  finishedAt: null,
  takenOver: false,
  lastNote: null,
  ...over,
});

const planItem = (id: string, title: string, roleId: string, agentId: string, status: string): Run => ({
  id,
  title,
  detail: '',
  roleId,
  agentId,
  status,
});

function run(over: Partial<Run> = {}): Run {
  return {
    runId: RUN_ID,
    goal: 'Build the onboarding flow',
    status: 'planning',
    createdAt: 1,
    updatedAt: 1,
    plan: [],
    agents: [],
    budget: { tokenCap: 120_000, tokensUsed: 0, costCapUsd: 2, costUsedUsd: 0 },
    concurrency: { limit: 3, active: 0 },
    mergedFiles: [],
    error: null,
    rotationCursor: 0,
    userId: 'local',
    ...over,
  };
}

const planner = lane({
  agentId: 'planner',
  kind: 'planner',
  roleId: 'planner',
  roleName: 'Planner',
  glyph: 'P',
  color: 'from-cyan-400 to-sky-500',
  taskId: null,
  taskTitle: null,
  status: 'running',
  currentAction: 'Drafting the plan…',
  worktree: 'team',
});

const frame0 = run({ agents: [planner] });

const frame1 = run({
  status: 'running',
  plan: [
    planItem('t1', 'Design the schema', 'architect', 'a1', 'pending'),
    planItem('t2', 'Write the endpoints', 'implementer', 'a2', 'pending'),
    planItem('t3', 'Test the flow', 'qa-engineer', 'a3', 'pending'),
  ],
  agents: [
    { ...planner, status: 'merged', currentAction: 'Plan ready — 3 tasks', finishedAt: 2 },
    lane({ agentId: 'a1', status: 'running', currentAction: 'Writing schema…' }),
    lane({ agentId: 'a2', roleId: 'implementer', roleName: 'Implementer', taskId: 't2', taskTitle: 'Write the endpoints', status: 'running', currentAction: 'Writing endpoints…' }),
    lane({ agentId: 'a3', roleId: 'qa-engineer', roleName: 'QA Engineer', taskId: 't3', taskTitle: 'Test the flow', status: 'running', currentAction: 'Writing tests…' }),
    lane({ agentId: 'reviewer', kind: 'reviewer', roleId: 'reviewer', roleName: 'Reviewer', glyph: 'R', taskId: null, taskTitle: null, status: 'queued', currentAction: 'Waiting for results', worktree: 'team/review' }),
  ],
  concurrency: { limit: 3, active: 3 },
  budget: { tokenCap: 120_000, tokensUsed: 900, costCapUsd: 2, costUsedUsd: 0.0004 },
  rotationCursor: 3,
});

const frame2 = run({
  ...frame1,
  status: 'reviewing',
  plan: [
    planItem('t1', 'Design the schema', 'architect', 'a1', 'merged'),
    planItem('t2', 'Write the endpoints', 'implementer', 'a2', 'rework'),
    planItem('t3', 'Test the flow', 'qa-engineer', 'a3', 'active'),
  ],
  agents: frame1.agents.map((a: Run) => {
    if (a.agentId === 'a1') return { ...a, status: 'merged', currentAction: 'Merged', finishedAt: 3, tokens: 900, costUsd: 0.0004 };
    if (a.agentId === 'a2') return { ...a, status: 'rework', currentAction: 'Fixing review feedback…', attempts: 1, lastNote: 'add the missing test', tokens: 2000, costUsd: 0.0012 };
    if (a.agentId === 'reviewer') return { ...a, status: 'running', currentAction: 'Reviewing Write the endpoints' };
    return a;
  }),
  mergedFiles: ['/workspace/team/team-e2e-1/merged/t1.md'],
  budget: { tokenCap: 120_000, tokensUsed: 2400, costCapUsd: 2, costUsedUsd: 0.0012 },
  concurrency: { limit: 3, active: 2 },
});

const frame3 = run({
  ...frame2,
  status: 'completed',
  plan: frame2.plan.map((t: Run) => ({ ...t, status: 'merged' })),
  agents: frame2.agents.map((a: Run) =>
    a.agentId === 'reviewer'
      ? { ...a, status: 'merged', currentAction: 'All lanes merged', finishedAt: 5 }
      : { ...a, status: 'merged', currentAction: 'Merged', finishedAt: a.agentId === 'a2' ? 5 : a.finishedAt, attempts: a.agentId === 'a2' ? 2 : a.attempts },
  ),
  mergedFiles: [
    '/workspace/team/team-e2e-1/merged/t1.md',
    '/workspace/team/team-e2e-1/merged/t2.md',
    '/workspace/team/team-e2e-1/merged/t3.md',
  ],
  budget: { tokenCap: 120_000, tokensUsed: 4800, costCapUsd: 2, costUsedUsd: 0.0024 },
  concurrency: { limit: 3, active: 0 },
});

let sse: http.ServerResponse | null = null;
let server: http.Server;
let baseUrl = '';
/** How many scripted frames this connection should receive (0 = snapshot only). */
let holdAt = 3;

const broadcast = (next: Run) => {
  sse?.write(`data: ${JSON.stringify({ op: 'run', run: next })}\n\n`);
};

test.beforeAll(async () => {
  await fs.mkdir(SHOTS, { recursive: true });
  server = http.createServer((req, res) => {
    if (req.url !== '/stream') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    sse = res;
    const send = (r: Run, index: number) => {
      if (index <= holdAt) res.write(`data: ${JSON.stringify({ op: 'snapshot', run: r })}\n\n`);
    };
    send(frame0, 0);
    setTimeout(() => send(frame1, 1), 250);
    setTimeout(() => send(frame2, 2), 900);
    setTimeout(() => send(frame3, 3), 1500);
    req.on('close', () => {
      if (sse === res) sse = null;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.beforeEach(async ({ page }) => {
  await page.route('**/api/team', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ json: { ok: true, runId: RUN_ID, run: frame0 } });
  });
  await page.route(`**/api/team/${RUN_ID}/takeover`, async (route) => {
    const body = JSON.parse(route.request().postData() || '{}') as { agentId?: string };
    const next = JSON.parse(JSON.stringify(frame2)) as Run;
    const lane = next.agents.find((a: Run) => a.agentId === body.agentId);
    if (lane) {
      lane.takenOver = true;
      lane.status = 'paused';
      lane.currentAction = 'You have the controls';
    }
    broadcast(next);
    await route.fulfill({ json: { ok: true, run: next } });
  });
  await page.route(`**/api/team/${RUN_ID}`, (route) =>
    route.continue({ url: `${baseUrl}/stream` }),
  );
});

async function dispatch(page: import('@playwright/test').Page, goal: string) {
  await page.goto('/');
  await page.getByTestId('mode-team').click();
  await page.getByRole('textbox', { name: 'Mission prompt' }).fill(goal);
  await page.getByRole('button', { name: 'Dispatch mission' }).click();
  await expect(page.getByTestId('team-panel')).toBeVisible();
}

test('team panel: 3-task plan ticks off and the final merge lands', async ({ page }) => {
  holdAt = 3;
  await dispatch(page, 'Build the onboarding flow');

  await expect(page.getByTestId('team-plan')).toBeVisible();
  await expect(page.getByTestId('team-plan-t1')).toHaveAttribute('data-status', 'merged', { timeout: 8000 });
  await expect(page.getByTestId('team-plan-t2')).toHaveAttribute('data-status', 'merged', { timeout: 8000 });
  await expect(page.getByTestId('team-plan-t3')).toHaveAttribute('data-status', 'merged', { timeout: 8000 });

  // One lane per role: planner + 3 workers + reviewer.
  await expect(page.getByTestId('team-lanes').getByRole('article')).toHaveCount(5);
  await expect(page.getByTestId('team-lane-planner')).toBeVisible();
  await expect(page.getByTestId('team-lane-a2')).toHaveAttribute('data-status', 'merged');
  await expect(page.getByTestId('team-run-status')).toHaveText('Merged');
  await expect(page.getByTestId('team-merged-count')).toHaveText('3/3');
  await expect(page.getByTestId('team-lane-cost-a2')).not.toHaveText('$0');

  await page.screenshot({ path: path.join(SHOTS, 'team-panel-merged.png'), fullPage: true });
});

test('team panel: take over a lane mid-run', async ({ page }) => {
  holdAt = 2;
  await dispatch(page, 'Build the onboarding flow');

  await expect(page.getByTestId('team-plan-t1')).toHaveAttribute('data-status', 'merged', { timeout: 8000 });
  await expect(page.getByTestId('team-lane-a3')).toHaveAttribute('data-status', 'running');

  await page.screenshot({ path: path.join(SHOTS, 'team-panel-live.png'), fullPage: true });

  await page.getByRole('button', { name: 'Take over QA Engineer' }).click();
  await expect(page.getByTestId('team-lane-a3')).toHaveAttribute('data-status', 'paused', { timeout: 8000 });
  await expect(page.getByTestId('team-lane-action-a3')).toHaveText('You have the controls');
  await expect(page.getByTestId('team-run-status')).toHaveText('Reviewing');

  await page.screenshot({ path: path.join(SHOTS, 'team-panel-takeover.png'), fullPage: true });
});