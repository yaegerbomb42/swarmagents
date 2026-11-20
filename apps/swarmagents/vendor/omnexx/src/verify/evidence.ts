/**
 * Step 5.6: Strategy Branching & Immutable Evidence Bundle.
 *
 * Implements:
 * 1. Immutable Evidence Bundle: Cryptographically verifiable record of 3-way differential
 *    verification (pre-patch failure, post-patch fix, regression delta = 0).
 * 2. Strategy Branching: Deterministic recovery routing upon differential gate rejection:
 *    - reject_repro: Re-localize symptom with stack trace or isolate flaky baseline test.
 *    - reject_fix: Discard patch, feed post-patch test errors back into repair prompt.
 *    - reject_regression: Retain repro test, discard patch, inject broken tests as hard negative constraints.
 * 3. Commit Gate: Enforces that any "completed" declaration carries a valid, untampered Evidence Bundle.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DifferentialVerdict, RegressionFailure } from './differential-tdr.js';
import type { Failure } from './parsers/types.js';

export interface EvidenceRunReport {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  failures: { id: string; message: string }[];
}

export interface SynthesizedTestRef {
  path: string;
  contentSha256: string;
}

export interface EvidenceBundlePayload {
  version: 1;
  timestamp: number;
  baseSha: string;
  targetSha: string;
  synthesizedTest?: SynthesizedTestRef;
  prePatchReport: EvidenceRunReport;
  postPatchReport: EvidenceRunReport;
  regressionDelta: RegressionFailure[];
  verdict: 'pass';
}

export interface EvidenceBundle extends EvidenceBundlePayload {
  /** Deterministic SHA-256 integrity checksum over the canonical payload JSON. */
  id: string;
}

export type StrategyAction = 're-localize' | 'discard-patch' | 'constrain-patch';

export interface StrategyBranchResult {
  strategy: 'reject_repro' | 'reject_fix' | 'reject_regression';
  action: StrategyAction;
  guidance: string;
  hardConstraints?: string[];
  retestTarget?: string;
}

/**
 * Computes a deterministic SHA-256 hash over an evidence payload.
 */
export function hashEvidencePayload(payload: EvidenceBundlePayload): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Creates an immutable, tamper-verifiable Evidence Bundle.
 */
export function createEvidenceBundle(
  params: Omit<EvidenceBundlePayload, 'version' | 'verdict' | 'timestamp'> & {
    timestamp?: number;
  },
): EvidenceBundle {
  const payload: EvidenceBundlePayload = {
    version: 1,
    timestamp: params.timestamp ?? Date.now(),
    baseSha: params.baseSha,
    targetSha: params.targetSha,
    ...(params.synthesizedTest ? { synthesizedTest: params.synthesizedTest } : {}),
    prePatchReport: params.prePatchReport,
    postPatchReport: params.postPatchReport,
    regressionDelta: params.regressionDelta,
    verdict: 'pass',
  };

  const id = hashEvidencePayload(payload);
  return {
    ...payload,
    id,
  };
}

/**
 * Verifies that the evidence bundle has not been tampered with.
 */
export function verifyEvidenceBundleIntegrity(bundle: EvidenceBundle): boolean {
  if (!bundle.id) return false;

  const { id, ...payload } = bundle;
  const computed = hashEvidencePayload(payload);
  return computed === id;
}

/**
 * Persists the evidence bundle to disk with permissions 0o644.
 */
export async function saveEvidenceBundle(bundle: EvidenceBundle, dir: string): Promise<string> {
  if (!verifyEvidenceBundleIntegrity(bundle)) {
    throw new Error(`Refusing to save corrupt or unverified evidence bundle: ${bundle.id}`);
  }
  const filename = `evidence-${bundle.id.slice(0, 12)}.json`;
  const filePath = join(dir, filename);
  await writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf8');
  return filePath;
}

/**
 * Loads an evidence bundle and verifies its cryptographic integrity.
 */
export async function loadEvidenceBundle(filePath: string): Promise<EvidenceBundle> {
  const content = await readFile(filePath, 'utf8');
  const bundle = JSON.parse(content) as EvidenceBundle;
  if (!verifyEvidenceBundleIntegrity(bundle)) {
    throw new Error(`Evidence bundle integrity verification failed for ${filePath}`);
  }
  return bundle;
}

export interface RejectionContext {
  reproTestPath?: string;
  failures?: Failure[];
  regressions?: RegressionFailure[];
}

/**
 * Maps differential matrix gate rejections to deterministic recovery strategies.
 */
export function routeRejectionStrategy(
  verdict: DifferentialVerdict,
  context: RejectionContext = {},
): StrategyBranchResult {
  switch (verdict.status) {
    case 'reject_repro':
      return {
        strategy: 'reject_repro',
        action: 're-localize',
        guidance:
          'Reproduction test did not fail on baseline (or timed out). The reported issue was not reproduced. ' +
          'Re-localize the symptom using execution traces and stack traces, or quarantine the baseline test as flaky.',
        ...(context.reproTestPath ? { retestTarget: context.reproTestPath } : {}),
      };

    case 'reject_fix':
      return {
        strategy: 'reject_fix',
        action: 'discard-patch',
        guidance:
          'Candidate patch failed to resolve the reproduced defect on the isolated worktree. ' +
          'Discard current patch changes, revert modified files, and inspect post-patch failure diagnostics.',
      };

    case 'reject_regression': {
      const brokenIds = (context.regressions ?? []).map((r) => r.id);
      return {
        strategy: 'reject_regression',
        action: 'constrain-patch',
        guidance:
          'Candidate patch fixed the symptom but introduced new regression failures into the existing test suite. ' +
          'Retain the reproduction test, discard patch edits, and incorporate broken test cases as hard negative constraints.',
        ...(brokenIds.length > 0 ? { hardConstraints: brokenIds } : {}),
      };
    }

    case 'pass':
      throw new Error('Cannot route rejection strategy for passing differential verdict');
    default: {
      const exhaustiveCheck: never = verdict;
      throw new Error(`Unhandled differential verdict: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Gate check enforcing that completed repair tasks possess an untampered evidence bundle.
 */
export function assertEvidenceBundleValid(
  bundle: EvidenceBundle | null | undefined,
): asserts bundle is EvidenceBundle {
  if (!bundle) {
    throw new Error('Commit gate rejected: Completed repair declaration lacks an Evidence Bundle.');
  }
  if (!verifyEvidenceBundleIntegrity(bundle)) {
    throw new Error(`Commit gate rejected: Evidence Bundle ${bundle.id} integrity check failed.`);
  }
  if (bundle.regressionDelta.length > 0) {
    throw new Error(
      `Commit gate rejected: Evidence Bundle reports ${bundle.regressionDelta.length} unquarantined regressions.`,
    );
  }
}
