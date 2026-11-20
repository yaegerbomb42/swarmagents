import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEvidenceBundle,
  verifyEvidenceBundleIntegrity,
  saveEvidenceBundle,
  loadEvidenceBundle,
  routeRejectionStrategy,
  assertEvidenceBundleValid,
} from '../../../src/verify/evidence.js';

describe('Step 5.6: Strategy Branching & Immutable Evidence Bundle', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omnexx-evidence-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates an evidence bundle with deterministic SHA-256 integrity id', () => {
    const bundle = createEvidenceBundle({
      baseSha: 'abc1234',
      targetSha: 'def5678',
      prePatchReport: {
        exitCode: 1,
        timedOut: false,
        durationMs: 420,
        failures: [{ id: 'test_repro', message: 'expected true to be false' }],
      },
      postPatchReport: {
        exitCode: 0,
        timedOut: false,
        durationMs: 380,
        failures: [],
      },
      regressionDelta: [],
      timestamp: 1700000000000,
    });

    expect(bundle.version).toBe(1);
    expect(bundle.verdict).toBe('pass');
    expect(bundle.id).toHaveLength(64);
    expect(verifyEvidenceBundleIntegrity(bundle)).toBe(true);
  });

  it('detects tampering when bundle properties are modified', () => {
    const bundle = createEvidenceBundle({
      baseSha: 'abc1234',
      targetSha: 'def5678',
      prePatchReport: { exitCode: 1, timedOut: false, durationMs: 420, failures: [] },
      postPatchReport: { exitCode: 0, timedOut: false, durationMs: 380, failures: [] },
      regressionDelta: [],
    });

    expect(verifyEvidenceBundleIntegrity(bundle)).toBe(true);

    // Tamper with targetSha
    const tampered = { ...bundle, targetSha: 'badf00d' };
    expect(verifyEvidenceBundleIntegrity(tampered)).toBe(false);
  });

  it('saves and loads evidence bundle from disk, verifying integrity', async () => {
    const bundle = createEvidenceBundle({
      baseSha: 'sha1',
      targetSha: 'sha2',
      prePatchReport: { exitCode: 1, timedOut: false, durationMs: 100, failures: [] },
      postPatchReport: { exitCode: 0, timedOut: false, durationMs: 90, failures: [] },
      regressionDelta: [],
    });

    const savedPath = await saveEvidenceBundle(bundle, tempDir);
    expect(savedPath).toContain('evidence-');

    const loaded = await loadEvidenceBundle(savedPath);
    expect(loaded.id).toBe(bundle.id);
    expect(loaded.baseSha).toBe('sha1');
  });

  it('routeRejectionStrategy maps reject_repro to re-localize action', () => {
    const result = routeRejectionStrategy(
      { status: 'reject_repro', reason: 'passed-on-baseline' },
      { reproTestPath: '.omnexx-repro/test.ts' },
    );
    expect(result.strategy).toBe('reject_repro');
    expect(result.action).toBe('re-localize');
    expect(result.retestTarget).toBe('.omnexx-repro/test.ts');
  });

  it('routeRejectionStrategy maps reject_fix to discard-patch action', () => {
    const result = routeRejectionStrategy({ status: 'reject_fix', reason: 'failed-after-patch' });
    expect(result.strategy).toBe('reject_fix');
    expect(result.action).toBe('discard-patch');
    expect(result.guidance).toContain('Discard current patch changes');
  });

  it('routeRejectionStrategy maps reject_regression to constrain-patch with hard constraints', () => {
    const regressions = [
      { id: 'auth.test.ts > login', message: 'failed' },
      { id: 'db.test.ts > connect', message: 'timeout' },
    ];
    const result = routeRejectionStrategy({ status: 'reject_regression' }, { regressions });
    expect(result.strategy).toBe('reject_regression');
    expect(result.action).toBe('constrain-patch');
    expect(result.hardConstraints).toEqual(['auth.test.ts > login', 'db.test.ts > connect']);
  });

  it('assertEvidenceBundleValid passes valid bundle and rejects invalid ones', () => {
    const valid = createEvidenceBundle({
      baseSha: 'base',
      targetSha: 'target',
      prePatchReport: { exitCode: 1, timedOut: false, durationMs: 100, failures: [] },
      postPatchReport: { exitCode: 0, timedOut: false, durationMs: 90, failures: [] },
      regressionDelta: [],
    });

    expect(() => {
      assertEvidenceBundleValid(valid);
    }).not.toThrow();
    expect(() => {
      assertEvidenceBundleValid(null);
    }).toThrow('lacks an Evidence Bundle');

    const tampered = { ...valid, baseSha: 'hacked' };
    expect(() => {
      assertEvidenceBundleValid(tampered);
    }).toThrow('integrity check failed');

    const withRegressions = {
      ...valid,
      regressionDelta: [{ id: 'test1', message: 'broken' }],
    };
    expect(() => {
      assertEvidenceBundleValid(withRegressions);
    }).toThrow('integrity check failed');
  });
});
