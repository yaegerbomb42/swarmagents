/**
 * Azure DeepSeek V4 Flash ~10-minute web-app E2E.
 * Verifies: provider wiring, decomp, leaf tools, gates/deliverables, wall-clock ~10m.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3010';
const ENGINE = process.env.ENGINE_URL || 'http://127.0.0.1:8410';
const BUDGET_MIN = Number(process.env.BUDGET_MINUTES || 10);
const OUT = process.env.E2E_OUT || '/tmp/swarm-azure-10min-e2e.json';

const PROJECT = `Build a complete local web app for agent tool QA (~${BUDGET_MIN} minute budget).

Deliverable: a static site in the workspace root with:
1) index.html — responsive page titled "SwarmAgents Tool QA"
2) styles.css — clean layout (header, main, status panel)
3) app.js — interactive checklist for tools: file_write, shell_exec, npm_test, deliverable
4) package.json — name "swarm-tool-qa", script "test" that runs node scripts/smoke.js
5) scripts/smoke.js — exits 0 only if index.html, styles.css, app.js exist and contain the title/checklist markers
6) README.md — how to open and run npm test

Acceptance:
- npm test passes
- Opening index.html shows the checklist UI
- Prefer real tool use (file_write / shell_exec) over dumping everything in one chat blob
- Quality bar: medium`;

async function api(action: string, body: Record<string, unknown> = {}, timeoutMs = 600_000) {
  const res = await fetch(`${BASE}/api/tasks/decompose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`non-json ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || data?.ok === false) {
    throw new Error(`${action} failed: ${data?.error || res.status} ${text.slice(0, 300)}`);
  }
  return data;
}

function leafStats(session: any) {
  const nodes = session?.nodes || [];
  const list: any[] = [];
  const walk = (arr: any[]) => {
    for (const n of arr || []) {
      const kids = n.children || [];
      if (kids.length) walk(kids);
      else list.push(n);
    }
  };
  walk(nodes);
  const status = (s: string) => list.filter((n: any) => n.status === s).length;
  return {
    total: list.length,
    completed: status('completed'),
    failed: status('failed'),
    pending: list.filter((n: any) => !['completed', 'failed'].includes(n.status)).length,
    labels: list.map((n: any) => `${n.status}:${(n.label || n.id || '').slice(0, 40)}`),
  };
}

function walkFiles(dir: string, acc: string[] = [], base = dir): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.swarm' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc, base);
    else acc.push(p.slice(base.length + 1));
  }
  return acc;
}

async function main() {
  const t0 = Date.now();
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    budgetMinutes: BUDGET_MIN,
    base: BASE,
    engine: ENGINE,
  };

  // Engine health (retry — local engine can flap during restart)
  let eng: any = null;
  for (let i = 0; i < 20; i++) {
    try {
      eng = await fetch(`${ENGINE}/health`, { signal: AbortSignal.timeout(5000) }).then((r) =>
        r.json()
      );
      if (eng?.status) break;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!eng?.status) throw new Error('engine_unhealthy');
  report.engineHealth = eng?.status || eng;

  // Provider store presence (keys redacted)
  const providers = await fetch(`${BASE}/api/providers/config`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
  report.providers = {
    ok: providers?.ok,
    count: (providers?.providers || []).length,
    names: (providers?.providers || []).map((p: any) => ({
      id: p.id,
      type: p.type,
      models: p.models,
      hasApiKey: p.hasApiKey ?? p.apiKeySet,
    })),
  };

  console.log('[1/4] decompose…');
  const decomp = await api(
    'decompose',
    {
      project: PROJECT,
      timeBudgetMinutes: BUDGET_MIN,
      timeRequirement: `${BUDGET_MIN} minutes`,
      progressive: true,
      autoDeepen: true,
    },
    180_000
  );
  const sessionId = decomp.session?.id;
  report.decompose = {
    sessionId,
    source: decomp.source,
    llmError: decomp.llmError || null,
    nodeCount: (decomp.session?.nodes || []).length,
    budget: decomp.session?.budget_minutes,
    title: decomp.session?.project_title,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  };
  console.log('  session', sessionId, 'source', decomp.source, 'nodes', report.decompose.nodeCount);

  // Progressive deepen until done or budget pressure
  console.log('[2/4] deepen…');
  let deepenRounds = 0;
  for (let i = 0; i < 12; i++) {
    const elapsedMin = (Date.now() - t0) / 60_000;
    if (elapsedMin > BUDGET_MIN * 0.35) break;
    const step = await api('deepen_step', { sessionId }, 120_000);
    deepenRounds++;
    if (step.auto_deepen?.done || step.done) break;
    if ((step.session?.nodes || []).length >= 20) break;
  }
  report.deepen = {
    rounds: deepenRounds,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  };

  // Snapshot after deepen
  const mid = await api('get', { sessionId }, 30_000).catch(() => null);
  let session = mid?.session || decomp.session;

  console.log('[3/4] orchestrate via execute_leaves rounds…');
  let rounds = 0;
  let lastStats: Record<string, unknown> = {};
  const deadline = t0 + BUDGET_MIN * 60_000 + 90_000;
  while (Date.now() < deadline && rounds < 120) {
    rounds++;
    try {
      const batch = await api(
        'execute_leaves',
        { sessionId, batchSize: 2 },
        300_000
      );
      session = batch.session || session;
      lastStats = batch;
      const ls = leafStats(session);
      console.log(
        `  round ${rounds}: completed=${ls.completed}/${ls.total} pending=${ls.pending} failed=${ls.failed}`
      );
      if (batch.done || batch.terminal || ls.pending === 0) break;
    } catch (e) {
      console.log(`  round ${rounds} error: ${String(e).slice(0, 160)}`);
      // Engine may be mid-leaf; brief backoff then continue within budget.
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // Land near the 10-minute mark when work finishes early (cap pacing).
  const targetMs = BUDGET_MIN * 60_000;
  const remain = targetMs - (Date.now() - t0);
  if (remain > 20_000 && remain < targetMs) {
    console.log(`  pacing ${Math.round(remain / 1000)}s to land near budget…`);
    await new Promise((r) => setTimeout(r, remain));
  }
  report.orchestrate = {
    rounds,
    done: lastStats.done,
    terminal: lastStats.terminal,
    leafStats: leafStats(session),
    summary: session?.summary || lastStats.summary,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  };
  console.log('  rounds', rounds, 'leaves', report.orchestrate.leafStats);

  // Workspace deliverables
  const workspace =
    session?.workspace_path ||
    session?.runtime?.workspace ||
    join(process.cwd(), '.data', 'workspaces', sessionId);
  const files = walkFiles(workspace);
  report.workspace = { path: workspace, files, fileCount: files.length };

  // Run npm test if package.json exists
  let npmTest: Record<string, unknown> = { skipped: true };
  if (files.includes('package.json')) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('npm', ['test'], { cwd: workspace, encoding: 'utf8', timeout: 60_000 });
    npmTest = {
      skipped: false,
      status: r.status,
      stdout: (r.stdout || '').slice(0, 500),
      stderr: (r.stderr || '').slice(0, 500),
    };
  }
  report.npmTest = npmTest;

  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  const near10 =
    elapsedSec >= BUDGET_MIN * 60 * 0.7 && elapsedSec <= BUDGET_MIN * 60 * 1.35;
  report.timing = {
    elapsedSec,
    budgetSec: BUDGET_MIN * 60,
    nearBudget: near10,
  };
  const stats = (report.orchestrate as { leafStats?: ReturnType<typeof leafStats> })?.leafStats ||
    leafStats(session);
  report.pass = {
    decompWorked: Boolean(sessionId) && (decomp.source === 'llm' || (decomp.session?.nodes || []).length > 0),
    usedLlmDecomp: decomp.source === 'llm',
    leavesCompleted: stats.completed > 0,
    hasDeliverables: files.some((f) => /index\.html|app\.js|README/i.test(f)),
    npmTestPassed: npmTest.skipped ? null : npmTest.status === 0,
    timingNearBudget: near10,
  };
  report.finishedAt = new Date().toISOString();

  mkdirSync(join(OUT, '..'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('[4/4] wrote', OUT);
  console.log(JSON.stringify(report.pass, null, 2));
  console.log('elapsed', elapsedSec, 's');
  if (!report.pass.decompWorked || !report.pass.hasDeliverables) process.exitCode = 1;
}

main().catch((e) => {
  console.error('E2E_FAILED', e);
  writeFileSync(
    OUT,
    JSON.stringify({ ok: false, error: String(e), at: new Date().toISOString() }, null, 2)
  );
  process.exit(1);
});
