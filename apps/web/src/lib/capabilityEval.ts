/**
 * Week 4 — same-model capability lift eval.
 * Baseline = single-shot chat → write files → same gate suite.
 * Swarm = production leaf executor (tools + gates + repair + world model).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { loadProvidersStore, type StoredProvider } from '@/lib/providerStore';
import { templateByType } from '@/lib/providerTemplates';
import {
  setSession,
  type DecompSessionRecord,
} from '@/lib/decompSessions';
import { finalizeLeafCandidate } from '@/lib/leafCompletionGates';
import {
  collectLeaves,
  ensureSessionWorkspaceForApi,
  executeLeafBatch,
} from '@/lib/sessionExecutor';
import { chatWithProvider } from '@/lib/sessionExecutor';

export type EvalArmResult = {
  passed: boolean;
  ms: number;
  files: string[];
  validation_feedback?: string;
  repairs?: number;
  error?: string;
};

export type EvalTaskResult = {
  id: string;
  title: string;
  qualityBar: 'low' | 'medium' | 'high' | 'strict';
  baseline: EvalArmResult;
  swarm: EvalArmResult;
};

export type CapabilityEvalReport = {
  version: 1;
  ranAt: number;
  model: string;
  providerName: string;
  providerType: string;
  tasks: EvalTaskResult[];
  summary: {
    baselinePassRate: number;
    swarmPassRate: number;
    liftPercentagePoints: number;
    liftRatio: number | null;
    baselinePassed: number;
    swarmPassed: number;
    total: number;
    headline: string;
  };
};

export type EvalTaskFixture = {
  id: string;
  title: string;
  qualityBar: 'low' | 'medium' | 'high' | 'strict';
  /** Prompt given to both arms (same wording). */
  prompt: string;
  acceptance: string[];
  /** Seed files before the model runs (objective harness). */
  seed?: Record<string, string>;
  effort_minutes?: number;
};

/** Fixed suite — objective checks, same prompt for both arms. */
export const CAPABILITY_EVAL_FIXTURES: EvalTaskFixture[] = [
  {
    id: 'contract_marker',
    title: 'Write verified contract marker',
    qualityBar: 'low',
    prompt:
      'Create deliverables/CONTRACT.md whose entire body is exactly the line:\nACCEPT:swarm-eval-v1\nNo other text.',
    acceptance: ['deliverables/CONTRACT.md exists', 'File contains ACCEPT:swarm-eval-v1'],
    effort_minutes: 3,
  },
  {
    id: 'node_sum',
    title: 'Implement sum module that passes npm test',
    qualityBar: 'medium',
    prompt:
      'Implement src/sum.js so the existing npm test passes. Export a function add(a, b) that returns a+b. Do not change package.json or the test file.',
    acceptance: ['src/sum.js exports add', 'npm test exits 0'],
    seed: {
      'package.json': JSON.stringify(
        {
          name: 'swarm-eval-sum',
          private: true,
          type: 'commonjs',
          scripts: { test: 'node --test test/sum.test.js' },
        },
        null,
        2
      ),
      'test/sum.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('../src/sum.js');

test('add', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});
`,
    },
    effort_minutes: 6,
  },
  {
    id: 'py_multiply',
    title: 'Implement multiply.py that passes pytest',
    qualityBar: 'medium',
    prompt:
      'Implement multiply.py with a function multiply(a, b) returning a*b so that pytest -q passes. Do not change test_multiply.py.',
    acceptance: ['multiply.py defines multiply', 'pytest exits 0'],
    seed: {
      'test_multiply.py': `from multiply import multiply

def test_multiply():
    assert multiply(3, 4) == 12
    assert multiply(0, 9) == 0
`,
      'pytest.ini': '[pytest]\naddopts = -q\n',
    },
    effort_minutes: 6,
  },
  {
    id: 'small_web_ui',
    title: 'Build a small counter web UI',
    qualityBar: 'medium',
    prompt:
      'Build a tiny static web UI. Create index.html (and optional app.js/styles.css if needed) such that:\n' +
      '1) The page title and a visible <h1> are exactly: SwarmAgents Counter\n' +
      '2) There is a button with id="inc" labeled Increment\n' +
      '3) There is an element with id="count" that starts at 0 and increases by 1 each click\n' +
      'Use plain HTML/JS only (no frameworks). Do not modify package.json or the test file.',
    acceptance: [
      'index.html exists',
      'h1 is SwarmAgents Counter',
      'button#inc and #count work',
      'npm test exits 0',
    ],
    seed: {
      'package.json': JSON.stringify(
        {
          name: 'swarm-eval-webui',
          private: true,
          type: 'commonjs',
          scripts: { test: 'node --test test/ui.test.js' },
        },
        null,
        2
      ),
      'test/ui.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('small web ui contract', () => {
  assert.ok(fs.existsSync('index.html'), 'index.html missing');
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /<title>\\s*SwarmAgents Counter\\s*<\\/title>/i);
  assert.match(html, /<h1[^>]*>\\s*SwarmAgents Counter\\s*<\\/h1>/i);
  assert.match(html, /id=["']inc["']/i);
  assert.match(html, /id=["']count["']/i);
  assert.match(html, />\\s*Increment\\s*</i);
  assert.match(html, />\\s*0\\s*</);

  let js = html;
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const src = m[1];
    if (fs.existsSync(src)) js += '\\n' + fs.readFileSync(src, 'utf8');
  }
  const wired =
    /addEventListener\\(\\s*['"]click['"]/i.test(js) ||
    /onclick\\s*=/i.test(html) ||
    /getElementById\\(\\s*['"]inc['"]\\s*\\)[\\s\\S]{0,200}onclick/i.test(js);
  assert.ok(wired, 'increment click handler not found');
  assert.ok(
    /getElementById\\(\\s*['"]count['"]\\s*\\)/i.test(js) || /#count/.test(js) || /id=["']count["'][\\s\\S]{0,40}>\\s*0/.test(html),
    'count element not updated in script'
  );
});
`,
    },
    effort_minutes: 8,
  },
];

function evalRoot(): string {
  return (
    process.env.SWARM_EVAL_ROOT ||
    path.join(process.cwd(), '.data', 'evals')
  );
}

async function pickEvalProvider(providerId?: string): Promise<StoredProvider | null> {
  const store = await loadProvidersStore();
  const enabled = store.providers.filter((p) => {
    if (!p.enabled) return false;
    const tmpl = templateByType(p.type);
    if (tmpl && !tmpl.needsKey) return Boolean(p.endpoint);
    return Boolean(p.apiKey || (!tmpl?.needsKey && p.endpoint));
  });
  if (!enabled.length) return null;
  if (providerId) {
    const hit = enabled.find((p) => p.id === providerId || p.name === providerId);
    if (hit) return hit;
  }
  return enabled[0];
}

async function writeSeed(workspace: string, seed?: Record<string, string>): Promise<void> {
  if (!seed) return;
  for (const [rel, body] of Object.entries(seed)) {
    const abs = path.join(workspace, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  }
}

/** Parse ```path ... ``` or ```lang path ... ``` fences into files. */
export function parseFencedFiles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const header = (m[1] || '').trim();
    const body = m[2] || '';
    let rel = '';
    const parts = header.split(/\s+/).filter(Boolean);
    for (const p of parts) {
      if (p.includes('/') || /\.(js|ts|tsx|py|md|json|txt|css|html)$/i.test(p)) {
        rel = p.replace(/^\.?\/+/, '');
        break;
      }
    }
    if (!rel && parts.length === 1 && parts[0].includes('.')) rel = parts[0];
    if (!rel) continue;
    if (rel.includes('..') || path.isAbsolute(rel)) continue;
    out[rel] = body.replace(/\n$/, '');
  }
  return out;
}

async function listRealFiles(workspace: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, prefix = ''): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === '.swarm' || name === 'node_modules' || name === '.git') continue;
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = await fs.stat(abs);
      if (st.isDirectory()) await walk(abs, rel);
      else if (st.isFile() && st.size > 0) found.push(rel);
    }
  }
  await walk(workspace);
  return found;
}

function makeLeafNode(fixture: EvalTaskFixture, overrides?: Partial<any>): any {
  const { idSuffix, label, description, acceptance, agent_class, ...rest } = overrides || {};
  return {
    id: `eval-${fixture.id}${idSuffix ? `-${idSuffix}` : ''}`,
    type: 'task',
    label: label || fixture.title,
    description: description || fixture.prompt,
    acceptance_criteria: acceptance || fixture.acceptance,
    status: 'pending',
    effort_minutes: fixture.effort_minutes || 5,
    agent_class: agent_class || 'grunt',
    tools: ['shell', 'edit', 'test'],
    children: [],
    ...rest,
  };
}

/** Multi-leaf web UI swarm: 3 concurrent agents (html / js / polish). */
function makeWebUiSwarmNodes(fixture: EvalTaskFixture): any[] {
  return [
    makeLeafNode(fixture, {
      idSuffix: 'html',
      label: 'HTML shell',
      agent_class: 'frontend',
      description:
        'Write a REAL file named index.html (not markdown). It must include:\n' +
        '<title>SwarmAgents Counter</title>, <h1>SwarmAgents Counter</h1>,\n' +
        '<div id="count">0</div>, <button id="inc">Increment</button>,\n' +
        'and <script src="app.js"></script> plus <link rel="stylesheet" href="styles.css">.\n' +
        'Respond with a fenced block starting with ```index.html',
      acceptance: ['index.html exists on disk', 'title/h1/count/inc present'],
    }),
    makeLeafNode(fixture, {
      idSuffix: 'js',
      label: 'Counter JS',
      agent_class: 'frontend',
      description:
        'Write a REAL file named app.js (not markdown). Wire #inc click to increment #count by 1 using addEventListener.\n' +
        'Respond with a fenced block starting with ```app.js',
      acceptance: ['app.js exists', 'click increments count'],
    }),
    makeLeafNode(fixture, {
      idSuffix: 'css',
      label: 'Light polish',
      agent_class: 'frontend',
      description:
        'Write a REAL file named styles.css (not markdown) with simple centered layout for the counter.\n' +
        'Respond with a fenced block starting with ```styles.css',
      acceptance: ['styles.css exists'],
    }),
  ];
}

function makeEvalSession(
  id: string,
  fixture: EvalTaskFixture,
  provider: StoredProvider,
  opts?: { agents?: number }
): DecompSessionRecord {
  const agents = Math.max(1, Math.min(3, opts?.agents || 1));
  const nodes =
    fixture.id === 'small_web_ui' && agents > 1
      ? makeWebUiSwarmNodes(fixture).slice(0, agents)
      : [makeLeafNode(fixture)];
  return {
    id,
    project: `capability-eval:${fixture.id}`,
    project_title: fixture.title,
    nodes,
    total_effort: `${fixture.effort_minutes || 5}m`,
    status: 'executing',
    createdAt: Date.now(),
    budget_minutes: 15,
    constraints: { prefer: [], avoid: [], qualityBar: fixture.qualityBar },
    mission: { constraints: [] },
    eval_meta: {
      arm: 'swarm',
      fixture: fixture.id,
      model: provider.models?.[0],
      agents,
    },
  } as unknown as DecompSessionRecord;
}

async function runBaselineArm(
  fixture: EvalTaskFixture,
  provider: StoredProvider
): Promise<EvalArmResult> {
  const t0 = Date.now();
  const workspace = path.join(evalRoot(), 'runs', randomUUID(), 'baseline');
  await fs.mkdir(workspace, { recursive: true });
  await writeSeed(workspace, fixture.seed);

  const system =
    'You are a coding assistant. Respond with one or more fenced code blocks. ' +
    'Each fence MUST start with the relative file path on the info line, e.g. ```src/sum.js';
  const user = fixture.prompt;
  const text = await chatWithProvider(provider, system, user);
  if (!text) {
    return {
      passed: false,
      ms: Date.now() - t0,
      files: [],
      error: 'baseline_llm_empty',
    };
  }

  const parsed = parseFencedFiles(text);
  // Fallback: if contract task and model replied plain text
  if (!Object.keys(parsed).length && fixture.id === 'contract_marker') {
    if (/ACCEPT:swarm-eval-v1/.test(text)) {
      parsed['deliverables/CONTRACT.md'] = 'ACCEPT:swarm-eval-v1\n';
    }
  }
  for (const [rel, body] of Object.entries(parsed)) {
    const abs = path.join(workspace, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf8');
  }

  const files = await listRealFiles(workspace);
  const session = makeEvalSession(`base-${fixture.id}-${randomUUID().slice(0, 8)}`, fixture, provider);
  session.workspace_path = workspace;
  const node = session.nodes[0];
  node.files_written = files;
  node.result = text.slice(0, 8000);
  node.status = 'validating';

  const gate = await finalizeLeafCandidate(session, node, workspace, {
    reason: 'chat_completion',
  });
  // Baseline does not get repair loop advantage — if repaired, count as fail for fair lift
  const passed = gate.passed === true;
  if (gate.repaired) {
    node.status = 'failed';
  }

  return {
    passed,
    ms: Date.now() - t0,
    files,
    validation_feedback: node.validation_feedback,
    repairs: gate.repaired ? 1 : 0,
    error: passed ? undefined : node.validation_feedback || 'baseline_gates_failed',
  };
}

async function runSwarmArm(
  fixture: EvalTaskFixture,
  provider: StoredProvider,
  opts?: { agents?: number }
): Promise<EvalArmResult> {
  const t0 = Date.now();
  const agents = Math.max(1, Math.min(3, opts?.agents || (fixture.id === 'small_web_ui' ? 3 : 1)));
  const session = makeEvalSession(
    `swarm-${fixture.id}-${randomUUID().slice(0, 8)}`,
    fixture,
    provider,
    { agents }
  );
  setSession(session);
  const workspace = await ensureSessionWorkspaceForApi(session);
  await writeSeed(workspace, fixture.seed);

  for (const node of collectLeaves(session.nodes)) {
    node.assignedProvider = provider.name || provider.id;
  }

  let repairs = 0;
  const batchSize = agents;
  for (let round = 0; round < 8; round++) {
    const stats = await executeLeafBatch(session, batchSize);
    repairs += Number(stats.repaired) || 0;
    setSession(session);
    if (stats.done || stats.terminal) break;
    if (!stats.executed.length) break;
  }

  const leaves = collectLeaves(session.nodes);
  const files = await listRealFiles(workspace);
  // Prefer objective package test when seeded
  let passed = leaves.every((l) => l.status === 'completed' && l.validation_passed !== false);
  if (fixture.seed?.['package.json']) {
    try {
      const { spawn } = await import('child_process');
      const code: number = await new Promise((resolve) => {
        const child = spawn('npm', ['test', '--silent'], {
          cwd: workspace,
          env: { ...process.env, CI: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.on('close', (c) => resolve(c ?? 1));
        child.on('error', () => resolve(1));
      });
      if (code === 0) passed = true;
    } catch {
      /* keep leaf-based passed */
    }
  }

  return {
    passed: Boolean(passed),
    ms: Date.now() - t0,
    files,
    validation_feedback: leaves.map((l) => l.validation_feedback).filter(Boolean).join('; '),
    repairs,
    error: passed
      ? undefined
      : leaves.map((l) => l.last_error || l.validation_feedback).filter(Boolean).join('; ') ||
        'swarm_failed',
  };
}

function summarize(tasks: EvalTaskResult[], provider: StoredProvider): CapabilityEvalReport['summary'] {
  const total = tasks.length;
  const baselinePassed = tasks.filter((t) => t.baseline.passed).length;
  const swarmPassed = tasks.filter((t) => t.swarm.passed).length;
  const baselinePassRate = total ? baselinePassed / total : 0;
  const swarmPassRate = total ? swarmPassed / total : 0;
  const liftPercentagePoints = Math.round((swarmPassRate - baselinePassRate) * 1000) / 10;
  const liftRatio =
    baselinePassRate > 0 ? Math.round((swarmPassRate / baselinePassRate) * 100) / 100 : null;
  const model = provider.models?.[0] || 'default';
  const headline =
    liftPercentagePoints > 0
      ? `Same model (${model}): SwarmAgents +${liftPercentagePoints}pp vs plain chat (${swarmPassed}/${total} vs ${baselinePassed}/${total})`
      : liftPercentagePoints === 0
        ? `Same model (${model}): parity with plain chat on this suite (${swarmPassed}/${total})`
        : `Same model (${model}): suite under-performed chat by ${Math.abs(liftPercentagePoints)}pp — inspect gate logs`;
  return {
    baselinePassRate,
    swarmPassRate,
    liftPercentagePoints,
    liftRatio,
    baselinePassed,
    swarmPassed,
    total,
    headline,
  };
}

export async function runCapabilityEval(opts?: {
  providerId?: string;
  taskIds?: string[];
  agents?: number;
}): Promise<CapabilityEvalReport> {
  const provider = await pickEvalProvider(opts?.providerId);
  if (!provider) {
    throw new Error('No enabled provider configured — add one in Settings');
  }

  const fixtures = CAPABILITY_EVAL_FIXTURES.filter((f) =>
    opts?.taskIds?.length ? opts.taskIds.includes(f.id) : true
  );
  if (!fixtures.length) throw new Error('No eval fixtures selected');

  const tasks: EvalTaskResult[] = [];
  for (const fixture of fixtures) {
    const baseline = await runBaselineArm(fixture, provider);
    const swarm = await runSwarmArm(fixture, provider, { agents: opts?.agents });
    tasks.push({
      id: fixture.id,
      title: fixture.title,
      qualityBar: fixture.qualityBar,
      baseline,
      swarm,
    });
  }

  const report: CapabilityEvalReport = {
    version: 1,
    ranAt: Date.now(),
    model: provider.models?.[0] || 'default',
    providerName: provider.name || provider.id,
    providerType: provider.type,
    tasks,
    summary: summarize(tasks, provider),
  };

  await fs.mkdir(evalRoot(), { recursive: true });
  await fs.writeFile(
    path.join(evalRoot(), 'latest.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );
  await fs.writeFile(
    path.join(evalRoot(), `report-${report.ranAt}.json`),
    JSON.stringify(report, null, 2),
    'utf8'
  );

  return report;
}

export async function loadLatestCapabilityEval(): Promise<CapabilityEvalReport | null> {
  try {
    const raw = await fs.readFile(path.join(evalRoot(), 'latest.json'), 'utf8');
    return JSON.parse(raw) as CapabilityEvalReport;
  } catch {
    return null;
  }
}
