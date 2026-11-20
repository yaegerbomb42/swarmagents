import { describe, it, expect } from 'vitest';
import { VerifierScope } from '../../../../src/agent/recursive/verifier-scope.js';
import { computeDiffHash } from '../../../../src/agent/recursive/return-contract.js';

describe('VerifierScope', () => {
  it('formats isolated verifier prompt without any transcript history', () => {
    const diff = '--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;';
    const hash = computeDiffHash(diff);
    const prompt = VerifierScope.formatVerifierPrompt({
      diff,
      diffHash: hash,
      acceptanceCriteria: ['Must update x to 2'],
      testOutput: '✓ app.test.ts (1 test passed)',
      exitCode: 0,
    });

    expect(prompt).toContain('# Independent Verification Scope');
    expect(prompt).toContain('Must update x to 2');
    expect(prompt).toContain('✓ app.test.ts');
    expect(prompt).toContain(hash.slice(0, 10));
    expect(prompt).not.toContain('User:');
    expect(prompt).not.toContain('Assistant:');
  });

  it('verifies valid green tests bound to diff hash', () => {
    const diff = '--- a/calc.ts\n+++ b/calc.ts\n@@ -1 +1 @@\n-return 0;\n+return a + b;';
    const hash = computeDiffHash(diff);
    const verdict = VerifierScope.verify({
      diff,
      diffHash: hash,
      acceptanceCriteria: ['Add function computes sum correctly'],
      testOutput: '✓ calc.test.ts (3 tests passed)',
      exitCode: 0,
    });

    expect(verdict.verified).toBe(true);
    expect(verdict.reason).toContain('All acceptance criteria satisfied');
  });

  it('rejects verification if exitCode is non-zero', () => {
    const diff = '--- a/calc.ts\n+++ b/calc.ts\n@@ -1 +1 @@\n-return 0;\n+return a - b;';
    const hash = computeDiffHash(diff);
    const verdict = VerifierScope.verify({
      diff,
      diffHash: hash,
      acceptanceCriteria: ['Add function computes sum'],
      testOutput: 'FAIL calc.test.ts: expected 4 to equal 2',
      exitCode: 1,
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('test suite exited with code 1');
  });

  it('rejects verification if diffHash does not match', () => {
    const diff = '--- a/calc.ts\n+++ b/calc.ts';
    const verdict = VerifierScope.verify({
      diff,
      diffHash: 'forged_or_stale_hash',
      acceptanceCriteria: ['Add function'],
      testOutput: 'PASS',
      exitCode: 0,
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('diffHash mismatch');
  });

  it('rejects empty diff when acceptance criteria exist', () => {
    const verdict = VerifierScope.verify({
      diff: '',
      diffHash: computeDiffHash(''),
      acceptanceCriteria: ['Feature must be implemented'],
      testOutput: 'PASS',
      exitCode: 0,
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('diff is empty');
  });

  it('flags anti-cheat patterns like adding .skip to tests', () => {
    const cheatingDiff =
      '--- a/calc.test.ts\n+++ b/calc.test.ts\n@@ -1 +1 @@\n-it("adds numbers", () => {\n+it.skip("adds numbers", () => {';
    const verdict = VerifierScope.verify({
      diff: cheatingDiff,
      diffHash: computeDiffHash(cheatingDiff),
      acceptanceCriteria: ['Feature must be tested'],
      testOutput: 'Test run passed (0 passed, 1 skipped)',
      exitCode: 0,
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('bypass assertions');
  });
});
