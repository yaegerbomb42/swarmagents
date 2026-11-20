import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInitialFsmContext,
  checkCapViolation,
  MAX_TRANSITIONS,
} from '../../../src/agent/fsm/types.js';
import { step } from '../../../src/agent/fsm/machine.js';
import {
  runFsm,
  persistContextAtomically,
  loadPersistedContext,
  computeInputHash,
} from '../../../src/agent/fsm/runner.js';

describe('Phase 6: Decoupled Issue-Resolution FSM Engine (Steps 6.1 & 6.2)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omnexx-fsm-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('createInitialFsmContext initializes at INTAKE with zero transitions', () => {
    const ctx = createInitialFsmContext({
      runId: 'run-1',
      repoRoot: tempDir,
      baseSha: 'base-123',
      inputHash: 'hash-abc',
      issue: { id: 'issue-42', problemStatement: 'Fix TypeError in parser' },
    });

    expect(ctx.state).toBe('INTAKE');
    expect(ctx.transitionsCount).toBe(0);
    expect(ctx.visits.INTAKE).toBe(1);
    expect(ctx.visits.A_LOCALIZE).toBe(0);
    expect(ctx.history).toHaveLength(0);
  });

  it('steps through the full happy-path lifecycle to DONE_VERIFIED', () => {
    let ctx = createInitialFsmContext({
      runId: 'run-1',
      repoRoot: tempDir,
      baseSha: 'base-123',
      inputHash: 'hash-abc',
      issue: { id: 'issue-42', problemStatement: 'Fix TypeError' },
    });

    // 1. INTAKE -> A_LOCALIZE
    let res = step(ctx, { type: 'INTAKE_COMPLETE' });
    expect(res.nextState).toBe('A_LOCALIZE');
    expect(res.effect.type).toBe('RUN_LOCALIZE');
    ctx = res.ctx;

    // 2. A_LOCALIZE -> B_SPECIFY
    res = step(ctx, {
      type: 'LOCALIZED',
      files: ['src/core.ts'],
      spans: [{ path: 'src/core.ts', startLine: 10, endLine: 25 }],
      confidence: 0.95,
    });
    expect(res.nextState).toBe('B_SPECIFY');
    expect(res.effect.type).toBe('RUN_SPECIFY');
    expect(res.ctx.localization?.files).toEqual(['src/core.ts']);
    ctx = res.ctx;

    // 3. B_SPECIFY -> C_SYNTHESIZE
    res = step(ctx, {
      type: 'SPECIFIED',
      intent: { rootCause: 'Null pointer', fixStrategy: 'Guard check', edgeCases: [] },
      reproStatus: 'reproduced',
    });
    expect(res.nextState).toBe('C_SYNTHESIZE');
    expect(res.effect.type).toBe('RUN_SYNTHESIZE');
    ctx = res.ctx;

    // 4. C_SYNTHESIZE -> D_VERIFY
    res = step(ctx, {
      type: 'CANDIDATES_SYNTHESIZED',
      candidates: [
        {
          id: 'cand-1',
          rung: 0,
          temperature: 0,
          hypothesis: 'Guard check',
          diff: 'diff --git a/...',
          filesTouched: ['src/core.ts'],
          syntaxValid: true,
          diagnosticsDelta: 0,
        },
      ],
    });
    expect(res.nextState).toBe('D_VERIFY');
    expect(res.effect.type).toBe('RUN_VERIFY');
    ctx = res.ctx;

    // 5. D_VERIFY -> E_SELECT
    res = step(ctx, {
      type: 'VERIFICATION_COMPLETE',
      evaluations: [
        {
          candidateId: 'cand-1',
          clean: true,
          newFailuresCount: 0,
          reproPassed: true,
          extraCasesFailed: 0,
          literalLeaksCount: 0,
          clusterSize: 1,
          diffLines: 4,
          filesTouched: 1,
          index: 0,
        },
      ],
    });
    expect(res.nextState).toBe('E_SELECT');
    expect(res.effect.type).toBe('RUN_SELECT');
    ctx = res.ctx;

    // 6. E_SELECT -> F_FINALIZE
    res = step(ctx, {
      type: 'CANDIDATE_SELECTED',
      candidateId: 'cand-1',
    });
    expect(res.nextState).toBe('F_FINALIZE');
    expect(res.effect.type).toBe('RUN_FINALIZE');
    ctx = res.ctx;

    // 7. F_FINALIZE -> DONE_VERIFIED
    res = step(ctx, {
      type: 'FINALIZED',
      verified: true,
      patchDiff: 'diff --git a/...',
    });
    expect(res.nextState).toBe('DONE_VERIFIED');
    expect(res.effect.type).toBe('TERMINATE');
    expect(res.ctx.transitionsCount).toBe(7);
  });

  it('enforces visit caps and falls back to DONE_UNVERIFIED if viable candidate exists', () => {
    const ctx = createInitialFsmContext({
      runId: 'run-cap',
      repoRoot: tempDir,
      baseSha: 'base-123',
      inputHash: 'hash-cap',
      issue: { id: 'issue-cap', problemStatement: 'cap test' },
    });

    // Artificially visit C_SYNTHESIZE up to its cap
    ctx.state = 'B_SPECIFY';
    ctx.visits.C_SYNTHESIZE = 5; // Cap is 5
    ctx.bestCandidateId = 'cand-fallback';

    const res = step(ctx, { type: 'SPECIFIED', reproStatus: 'unavailable' });
    expect(res.nextState).toBe('DONE_UNVERIFIED');
    expect(res.effect.type).toBe('TERMINATE');
    expect(res.ctx.error).toContain('Visit cap');
  });

  it('enforces global MAX_TRANSITIONS ceiling and halts loop', () => {
    const ctx = createInitialFsmContext({
      runId: 'run-limit',
      repoRoot: tempDir,
      baseSha: 'base-123',
      inputHash: 'hash-limit',
      issue: { id: 'issue-limit', problemStatement: 'limit test' },
    });

    ctx.transitionsCount = MAX_TRANSITIONS;
    const violation = checkCapViolation(ctx, 'A_LOCALIZE');
    expect(violation.violated).toBe(true);
    expect(violation.reason).toContain('Global transition limit');
  });

  it('atomically persists context and resumes crash seamlessly', async () => {
    const inputHash = computeInputHash('Crash recovery problem', 'sha-base');
    const ctx = createInitialFsmContext({
      runId: 'run-crash',
      repoRoot: tempDir,
      baseSha: 'sha-base',
      inputHash,
      issue: { id: 'issue-crash', problemStatement: 'Crash recovery problem' },
    });

    // Advance to A_LOCALIZE and persist
    const step1 = step(ctx, { type: 'INTAKE_COMPLETE' });
    await persistContextAtomically(step1.ctx, tempDir);

    // Verify loaded context from disk
    const loaded = await loadPersistedContext(tempDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.state).toBe('A_LOCALIZE');
    expect(loaded?.transitionsCount).toBe(1);

    // Run FSM from disk: it should pick up at A_LOCALIZE and finish
    let intakeCalled = false;
    let localizeCalled = false;

    const finalCtx = await runFsm(
      {
        runId: 'run-crash',
        repoRoot: tempDir,
        baseSha: 'sha-base',
        issue: { id: 'issue-crash', problemStatement: 'Crash recovery problem' },
      },
      {
        runIntake: async () => {
          await Promise.resolve();
          intakeCalled = true;
          return { type: 'INTAKE_COMPLETE' };
        },
        runLocalize: async () => {
          await Promise.resolve();
          localizeCalled = true;
          return {
            type: 'LOCALIZED',
            files: ['src/app.ts'],
            spans: [{ path: 'src/app.ts', startLine: 1, endLine: 5 }],
            confidence: 0.9,
          };
        },
      },
      { storageDir: tempDir },
    );

    // INTAKE was already completed before crash, so runIntake was never called!
    expect(intakeCalled).toBe(false);
    expect(localizeCalled).toBe(true);
    expect(finalCtx.state).toBe('DONE_VERIFIED');
  });
});
