/**
 * Step 5.5 — 3-Way Differential Matrix Orchestrator & 4-Way Gate Evaluator.
 *
 * Verifies a candidate patch against a baseline commit by executing three runs:
 *
 *   Run 1 (pre-patch on baseline): the repro test MUST FAIL (exit != 0). If it passes
 *     the symptom is not reproduced on baseline → `reject_repro`.
 *   Run 2 (post-patch on an isolated transient worktree): the repro test MUST PASS
 *     (exit 0). If it still fails → `reject_fix`.
 *   Run 3 (full regression suite across baseline and patched trees): the set of new
 *     failures on the patched tree must be empty (`regressions.length === 0`). If any
 *     new failure survives (after optional flaky quarantine) → `reject_regression`.
 *
 * The evaluator is a 4-way gate: `pass | reject_repro | reject_fix | reject_regression`.
 * Transient worktrees are always torn down idempotently, even on early rejection.
 *
 * The test runs themselves are delegated to an injected `Executor` (default `runShell`),
 * so callers can provision dependencies in the worktree (e.g. `npm ci`) or stub runs in
 * tests. Resource bounds from Step 5.4 are applied by default (timeout + bounded threads).
 */

import { isAbsolute, normalize } from 'node:path';
import type { GateParser } from '../config/schema.js';
import { runShell, type ExecResult, type Executor } from '../core/exec.js';
import { createVerificationWorktree, type VerificationWorktree } from '../git/worktree.js';
import { parseGateOutput } from './parsers/index.js';
import type { Failure, TestCounts } from './parsers/types.js';
import { shellQuote } from './shell-quote.js';

/** Step 5.4 default bound: no single run may exceed 60s. */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PARSER: GateParser = 'vitest';
const DEFAULT_BIN = 'npx vitest';

export type RejectReproReason = 'passed-on-baseline' | 'timed-out-on-baseline';
export type RejectFixReason = 'failed-after-patch' | 'patch-did-not-apply';

/**
 * The 4-way gate verdict. Only the runs relevant to the final verdict are populated on
 * {@link DifferentialMatrixResult.runs}.
 */
export type DifferentialVerdict =
  | { status: 'pass' }
  | { status: 'reject_repro'; reason: RejectReproReason }
  | { status: 'reject_fix'; reason: RejectFixReason }
  | { status: 'reject_regression' };

/** A test failure that exists on the patched tree but not the baseline (a new regression). */
export interface RegressionFailure {
  id: string;
  message: string;
}

export interface DifferentialRun {
  label: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  failures: Failure[];
  tests?: TestCounts;
}

export type DifferentialRunKey =
  'prePatch' | 'postPatch' | 'regressionBaseline' | 'regressionPatched';

export interface DifferentialMatrixResult {
  verdict: DifferentialVerdict;
  /** The commit the candidate patch is diffed against. */
  baseSha: string;
  reproTestPath: string;
  /** Runs actually executed; absent for runs skipped by an earlier verdict. */
  runs: Readonly<Partial<Record<DifferentialRunKey, DifferentialRun>>>;
  /** New failures on the patched tree that flo the flaky quarantine. */
  regressions: readonly RegressionFailure[];
  /** Failures that appeared on the patched tree but vanished on rerun (quarantined). */
  flaky: readonly RegressionFailure[];
}

export interface DifferentialMatrixOptions {
  /** Test-runner. Defaults to `runShell`. */
  exec?: Executor;
  /** Root for transient verification worktrees; passed through to Step 5.3. */
  worktreeRoot?: string;
  /** Parser key for the suite reporter. Defaults to `vitest` (`--reporter=json`). */
  parser?: GateParser;
  /** Per-run wall-clock bound. Defaults to 60s (Step 5.4). */
  timeoutMs?: number;
  /** Env for every run; `NODE_ENV=test` and `VITEST_MAX_THREADS=2` are seeded. */
  env?: Record<string, string>;
  /** Base command used to invoke vitest (e.g. `npx vitest`). */
  regressionBin?: string;
  /**
   * Rerun the patched regression suite once when new failures appear, quarantining any
   * that pass on the rerun (flaky) before computing the regression delta. Default 0.
   */
  flakyReruns?: number;
  signal?: AbortSignal;
  redact?: (s: string) => string;
}

export async function runDifferentialMatrix(
  repoRoot: string,
  baseSha: string,
  candidateDiff: string,
  reproTestPath: string,
  options: DifferentialMatrixOptions = {},
): Promise<DifferentialMatrixResult> {
  if (!repoRoot || !baseSha) {
    throw new TypeError('repoRoot and baseSha are required');
  }
  if (typeof candidateDiff !== 'string') {
    throw new TypeError('candidateDiff must be a string');
  }
  assertRelativeWithinRoot(reproTestPath);

  const executor = options.exec ?? runShell;
  const parser = options.parser ?? DEFAULT_PARSER;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const redact = options.redact ?? ((s: string): string => s);
  const bin = options.regressionBin ?? DEFAULT_BIN;
  const flakyReruns = Math.max(0, options.flakyReruns ?? 0);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    VITEST_MAX_THREADS: '2',
    ...options.env,
  };

  const reproCommand = `${bin} run ${shellQuote(reproTestPath)} --reporter=json`;
  const regressionCommand = `${bin} run --reporter=json`;

  const worktrees: VerificationWorktree[] = [];
  const createWorktree = async (): Promise<VerificationWorktree> => {
    const wt = await createVerificationWorktree(repoRoot, {
      baseSha,
      ...(options.worktreeRoot ? { root: options.worktreeRoot } : {}),
    });
    worktrees.push(wt);
    return wt;
  };

  const runSuite = async (
    cwd: string,
    command: string,
    label: string,
  ): Promise<DifferentialRun> => {
    const result: ExecResult = await executor(command, {
      cwd,
      env,
      timeoutMs,
      redact,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.aborted) {
      const err = new Error('differential matrix run aborted');
      err.name = 'AbortError';
      throw err;
    }
    const parsed = parseGateOutput(parser, result.output, {
      gate: label,
      exitCode: result.exitCode,
      cwd,
    });
    return {
      label,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      failures: parsed.failures,
      ...(parsed.tests ? { tests: parsed.tests } : {}),
    };
  };

  const runs: Partial<Record<DifferentialRunKey, DifferentialRun>> = {};
  let verdict: DifferentialVerdict | null = null;
  let regressions: RegressionFailure[] = [];
  let flaky: RegressionFailure[] = [];

  try {
    // ── Run 1: repro must FAIL on baseline ────────────────────────────────────────
    const baselineWt = await createWorktree();
    runs.prePatch = await runSuite(baselineWt.worktreePath, reproCommand, 'baseline-pre-patch');
    if (runs.prePatch.exitCode === 0) {
      verdict = { status: 'reject_repro', reason: 'passed-on-baseline' };
    } else if (runs.prePatch.timedOut) {
      verdict = { status: 'reject_repro', reason: 'timed-out-on-baseline' };
    }

    if (!verdict) {
      // ── Run 2: repro must PASS on the patched worktree ──────────────────────────
      const patchedWt = await createWorktree();
      const applied = await patchedWt.applyPatch(candidateDiff);
      if (!applied) {
        verdict = { status: 'reject_fix', reason: 'patch-did-not-apply' };
      } else {
        runs.postPatch = await runSuite(patchedWt.worktreePath, reproCommand, 'patched');
        if (runs.postPatch.exitCode !== 0) {
          verdict = { status: 'reject_fix', reason: 'failed-after-patch' };
        } else {
          // ── Run 3: regression delta across both trees ──────────────────────────────
          runs.regressionBaseline = await runSuite(
            baselineWt.worktreePath,
            regressionCommand,
            'regression-baseline',
          );
          runs.regressionPatched = await runSuite(
            patchedWt.worktreePath,
            regressionCommand,
            'regression-patched',
          );
          regressions = computeRegressions(runs.regressionBaseline, runs.regressionPatched);
          if (flakyReruns > 0 && regressions.length > 0) {
            const rerun = await runSuite(
              patchedWt.worktreePath,
              regressionCommand,
              'regression-patched-rerun',
            );
            const stillFailing = new Set(rerun.failures.map((f) => f.id));
            flaky = regressions.filter((r) => !stillFailing.has(r.id));
            regressions = regressions.filter((r) => stillFailing.has(r.id));
          }
          verdict = regressions.length === 0 ? { status: 'pass' } : { status: 'reject_regression' };
        }
      }
    }

    return {
      verdict: requireVerdict(verdict),
      baseSha,
      reproTestPath,
      runs,
      regressions,
      flaky,
    };
  } finally {
    // Idempotent teardown (Step 5.3 `cleanup()` is internally idempotent).
    for (const wt of worktrees) {
      await wt.cleanup().catch(() => undefined);
    }
  }
}

/** Narrow the accumulator verdict; throws on an impossible (unreachable) state. */
function requireVerdict(verdict: DifferentialVerdict | null): DifferentialVerdict {
  if (verdict === null) {
    throw new Error('unreachable: differential matrix never reached a verdict');
  }
  return verdict;
}

/** New patched-tree failures that were not failing on baseline = regressions. */
function computeRegressions(
  baseline: DifferentialRun,
  patched: DifferentialRun,
): RegressionFailure[] {
  const baselineIds = new Set(baseline.failures.map((f) => f.id));
  return patched.failures
    .filter((f) => !baselineIds.has(f.id))
    .map((f) => ({ id: f.id, message: f.message }));
}

function assertRelativeWithinRoot(reproTestPath: string): void {
  if (typeof reproTestPath !== 'string' || !reproTestPath) {
    throw new TypeError('reproTestPath must be a non-empty string');
  }
  if (isAbsolute(reproTestPath)) {
    throw new TypeError('reproTestPath must be relative to the repo root');
  }
  const normalized = normalize(reproTestPath);
  if (normalized.startsWith('..') || isAbsolute(normalized)) {
    throw new TypeError('reproTestPath escapes the repo root');
  }
}
