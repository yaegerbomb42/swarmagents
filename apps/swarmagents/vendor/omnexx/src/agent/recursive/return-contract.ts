import { createHash } from 'node:crypto';
import { git } from '../../git/git.js';
import {
  type ReturnContract,
  type TestEvidence,
  type Fact,
  returnContractSchema,
} from './types.js';
import type { TypedMemory } from './typed-memory.js';

export function computeDiffHash(diff: string): string {
  // Normalize line endings and whitespace differences
  const normalized = diff.replace(/\r\n/g, '\n').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Validate that the return contract adheres to invariants:
 * 1. Has valid status.
 * 2. If diff is non-empty, diffHash must match the hash of diff.
 * 3. If solved, evidence must be present, passed must be true, and evidence.diffHash must equal diffHash.
 */
export function validateReturnContract(contract: ReturnContract): {
  valid: boolean;
  reason?: string;
} {
  const parse = returnContractSchema.safeParse(contract);
  if (!parse.success) {
    return { valid: false, reason: `Schema validation failed: ${parse.error.message}` };
  }

  const expectedHash = computeDiffHash(contract.diff);
  if (contract.diff && contract.diffHash !== expectedHash) {
    return {
      valid: false,
      reason: `diffHash mismatch: expected ${expectedHash.slice(0, 8)}, got ${contract.diffHash.slice(0, 8)}`,
    };
  }

  if (contract.status === 'solved') {
    if (!contract.evidence) {
      return { valid: false, reason: 'Status is "solved" but no test evidence was provided' };
    }
    if (!contract.evidence.passed || contract.evidence.exitCode !== 0) {
      return {
        valid: false,
        reason: `Status is "solved" but test evidence failed with exit code ${contract.evidence.exitCode}`,
      };
    }
    if (contract.evidence.diffHash !== contract.diffHash) {
      return {
        valid: false,
        reason: `Evidence diffHash (${contract.evidence.diffHash.slice(0, 8)}) does not match contract diffHash (${contract.diffHash.slice(0, 8)})`,
      };
    }
  }

  return { valid: true };
}

/**
 * Binds a test run to the current diff.
 */
export function bindTestEvidence(
  command: string,
  exitCode: number,
  outputSnippet: string,
  diff: string,
): TestEvidence {
  const diffHash = computeDiffHash(diff);
  return {
    command,
    passed: exitCode === 0,
    exitCode,
    diffHash,
    outputSnippet: outputSnippet.slice(0, 2000),
    timestamp: Date.now(),
  };
}

/**
 * Applies a child diff to the repository using git apply.
 */
export async function applyChildDiff(repoRoot: string, diff: string): Promise<boolean> {
  if (!diff.trim()) return true;
  try {
    const res = await git(repoRoot, ['apply', '--whitespace=nowarn'], {
      allowFailure: true,
      input: diff,
    });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Process and merge a child scope's return contract into the parent scope.
 */
export async function mergeChildResult(
  parentMemory: TypedMemory,
  result: ReturnContract,
  repoRoot: string,
): Promise<{
  merged: boolean;
  shouldRespawn: boolean;
  failureFact?: Fact | undefined;
  error?: string | undefined;
}> {
  const validation = validateReturnContract(result);
  if (!validation.valid) {
    // Record failed attempt in parent memory
    await parentMemory.recordFailedAttempt(
      result.scopeId,
      'child scope execution',
      validation.reason ?? 'invalid return contract',
    );
    return {
      merged: false,
      shouldRespawn: true,
      ...(validation.reason !== undefined ? { error: validation.reason } : {}),
    };
  }

  if (result.status === 'failed') {
    // Record failure in parent memory so respawned child knows what failed
    await parentMemory.recordFailedAttempt(
      result.scopeId,
      'child scope sub-problem',
      result.error ?? 'unknown child failure',
    );
    return {
      merged: false,
      shouldRespawn: true,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  // If there's a diff to apply
  if (result.diff.trim()) {
    const applied = await applyChildDiff(repoRoot, result.diff);
    if (!applied) {
      const err = 'Failed to apply child diff (conflict or unmergeable)';
      await parentMemory.recordFailedAttempt(result.scopeId, 'git apply child diff', err);
      return {
        merged: false,
        shouldRespawn: true,
        error: err,
      };
    }
  }

  // Merge child's verified facts into parent memory
  if (result.facts.length > 0) {
    await parentMemory.mergeFacts(result.facts);
  }

  // If solved and evidence exists, record as done in parent state
  if (result.status === 'solved' && result.evidence) {
    await parentMemory.addDoneItem(`Completed sub-problem: ${result.scopeId}`, result.evidence);
  }

  return {
    merged: true,
    shouldRespawn: false,
  };
}
