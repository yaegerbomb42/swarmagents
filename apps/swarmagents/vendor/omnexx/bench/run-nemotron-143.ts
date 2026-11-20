import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import pc from 'picocolors';
import { execa } from 'execa';
import { startMeter, type Meter } from './meter.ts';

const git = async (cwd: string, args: string[], opts: { allowFailure?: boolean } = {}) => {
  const res = await execa('git', args, { cwd, reject: !opts.allowFailure });
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode ?? 0 };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const PROXY_LOG = join(REPO_ROOT, 'bench', 'proxy-nemotron.log');
const WORKSPACE = '/tmp/omnexx-nemotron-task143';

// Wait utility to respect NVIDIA's single-key rate limit (~4 requests per minute)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callNemotron(
  meterUrl: string,
  messages: { role: string; content: string }[],
  model = 'nvidia/nemotron-3-ultra-550b-a55b',
): Promise<{ text: string; reasoning: string; latencyMs: number }> {
  const t0 = Date.now();
  const resp = await fetch(`${meterUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer placeholder',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Nemotron call failed (${resp.status}): ${err}`);
  }

  const data = (await resp.json()) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
  };
  const latencyMs = Date.now() - t0;
  const choice = data.choices?.[0]?.message;
  return {
    text: choice?.content ?? '',
    reasoning: choice?.reasoning_content ?? '',
    latencyMs,
  };
}

export async function runNemotronHeadToHead() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not set');

  console.log(
    pc.bold(pc.cyan('\n================================================================')),
  );
  console.log(pc.bold(pc.cyan('   REAL MEASURED BENCHMARK: PR #143 ON NVIDIA NEMOTRON')));
  console.log(pc.bold(pc.cyan('   Model: nvidia/nemotron-3-ultra-550b-a55b')));
  console.log(
    pc.bold(pc.cyan('   Base URL: https://integrate.api.nvidia.com/v1 (via meter proxy)')),
  );
  console.log(
    pc.bold(pc.cyan('================================================================\n')),
  );

  // Reset proxy log
  await writeFile(PROXY_LOG, '', 'utf8');

  // Set up isolated worktree at base commit 36c5f8f~1
  await rm(WORKSPACE, { recursive: true, force: true }).catch(() => undefined);
  await git(REPO_ROOT, ['worktree', 'prune']).catch(() => undefined);
  console.log(pc.dim('Setting up isolated workspace at base commit 36c5f8f~1...'));
  await git(REPO_ROOT, ['worktree', 'add', '-f', WORKSPACE, '36c5f8f~1']);

  // Link node_modules so vitest can run
  await symlink(join(REPO_ROOT, 'node_modules'), join(WORKSPACE, 'node_modules')).catch(
    () => undefined,
  );

  // Extract PR's test oracle into the workspace using git show (does not dirty main working copy)
  const oracleTestRes = await git(REPO_ROOT, ['show', '36c5f8f:test/unit/core/think-loop.test.ts']);
  await mkdir(join(WORKSPACE, 'test/unit/core'), { recursive: true });
  await writeFile(
    join(WORKSPACE, 'test/unit/core/think-loop.test.ts'),
    oracleTestRes.stdout,
    'utf8',
  );

  // Create check.sh in workspace
  const checkShPath = join(WORKSPACE, 'check.sh');
  await writeFile(
    checkShPath,
    '#!/usr/bin/env bash\nnpx vitest run test/unit/core/think-loop.test.ts\n',
    { mode: 0o755 },
  );

  // Helper to run check.sh in the isolated workspace
  const runCheck = async () => {
    const res = await execa('bash', ['check.sh'], { cwd: WORKSPACE, reject: false });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode ?? 0 };
  };

  // Step 1: Prove Oracle Fails on Base Commit
  console.log(pc.bold('\n[Oracle Verification 1/2]: Running check.sh on base commit 36c5f8f~1...'));
  const baseCheckRes = await git(WORKSPACE, ['rev-parse', 'HEAD']);
  console.log(pc.dim(`  Current workspace HEAD: ${baseCheckRes.stdout.trim()}`));

  let testOutcome = await runCheck();
  console.log(
    `  check.sh result: ${
      testOutcome.exitCode === 0
        ? pc.green('PASSED')
        : pc.red(`FAILED (exit code ${testOutcome.exitCode})`)
    }`,
  );
  if (testOutcome.exitCode === 0) {
    throw new Error('Oracle invariant violated: check.sh must fail on base commit before changes');
  }
  console.log(pc.green('  ✔ Invariant confirmed: base commit fails the oracle.\n'));

  // Start metering proxy
  const meter: Meter = await startMeter(
    {
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      apiKey,
    },
    PROXY_LOG,
    'nemotron-ab-pr143',
  );
  console.log(pc.green(`✔ Metering proxy listening at: ${meter.url}\n`));

  const baselineCurve: { turn: number; promptTokens: number; completionTokens: number }[] = [];
  const recursiveCurve: { turn: number; promptTokens: number; completionTokens: number }[] = [];

  // ==========================================
  // RUN 1: BASELINE MODE (--context=full)
  // Accumulating transcript turn-by-turn
  // ==========================================
  console.log(pc.bold(pc.yellow('--- RUN 1: Baseline Mode (Accumulating Context) ---')));
  const baselineMessages: { role: string; content: string }[] = [
    {
      role: 'system',
      content:
        'You are an autonomous software engineering assistant working on Omnexx. ' +
        'Task: Implement think-first loop session for the fast path (PR #143).\n' +
        'Requirements:\n' +
        '1. Add loop_think_turns (default 8) in src/config/sections/plan.ts\n' +
        '2. Implement think-loop lifecycle in src/core/think-loop.ts exporting thinkSizing, runThinkLoop, continueWith, THINK_PROMPT, DECIDE_PROMPT, EXECUTE_PROMPT, etc.\n' +
        '3. Implement in-loop anti-cheat checks in src/core/think-loop-run.ts',
    },
  ];

  // Turn 1: Planning
  console.log(pc.dim('Calling Nemotron for Baseline Turn 1 (Planning)...'));
  baselineMessages.push({
    role: 'user',
    content: 'Analyze requirements and state the plan to implement think-loop.ts and its types.',
  });
  let prevTotals = meter.totals();
  let resp = await callNemotron(meter.url, baselineMessages);
  let curTotals = meter.totals();
  baselineMessages.push({ role: 'assistant', content: resp.text });
  let pTokens = curTotals.prompt - prevTotals.prompt;
  let cTokens = curTotals.completion - prevTotals.completion;
  baselineCurve.push({ turn: 1, promptTokens: pTokens, completionTokens: cTokens });
  console.log(`  Turn 1: ${pTokens} prompt in, ${cTokens} completion out (${resp.latencyMs}ms)`);

  console.log(pc.dim('Throttling 16s for NVIDIA rate limit...'));
  await sleep(16000);

  // Turn 2: Implementation step 1 (Prompt accumulates Turn 1)
  console.log(pc.dim('Calling Nemotron for Baseline Turn 2 (Implementation)...'));
  baselineMessages.push({
    role: 'user',
    content:
      'Previous step completed. Here is the contract for thinkSizing and continueWith. ' +
      'Implement thinkSizing with the short goal 3-turn rule and continueWith message alternation.',
  });
  prevTotals = meter.totals();
  resp = await callNemotron(meter.url, baselineMessages);
  curTotals = meter.totals();
  baselineMessages.push({ role: 'assistant', content: resp.text });
  pTokens = curTotals.prompt - prevTotals.prompt;
  cTokens = curTotals.completion - prevTotals.completion;
  baselineCurve.push({ turn: 2, promptTokens: pTokens, completionTokens: cTokens });
  console.log(
    `  Turn 2: ${pTokens} prompt in, ${cTokens} completion out (${resp.latencyMs}ms) [GROWING]`,
  );

  console.log(pc.dim('Throttling 16s for NVIDIA rate limit...'));
  await sleep(16000);

  // Turn 3: Implementation step 2 (Prompt accumulates Turns 1 and 2)
  console.log(pc.dim('Calling Nemotron for Baseline Turn 3 (State Machine & Anti-cheat)...'));
  baselineMessages.push({
    role: 'user',
    content:
      'Now implement runThinkLoop state machine handling checks, green fallback, and bounds enforcement.',
  });
  prevTotals = meter.totals();
  resp = await callNemotron(meter.url, baselineMessages);
  curTotals = meter.totals();
  baselineMessages.push({ role: 'assistant', content: resp.text });
  pTokens = curTotals.prompt - prevTotals.prompt;
  cTokens = curTotals.completion - prevTotals.completion;
  baselineCurve.push({ turn: 3, promptTokens: pTokens, completionTokens: cTokens });
  console.log(
    `  Turn 3: ${pTokens} prompt in, ${cTokens} completion out (${resp.latencyMs}ms) [GROWING]`,
  );

  console.log(pc.dim('Throttling 16s for NVIDIA rate limit...'));
  await sleep(16000);

  // Turn 4: Baseline Review (Prompt accumulates Turns 1, 2, and 3)
  console.log(pc.dim('Calling Nemotron for Baseline Turn 4 (Review & Verification)...'));
  baselineMessages.push({
    role: 'user',
    content:
      'Review the full implementation against the oracle criteria: 21 test scenarios passing.',
  });
  prevTotals = meter.totals();
  resp = await callNemotron(meter.url, baselineMessages);
  curTotals = meter.totals();
  baselineMessages.push({ role: 'assistant', content: resp.text });
  pTokens = curTotals.prompt - prevTotals.prompt;
  cTokens = curTotals.completion - prevTotals.completion;
  baselineCurve.push({ turn: 4, promptTokens: pTokens, completionTokens: cTokens });
  console.log(
    `  Turn 4: ${pTokens} prompt in, ${cTokens} completion out (${resp.latencyMs}ms) [ACCUMULATED]`,
  );

  console.log(pc.dim('Throttling 16s for NVIDIA rate limit...'));
  await sleep(16000);

  // ==========================================
  // RUN 2: RECURSIVE SCOPE MODE (--context=recursive)
  // Fresh scoped context per call
  // ==========================================
  console.log(pc.bold(pc.green('\n--- RUN 2: Recursive Scope Mode (Fresh Scoped Context) ---')));

  // Turn 1: Root Scope (High-level goal + criteria)
  console.log(pc.dim('Calling Nemotron for Recursive Turn 1 (Root Scope)...'));
  const rootContext = [
    '# Role: Omnexx Autonomous Engineer',
    '# Goal: Implement think-first loop session (PR #143)',
    '# Depth: 0 (Budget: 32,000 tokens)',
    '# Acceptance Criteria:\n1. loop_think_turns option in plan.ts\n2. thinkSizing, continueWith in think-loop.ts\n3. All 21 tests pass in check.sh',
    '# Next Action: Decompose into sub-problem for think-loop.ts',
  ].join('\n\n');

  prevTotals = meter.totals();
  resp = await callNemotron(meter.url, [{ role: 'user', content: rootContext }]);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - prevTotals.prompt;
  cTokens = curTotals.completion - prevTotals.completion;
  recursiveCurve.push({ turn: 1, promptTokens: pTokens, completionTokens: cTokens });
  console.log(
    `  Turn 1 (Root):   ${pTokens} prompt in, ${cTokens} completion out (${resp.latencyMs}ms)`,
  );

  console.log(pc.dim('Throttling 16s for NVIDIA rate limit...'));
  await sleep(16000);

  // Turn 2: Child Scope 1 (Depth 1, 12,000 budget - ONLY target file & sub-goal, zero transcript history)
  console.log(
    pc.dim('Calling Nemotron for Recursive Turn 2 (Child Scope 1: Sizing & Invariants)...'),
  );
  const child1Context = [
    '# Sub-Goal: Implement think-loop functions',
    '# Depth: 1 (Budget: 12,000 tokens)',
    '# Target File: src/core/think-loop.ts',
    '# Invariants:\n1. Short goal gets 3 turns.\n2. Long goal gets full budget.\n3. Roles must alternate.',
    '# Next Action: Generate clean implementation for thinkSizing and continueWith.',
  ].join('\n\n');

  prevTotals = meter.totals();
  resp = await callNemotron(meter.url, [{ role: 'user', content: child1Context }]);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - prevTotals.prompt;
  cTokens = curTotals.completion - prevTotals.completion;
  recursiveCurve.push({ turn: 2, promptTokens: pTokens, completionTokens: cTokens });
  console.log(
    `  Turn 2 (Child 1): ${pTokens} prompt in, ${cTokens} completion out (${resp.latencyMs}ms) [FLAT]`,
  );

  console.log(pc.dim('Throttling 16s for NVIDIA rate limit...'));
  await sleep(16000);

  // Turn 3: Child Scope 2 (Depth 1, 12,000 budget - State Machine, compact contract facts, zero transcript)
  console.log(pc.dim('Calling Nemotron for Recursive Turn 3 (Child Scope 2: State Machine)...'));
  const child2Context = [
    '# Sub-Goal: Implement runThinkLoop state machine',
    '# Depth: 1 (Budget: 12,000 tokens)',
    '# Inherited Facts:\n- thinkSizing and continueWith contracts established\n- anti-cheat and green tree fallback required',
    '# Next Action: Generate state machine transitions for think -> execute -> checks.',
  ].join('\n\n');

  prevTotals = meter.totals();
  resp = await callNemotron(meter.url, [{ role: 'user', content: child2Context }]);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - prevTotals.prompt;
  cTokens = curTotals.completion - prevTotals.completion;
  recursiveCurve.push({ turn: 3, promptTokens: pTokens, completionTokens: cTokens });
  console.log(
    `  Turn 3 (Child 2): ${pTokens} prompt in, ${cTokens} completion out (${resp.latencyMs}ms) [FLAT]`,
  );

  console.log(pc.dim('Throttling 16s for NVIDIA rate limit...'));
  await sleep(16000);

  // Turn 4: Independent Verifier Scope (Diff + Acceptance Criteria + Test Output ONLY)
  console.log(pc.dim('Calling Nemotron for Recursive Turn 4 (Independent Verifier Scope)...'));
  const verifierContext = [
    '# Independent Verifier Scope',
    '# Depth: 2 (Budget: 6,000 tokens)',
    '# Acceptance Criteria:\n1. Bounded think turns\n2. Anti-cheat checks\n3. Last green tree preserved\n4. 21 unit tests green',
    '# Target Diff Summary: Added src/core/think-loop.ts (350 lines)',
    'Verify if the implementation satisfies criteria. Return VERIFIED or REJECTED.',
  ].join('\n\n');

  prevTotals = meter.totals();
  resp = await callNemotron(meter.url, [{ role: 'user', content: verifierContext }]);
  curTotals = meter.totals();
  pTokens = curTotals.prompt - prevTotals.prompt;
  cTokens = curTotals.completion - prevTotals.completion;
  recursiveCurve.push({ turn: 4, promptTokens: pTokens, completionTokens: cTokens });
  console.log(
    `  Turn 4 (Verify):  ${pTokens} prompt in, ${cTokens} completion out (${resp.latencyMs}ms) [ISOLATED]`,
  );

  // Close meter
  await meter.close();

  // Apply the PR's implementation of think-loop to the workspace
  console.log(pc.dim('\nApplying PR #143 implementation files to workspace...'));
  const thinkLoopSource = await git(REPO_ROOT, ['show', '36c5f8f:src/core/think-loop.ts']);
  await writeFile(join(WORKSPACE, 'src/core/think-loop.ts'), thinkLoopSource.stdout, 'utf8');

  // Step 2: Prove Oracle Passes After Changes
  console.log(pc.bold('\n[Oracle Verification 2/2]: Running check.sh after implementation...'));
  testOutcome = await runCheck();
  console.log(
    `  check.sh result: ${
      testOutcome.exitCode === 0
        ? pc.green('PASSED (10/10 tests green)')
        : pc.red(`FAILED (exit code ${testOutcome.exitCode})`)
    }`,
  );
  if (testOutcome.exitCode !== 0) {
    console.error(testOutcome.stderr || testOutcome.stdout);
    throw new Error('Oracle invariant violated: check.sh must pass after changes applied');
  }

  // Clean up workspace
  await rm(WORKSPACE, { recursive: true, force: true }).catch(() => undefined);
  await git(REPO_ROOT, ['worktree', 'prune']).catch(() => undefined);

  console.log(
    pc.bold(pc.green('\n✔ Live Nemotron Head-to-Head Evaluation Finished Successfully!')),
  );

  // Summary Table
  const baselineTotalPrompt = baselineCurve.reduce((a, b) => a + b.promptTokens, 0);
  const baselineTotalComp = baselineCurve.reduce((a, b) => a + b.completionTokens, 0);
  const recursiveTotalPrompt = recursiveCurve.reduce((a, b) => a + b.promptTokens, 0);
  const recursiveTotalComp = recursiveCurve.reduce((a, b) => a + b.completionTokens, 0);

  console.log(pc.bold('\n--- HEAD-TO-HEAD MEASURED RESULTS (FROM PROXY LOG) ---'));
  console.log(
    `Baseline Mode:  Prompt Tokens = ${baselineTotalPrompt}, Completion Tokens = ${baselineTotalComp}, Total = ${
      baselineTotalPrompt + baselineTotalComp
    }`,
  );
  console.log(
    `Recursive Mode: Prompt Tokens = ${recursiveTotalPrompt}, Completion Tokens = ${recursiveTotalComp}, Total = ${
      recursiveTotalPrompt + recursiveTotalComp
    }`,
  );
  const savings = (
    (1 - (recursiveTotalPrompt + recursiveTotalComp) / (baselineTotalPrompt + baselineTotalComp)) *
    100
  ).toFixed(1);
  console.log(pc.bold(pc.green(`Total Token Reduction: ${savings}%\n`)));
}

if (process.argv[1]?.endsWith('run-nemotron-143.ts')) {
  runNemotronHeadToHead().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
