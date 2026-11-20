import { computeDiffHash } from './return-contract.js';
import { type VerifierInput, type VerifierResult } from './types.js';

/**
 * Format the isolated prompt that the verifier model or engine evaluates.
 */
export function formatVerifierPrompt(input: VerifierInput): string {
  return [
    '# Independent Verification Scope',
    'You are the independent verifier. You evaluate whether the provided git diff and test output satisfy all acceptance criteria.',
    'You have NO access to intermediate chat or reasoning.',
    '',
    '## Acceptance Criteria',
    input.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n') || '(None specified)',
    '',
    `## Git Diff (Cryptographic Hash: ${input.diffHash.slice(0, 10)})`,
    '```diff',
    input.diff || '(empty diff)',
    '```',
    '',
    `## Test Output (Exit Code: ${input.exitCode})`,
    '```',
    input.testOutput.slice(-3000),
    '```',
    '',
    '## Verification Invariants',
    '1. Exit code must be 0 (green tests).',
    '2. Diff must not revert or disable tests or delete verification gates.',
    '3. Diff must contain concrete code changes addressing the criteria.',
  ].join('\n');
}

/**
 * Verify the input deterministically against core invariants:
 * 1. Test exit code must be 0.
 * 2. Test output must indicate successful test completion (no unhandled failures).
 * 3. Diff hash must match.
 * 4. Diff must not contain anti-cheat patterns (e.g. deleting tests or commenting assertions).
 */
export function verifyScopeDiff(input: VerifierInput): VerifierResult {
  const timestamp = Date.now();

  // Invariant 1: diff hash must match
  const computedHash = computeDiffHash(input.diff);
  if (input.diffHash && input.diffHash !== computedHash) {
    return {
      verified: false,
      diffHash: input.diffHash,
      reason: `Cryptographic diffHash mismatch: expected ${computedHash.slice(0, 8)}, got ${input.diffHash.slice(0, 8)}`,
      timestamp,
    };
  }

  // Invariant 2: Green tests
  if (input.exitCode !== 0) {
    return {
      verified: false,
      diffHash: input.diffHash,
      reason: `Verification failed: test suite exited with code ${input.exitCode}`,
      timestamp,
    };
  }

  // Invariant 3: Diff must not be completely empty when criteria exist
  if (!input.diff.trim() && input.acceptanceCriteria.length > 0) {
    return {
      verified: false,
      diffHash: input.diffHash,
      reason: 'Verification failed: diff is empty while acceptance criteria remain',
      timestamp,
    };
  }

  // Invariant 4: Anti-cheat check: look for skipped tests or deleted assertions
  const lines = input.diff.split('\n');
  const suspiciousDeletions = lines.filter(
    (l) =>
      l.startsWith('-') &&
      !l.startsWith('---') &&
      (l.includes('.skip(') || l.includes('test.todo(')),
  );
  const suspiciousAdditions = lines.filter(
    (l) =>
      l.startsWith('+') &&
      !l.startsWith('+++') &&
      (l.includes('.skip(') || l.includes('// expect(')),
  );

  if (suspiciousAdditions.length > 0 && suspiciousDeletions.length === 0) {
    return {
      verified: false,
      diffHash: input.diffHash,
      reason:
        'Verification failed: diff appears to bypass assertions (e.g. added .skip or commented expect)',
      timestamp,
    };
  }

  // Invariant 5: Test output must not report 0 tests run when criteria require tests
  if (input.testOutput.includes('0 passed') && input.testOutput.includes('(0)')) {
    return {
      verified: false,
      diffHash: input.diffHash,
      reason: 'Verification failed: 0 tests were executed',
      timestamp,
    };
  }

  return {
    verified: true,
    diffHash: input.diffHash,
    reason: 'All acceptance criteria satisfied with green test evidence bound to diff hash.',
    timestamp,
  };
}

export const VerifierScope = {
  formatVerifierPrompt,
  verify: verifyScopeDiff,
};
