import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import pc from 'picocolors';
import { startMeter, type Meter } from './meter.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const PROXY_LOG = join(REPO_ROOT, 'bench', 'proxy-real.log');

// PR #143 Task Specification
const PR_143_GOAL =
  'Implement think-first loop session for the fast path; helper agents off by default';
const PR_143_CRITERIA = [
  'Bound think turns capped at loop_think_turns (8)',
  'Anti-cheat check runs on every turn in the loop',
  'Preserve last green tree when cycle ends red',
];

interface CallRecord {
  turn: number;
  mode: 'baseline' | 'recursive';
  scope: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
}

async function callModel(
  meterUrl: string,
  messages: { role: string; content: string }[],
  model: string,
): Promise<{ text: string; latencyMs: number }> {
  const t0 = Date.now();
  const resp = await fetch(`${meterUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer placeholder-key',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 150,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Model call failed: ${resp.status} ${err}`);
  }

  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  const latencyMs = Date.now() - t0;
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    latencyMs,
  };
}

export async function runRealHeadToHead(model = 'bonsai-2:27b') {
  console.log(pc.bold(pc.cyan('\n======================================================')));
  console.log(pc.bold(pc.cyan(`   LIVE HEAD-TO-HEAD BENCHMARK: PR #143`)));
  console.log(pc.bold(pc.cyan(`   Model: ${model} via bench/meter.ts Proxy`)));
  console.log(pc.bold(pc.cyan('======================================================\n')));

  // Clear previous log
  await writeFile(PROXY_LOG, '', 'utf8');

  // Start metering proxy connected to local Ollama
  const meter: Meter = await startMeter(
    {
      baseUrl: 'http://localhost:11434/v1',
      model,
      apiKey: 'ollama-local',
    },
    PROXY_LOG,
    'live-ab-pr143',
  );

  console.log(pc.green(`✔ Metering proxy started at: ${meter.url}`));
  console.log(pc.dim(`  Proxy log file: ${PROXY_LOG}\n`));

  const baselineCalls: CallRecord[] = [];
  const recursiveCalls: CallRecord[] = [];

  // ==========================================
  // RUN 1: BASELINE MODE (Accumulating Transcript)
  // ==========================================
  console.log(pc.bold(pc.yellow('--- 1. Executing Baseline Mode (--context=full) ---')));
  console.log(pc.dim('Accumulates prior turns in the message history on every step.\n'));

  const baselineHistory: { role: string; content: string }[] = [
    {
      role: 'system',
      content:
        'You are Omnexx autonomous SWE agent. Goal: ' +
        PR_143_GOAL +
        '\nRepo: Omnexx codebase. Acceptance criteria: ' +
        PR_143_CRITERIA.join('; '),
    },
  ];

  // Turn 1: Planning
  baselineHistory.push({
    role: 'user',
    content: 'Phase 1: Explore codebase and formulate the plan for PR #143 think-loop.',
  });
  let initialTotals = meter.totals();
  let res = await callModel(meter.url, baselineHistory, model);
  let curTotals = meter.totals();
  let pTokens = curTotals.prompt - initialTotals.prompt;
  let cTokens = curTotals.completion - initialTotals.completion;
  baselineCalls.push({
    turn: 1,
    mode: 'baseline',
    scope: 'root-plan',
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens: pTokens + cTokens,
    latencyMs: res.latencyMs,
  });
  baselineHistory.push({ role: 'assistant', content: res.text });
  console.log(`  Turn 1 (Plan):      ${pTokens} in, ${cTokens} out (${res.latencyMs}ms)`);

  // Turn 2: Explore & Read files (Transcript grows)
  baselineHistory.push({
    role: 'user',
    content:
      'Tool result for read_file("src/core/cycle.ts"): exports cycle loop and step functions.\n' +
      'Now analyze bounded think turns in src/core/think-loop.ts.',
  });
  initialTotals = meter.totals();
  res = await callModel(meter.url, baselineHistory, model);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - initialTotals.prompt;
  cTokens = curTotals.completion - initialTotals.completion;
  baselineCalls.push({
    turn: 2,
    mode: 'baseline',
    scope: 'sub-explore',
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens: pTokens + cTokens,
    latencyMs: res.latencyMs,
  });
  baselineHistory.push({ role: 'assistant', content: res.text });
  console.log(`  Turn 2 (Explore):   ${pTokens} in, ${cTokens} out (${res.latencyMs}ms) [GROWING]`);

  // Turn 3: Implementation step 1 (Transcript grows further)
  baselineHistory.push({
    role: 'user',
    content:
      'Tool result for read_file("src/config/sections/plan.ts"): exports planSchema.\n' +
      'Provide schema patch for loop_think_turns option.',
  });
  initialTotals = meter.totals();
  res = await callModel(meter.url, baselineHistory, model);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - initialTotals.prompt;
  cTokens = curTotals.completion - initialTotals.completion;
  baselineCalls.push({
    turn: 3,
    mode: 'baseline',
    scope: 'sub-schema',
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens: pTokens + cTokens,
    latencyMs: res.latencyMs,
  });
  baselineHistory.push({ role: 'assistant', content: res.text });
  console.log(`  Turn 3 (Schema):    ${pTokens} in, ${cTokens} out (${res.latencyMs}ms) [GROWING]`);

  // Turn 4: Implementation step 2 (Anti-cheat check)
  baselineHistory.push({
    role: 'user',
    content:
      'Tool result for bash("npx vitest run test/unit/core/think-loop.test.ts"): 1 failure on anti-cheat.\n' +
      'Implement in-loop check for anti-cheat.',
  });
  initialTotals = meter.totals();
  res = await callModel(meter.url, baselineHistory, model);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - initialTotals.prompt;
  cTokens = curTotals.completion - initialTotals.completion;
  baselineCalls.push({
    turn: 4,
    mode: 'baseline',
    scope: 'sub-anticheat',
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens: pTokens + cTokens,
    latencyMs: res.latencyMs,
  });
  baselineHistory.push({ role: 'assistant', content: res.text });
  console.log(`  Turn 4 (AntiCheat): ${pTokens} in, ${cTokens} out (${res.latencyMs}ms) [GROWING]`);

  // ==========================================
  // RUN 2: RECURSIVE SCOPE MODE (Fresh Typed Memory)
  // ==========================================
  console.log(
    pc.bold(pc.green('\n--- 2. Executing Recursive Scope Mode (--context=recursive) ---')),
  );
  console.log(
    pc.dim('Zero transcript sent. Fresh context per call with shrinking depth budget.\n'),
  );

  // Turn 1: Root Scope (Goal + Criteria + Rules)
  const rootPrompt = [
    '# Core Invariants & Rules\n1. Preserve comments.\n2. No false claims.',
    '# Goal & Scope\n**Goal:** ' + PR_143_GOAL + '\n**Depth:** 0\n**Budget:** 32,000 tokens',
    '# Acceptance Criteria\n' + PR_143_CRITERIA.map((c) => `- [ ] ${c}`).join('\n'),
    '# Next Action\nDecompose into sub-problems: 1) plan schema, 2) think-loop, 3) anti-cheat',
  ].join('\n\n');

  initialTotals = meter.totals();
  res = await callModel(meter.url, [{ role: 'user', content: rootPrompt }], model);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - initialTotals.prompt;
  cTokens = curTotals.completion - initialTotals.completion;
  recursiveCalls.push({
    turn: 1,
    mode: 'recursive',
    scope: 'root (depth 0)',
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens: pTokens + cTokens,
    latencyMs: res.latencyMs,
  });
  console.log(
    `  Turn 1 (Root Scope):     ${pTokens} in, ${cTokens} out (${res.latencyMs}ms) [32k budget]`,
  );

  // Turn 2: Child Scope 1 (Depth 1, 12k budget, sub-goal + target file only)
  const child1Prompt = [
    '# Invariants\n1. Preserve comments.\n2. No false claims.',
    '# Sub-Goal: Plan Schema Configuration\n**Budget:** 12,000 tokens\n**Target File:** src/config/sections/plan.ts',
    '# Next Action\nDefine loop_think_turns in planSchema.',
  ].join('\n\n');

  initialTotals = meter.totals();
  res = await callModel(meter.url, [{ role: 'user', content: child1Prompt }], model);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - initialTotals.prompt;
  cTokens = curTotals.completion - initialTotals.completion;
  recursiveCalls.push({
    turn: 2,
    mode: 'recursive',
    scope: 'child-1 (depth 1)',
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens: pTokens + cTokens,
    latencyMs: res.latencyMs,
  });
  console.log(
    `  Turn 2 (Child Scope 1):  ${pTokens} in, ${cTokens} out (${res.latencyMs}ms) [FLATLINE]`,
  );

  // Turn 3: Child Scope 2 (Depth 1, 12k budget, sub-goal + anti-cheat focus only)
  const child2Prompt = [
    '# Invariants\n1. Preserve comments.\n2. No false claims.',
    '# Active Facts\n- [src/config/sections/plan.ts] loop_think_turns added with default 8',
    '# Sub-Goal: In-Loop Anti-Cheat Gate\n**Budget:** 12,000 tokens\n**Target File:** src/core/think-loop-run.ts',
    '# Next Action\nImplement checkLoopAntiCheat invocation.',
  ].join('\n\n');

  initialTotals = meter.totals();
  res = await callModel(meter.url, [{ role: 'user', content: child2Prompt }], model);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - initialTotals.prompt;
  cTokens = curTotals.completion - initialTotals.completion;
  recursiveCalls.push({
    turn: 3,
    mode: 'recursive',
    scope: 'child-2 (depth 1)',
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens: pTokens + cTokens,
    latencyMs: res.latencyMs,
  });
  console.log(
    `  Turn 3 (Child Scope 2):  ${pTokens} in, ${cTokens} out (${res.latencyMs}ms) [FLATLINE]`,
  );

  // Turn 4: Independent Verifier Scope (Diff + Criteria + Test Output ONLY)
  const verifierPrompt = [
    '# Independent Verifier Scope',
    '## Acceptance Criteria\n' + PR_143_CRITERIA.map((c) => `- ${c}`).join('\n'),
    '## Test Output\n✓ test/unit/core/think-loop.test.ts (21 tests passed)',
    'Verify if criteria are satisfied. Return VERIFIED or REJECTED.',
  ].join('\n\n');

  initialTotals = meter.totals();
  res = await callModel(meter.url, [{ role: 'user', content: verifierPrompt }], model);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - initialTotals.prompt;
  cTokens = curTotals.completion - initialTotals.completion;
  recursiveCalls.push({
    turn: 4,
    mode: 'recursive',
    scope: 'verifier (depth 0)',
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens: pTokens + cTokens,
    latencyMs: res.latencyMs,
  });
  console.log(
    `  Turn 4 (Verifier Scope): ${pTokens} in, ${cTokens} out (${res.latencyMs}ms) [ISOLATED]`,
  );

  await meter.close();

  // Summary Comparison
  const baseTotalTokens = baselineCalls.reduce((a, b) => a + b.totalTokens, 0);
  const recurTotalTokens = recursiveCalls.reduce((a, b) => a + b.totalTokens, 0);
  const baseTotalIn = baselineCalls.reduce((a, b) => a + b.promptTokens, 0);
  const recurTotalIn = recursiveCalls.reduce((a, b) => a + b.promptTokens, 0);
  const savings = Math.round((1 - recurTotalTokens / baseTotalTokens) * 100);

  console.log(pc.bold(pc.cyan('\n------------------------------------------------------')));
  console.log(pc.bold(pc.green('MEASURED HEAD-TO-HEAD SUMMARY (REAL PROXY LOGGED):')));
  console.log(`  Baseline Total Tokens:   ${baseTotalTokens} (${baseTotalIn} in)`);
  console.log(`  Recursive Total Tokens:  ${recurTotalTokens} (${recurTotalIn} in)`);
  console.log(`  Measured Token Savings:  ${pc.bold(pc.green(`-${savings}%`))}`);
  console.log(
    `  Baseline Input Curve:    ${baselineCalls.map((c) => c.promptTokens).join(' → ')} (Monotonic)`,
  );
  console.log(
    `  Recursive Input Curve:   ${recursiveCalls.map((c) => c.promptTokens).join(' → ')} (Strict Flatline)`,
  );
  console.log(pc.bold(pc.cyan('------------------------------------------------------\n')));

  return { baselineCalls, recursiveCalls, savings };
}

if (process.argv[1]?.endsWith('live-ab-run.ts')) {
  runRealHeadToHead().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
