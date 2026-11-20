/**
 * Step 6.2: Crash-Safe FSM Runner & State Persistence.
 *
 * Coordinates execution of the Issue-Resolution FSM:
 *   - Atomic filesystem persistence (write temp + fsync + rename)
 *   - Crash resume: recovers exact execution state without re-running finished stages
 *   - Structured effect dispatcher with typed event loop
 */

import { createHash } from 'node:crypto';
import { open, mkdir, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type FsmContext,
  type ActiveFsmState,
  createInitialFsmContext,
  fsmContextSchema,
  DEFAULT_STATE_VISIT_CAPS,
} from './types.js';
import { step, type FsmEvent, type FsmEffect } from './machine.js';

export interface FsmHandlers {
  runIntake?: (ctx: FsmContext) => Promise<FsmEvent>;
  runLocalize?: (ctx: FsmContext) => Promise<FsmEvent>;
  runSpecify?: (ctx: FsmContext) => Promise<FsmEvent>;
  runSynthesize?: (ctx: FsmContext, rung: number) => Promise<FsmEvent>;
  runVerify?: (ctx: FsmContext, candidateIds: string[]) => Promise<FsmEvent>;
  runSelect?: (ctx: FsmContext) => Promise<FsmEvent>;
  runFinalize?: (ctx: FsmContext, candidateId: string) => Promise<FsmEvent>;
}

export interface FsmRunnerOptions {
  storageDir?: string;
  caps?: Record<ActiveFsmState, number>;
  onStep?: (ctx: FsmContext, event: FsmEvent, effect: FsmEffect) => void;
}

export function computeInputHash(problemStatement: string, baseSha: string): string {
  return createHash('sha256').update(`${baseSha}:${problemStatement.trim()}`).digest('hex');
}

/**
 * Persists context to disk atomically using temporary file + fsync + rename.
 */
export async function persistContextAtomically(
  ctx: FsmContext,
  storageDir: string,
): Promise<string> {
  await mkdir(storageDir, { recursive: true });
  const targetPath = join(storageDir, 'ctx.json');
  const tempPath = join(storageDir, `ctx.json.tmp.${process.pid}.${Date.now()}`);

  const serialized = JSON.stringify(ctx, null, 2);

  const fileHandle = await open(tempPath, 'w', 0o600);
  try {
    await fileHandle.writeFile(serialized, 'utf8');
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  await rename(tempPath, targetPath);
  return targetPath;
}

/**
 * Loads a persisted FsmContext from disk with schema validation.
 */
export async function loadPersistedContext(storageDir: string): Promise<FsmContext | null> {
  const filePath = join(storageDir, 'ctx.json');
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return fsmContextSchema.parse(parsed) as FsmContext;
  } catch {
    return null;
  }
}

/**
 * Runs the issue-resolution FSM to completion, dispatching effects and persisting state after each step.
 */
export async function runFsm(
  initParams: {
    runId: string;
    repoRoot: string;
    baseSha: string;
    issue: { id: string; title?: string; problemStatement: string };
  },
  handlers: FsmHandlers,
  options: FsmRunnerOptions = {},
): Promise<FsmContext> {
  const storageDir =
    options.storageDir ?? join(initParams.repoRoot, '.omnexx', 'runs', initParams.runId, 'fsm');

  const inputHash = computeInputHash(initParams.issue.problemStatement, initParams.baseSha);

  // Attempt crash resume
  let ctx = await loadPersistedContext(storageDir);
  if (ctx?.inputHash !== inputHash) {
    ctx = createInitialFsmContext({
      runId: initParams.runId,
      repoRoot: initParams.repoRoot,
      baseSha: initParams.baseSha,
      inputHash,
      issue: initParams.issue,
    });
    await persistContextAtomically(ctx, storageDir);
  }

  const caps = options.caps ?? DEFAULT_STATE_VISIT_CAPS;

  while (
    ctx.state !== 'DONE_VERIFIED' &&
    ctx.state !== 'DONE_UNVERIFIED' &&
    ctx.state !== 'DONE_NO_PATCH' &&
    ctx.state !== 'ABORT_ENV' &&
    ctx.state !== 'ABORT_BUDGET'
  ) {
    const effect = dispatchEffect(ctx);
    if (effect.type === 'TERMINATE') {
      break;
    }

    const event = await executeEffect(effect, ctx, handlers);
    const stepResult = step(ctx, event, caps);

    ctx = stepResult.ctx;
    await persistContextAtomically(ctx, storageDir);

    options.onStep?.(ctx, event, stepResult.effect);
  }

  return ctx;
}

function dispatchEffect(ctx: FsmContext): FsmEffect {
  switch (ctx.state) {
    case 'INTAKE':
      return { type: 'RUN_INTAKE' };
    case 'A_LOCALIZE':
      return { type: 'RUN_LOCALIZE' };
    case 'B_SPECIFY':
      return { type: 'RUN_SPECIFY' };
    case 'C_SYNTHESIZE':
      return { type: 'RUN_SYNTHESIZE', rung: ctx.rung };
    case 'D_VERIFY':
      return { type: 'RUN_VERIFY', candidateIds: ctx.candidates.map((c) => c.id) };
    case 'E_SELECT':
      return { type: 'RUN_SELECT' };
    case 'F_FINALIZE':
      return {
        type: 'RUN_FINALIZE',
        candidateId: ctx.bestCandidateId ?? ctx.candidates[0]?.id ?? '',
      };
    default:
      return { type: 'TERMINATE', state: ctx.state };
  }
}

async function executeEffect(
  effect: FsmEffect,
  ctx: FsmContext,
  handlers: FsmHandlers,
): Promise<FsmEvent> {
  switch (effect.type) {
    case 'RUN_INTAKE':
      if (handlers.runIntake) return handlers.runIntake(ctx);
      return { type: 'INTAKE_COMPLETE' };

    case 'RUN_LOCALIZE':
      if (handlers.runLocalize) return handlers.runLocalize(ctx);
      return {
        type: 'LOCALIZED',
        files: ['src/index.ts'],
        spans: [{ path: 'src/index.ts', startLine: 1, endLine: 10 }],
        confidence: 0.9,
      };

    case 'RUN_SPECIFY':
      if (handlers.runSpecify) return handlers.runSpecify(ctx);
      return {
        type: 'SPECIFIED',
        reproStatus: 'unavailable',
      };

    case 'RUN_SYNTHESIZE':
      if (handlers.runSynthesize) return handlers.runSynthesize(ctx, effect.rung);
      return {
        type: 'CANDIDATES_SYNTHESIZED',
        candidates: [
          {
            id: 'c0',
            rung: effect.rung,
            temperature: 0,
            hypothesis: 'Direct fix',
            diff: 'mock-diff',
            filesTouched: ['src/index.ts'],
            syntaxValid: true,
            diagnosticsDelta: 0,
          },
        ],
      };

    case 'RUN_VERIFY':
      if (handlers.runVerify) return handlers.runVerify(ctx, effect.candidateIds);
      return {
        type: 'VERIFICATION_COMPLETE',
        evaluations: effect.candidateIds.map((id, index) => ({
          candidateId: id,
          clean: true,
          newFailuresCount: 0,
          reproPassed: true,
          extraCasesFailed: 0,
          literalLeaksCount: 0,
          clusterSize: 1,
          diffLines: 5,
          filesTouched: 1,
          index,
        })),
      };

    case 'RUN_SELECT':
      if (handlers.runSelect) return handlers.runSelect(ctx);
      return {
        type: 'CANDIDATE_SELECTED',
        candidateId: ctx.candidates[0]?.id ?? 'c0',
      };

    case 'RUN_FINALIZE':
      if (handlers.runFinalize) return handlers.runFinalize(ctx, effect.candidateId);
      return {
        type: 'FINALIZED',
        verified: true,
        patchDiff: ctx.candidates.find((c) => c.id === effect.candidateId)?.diff ?? '',
      };

    case 'TERMINATE':
      return {
        type: 'ABORT_REQUESTED',
        reason: effect.reason ?? 'Terminated',
        kind: 'budget',
      };
  }
}
