import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeDiffHash,
  validateReturnContract,
  bindTestEvidence,
  mergeChildResult,
} from '../../../../src/agent/recursive/return-contract.js';
import { TypedMemory } from '../../../../src/agent/recursive/typed-memory.js';
import { type ReturnContract } from '../../../../src/agent/recursive/types.js';

describe('ReturnContract', () => {
  let tempDir: string;
  let repoDir: string;
  let parentMem: TypedMemory;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omnexx-rc-temp-'));
    repoDir = await mkdtemp(join(tmpdir(), 'omnexx-rc-repo-'));
    parentMem = new TypedMemory({
      scopeId: 'root',
      storageDir: tempDir,
      repoRoot: repoDir,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('computes deterministic diff hashes regardless of CRLF vs LF', () => {
    const diff1 = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const diff2 = '--- a/file.ts\r\n+++ b/file.ts\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n';
    expect(computeDiffHash(diff1)).toBe(computeDiffHash(diff2));
  });

  it('validates return contracts strictly', () => {
    const diff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-1\n+2';
    const hash = computeDiffHash(diff);
    const evidence = bindTestEvidence('npm test', 0, 'passed', diff);

    // Valid contract
    const validContract: ReturnContract = {
      scopeId: 'root.c1',
      status: 'solved',
      diff,
      diffHash: hash,
      facts: [],
      evidence,
    };
    expect(validateReturnContract(validContract).valid).toBe(true);

    // Invalid diffHash
    const badHashContract: ReturnContract = {
      ...validContract,
      diffHash: 'wronghash123',
    };
    expect(validateReturnContract(badHashContract).valid).toBe(false);

    // Solved without evidence
    const noEvidenceContract: ReturnContract = {
      ...validContract,
      evidence: undefined,
    };
    expect(validateReturnContract(noEvidenceContract).valid).toBe(false);

    // Solved with failed evidence
    const failedEvidence = bindTestEvidence('npm test', 1, 'failed assertion', diff);
    const failedEvidenceContract: ReturnContract = {
      ...validContract,
      evidence: failedEvidence,
    };
    expect(validateReturnContract(failedEvidenceContract).valid).toBe(false);
  });

  it('merges solved child results and records done item in parent memory', async () => {
    const diff = '';
    const hash = computeDiffHash(diff);
    const evidence = bindTestEvidence('npm test', 0, 'tests pass', diff);

    const contract: ReturnContract = {
      scopeId: 'root.c1',
      status: 'solved',
      diff,
      diffHash: hash,
      facts: [
        {
          id: 'fact-1',
          file: 'src/lib.ts',
          fileHash: 'abcdef',
          statement: 'Exports helper function',
          timestamp: Date.now(),
        },
      ],
      evidence,
    };

    const res = await mergeChildResult(parentMem, contract, repoDir);
    expect(res.merged).toBe(true);
    expect(res.shouldRespawn).toBe(false);

    const state = await parentMem.readState();
    expect(state.doneItems).toHaveLength(1);
    expect(state.doneItems[0]?.description).toContain('root.c1');

    const facts = await parentMem.readAllFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.statement).toBe('Exports helper function');
  });

  it('handles failed child scopes by recording failure in parent and triggering respawn', async () => {
    const contract: ReturnContract = {
      scopeId: 'root.c2',
      status: 'failed',
      diff: '',
      diffHash: computeDiffHash(''),
      facts: [],
      error: 'Circular dependency detected',
    };

    const res = await mergeChildResult(parentMem, contract, repoDir);
    expect(res.merged).toBe(false);
    expect(res.shouldRespawn).toBe(true);

    const failures = await parentMem.readFailedAttempts();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.target).toBe('root.c2');
    expect(failures[0]?.error).toBe('Circular dependency detected');
  });
});
