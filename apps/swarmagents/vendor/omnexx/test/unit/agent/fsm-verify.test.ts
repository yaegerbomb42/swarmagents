import { describe, expect, it } from 'vitest';
import {
  checkImportPathSentinel,
  computeClusterSizes,
  runParallelVerification,
} from '../../../src/agent/fsm/phases/verify.js';
import type { CandidatePatch } from '../../../src/agent/fsm/types.js';

describe('Step 6.7: Phase D Parallel Verification & Import-Path Sentinel', () => {
  it('checkImportPathSentinel validates package path containment', () => {
    const root = '/tmp/worktree/verify-1';
    expect(checkImportPathSentinel(root, '/tmp/worktree/verify-1/lib/index.js')).toBe(true);
    expect(checkImportPathSentinel(root, '/usr/local/lib/node_modules/pkg/index.js')).toBe(false);
  });

  it('computeClusterSizes groups candidates touching identical files', () => {
    const candidates: CandidatePatch[] = [
      {
        id: 'c0',
        rung: 0,
        temperature: 0,
        hypothesis: 'h0',
        diff: 'diff 1',
        filesTouched: ['src/a.ts', 'src/b.ts'],
        syntaxValid: true,
        diagnosticsDelta: 0,
      },
      {
        id: 'c1',
        rung: 0,
        temperature: 0.3,
        hypothesis: 'h1',
        diff: 'diff 2',
        filesTouched: ['src/b.ts', 'src/a.ts'], // Same files, different order
        syntaxValid: true,
        diagnosticsDelta: 0,
      },
      {
        id: 'c2',
        rung: 1,
        temperature: 0.3,
        hypothesis: 'h2',
        diff: 'diff 3',
        filesTouched: ['src/c.ts'],
        syntaxValid: true,
        diagnosticsDelta: 0,
      },
    ];

    const clusters = computeClusterSizes(candidates);
    expect(clusters.get('c0')).toBe(2);
    expect(clusters.get('c1')).toBe(2);
    expect(clusters.get('c2')).toBe(1);
  });

  it('runParallelVerification evaluates candidates in parallel and flags ENV_ERROR on escape', async () => {
    const candidates: CandidatePatch[] = [
      {
        id: 'c0',
        rung: 0,
        temperature: 0,
        hypothesis: 'Valid fix',
        diff: 'diff --git a/a.ts b/a.ts\n+ fixed\n- broken',
        filesTouched: ['src/a.ts'],
        syntaxValid: true,
        diagnosticsDelta: 0,
      },
      {
        id: 'c1',
        rung: 0,
        temperature: 0.3,
        hypothesis: 'Host escape fix',
        diff: 'diff --git a/b.ts b/b.ts\n+ fixed',
        filesTouched: ['src/b.ts'],
        syntaxValid: true,
        diagnosticsDelta: 0,
      },
    ];

    const res = await runParallelVerification(candidates, {
      repoRoot: '/tmp/repo-worktree',
      problemStatement: 'Problem with a.ts',
      runTestOnCandidate: async (c) => {
        await Promise.resolve();
        if (c.id === 'c0') {
          return {
            candidateId: c.id,
            exitCode: 0,
            reproPassed: true,
            newFailures: [],
            importPathChecks: [
              {
                packageName: 'my-pkg',
                resolvedFile: '/tmp/repo-worktree/node_modules/my-pkg/index.js',
              },
            ],
          };
        }
        return {
          candidateId: c.id,
          exitCode: 0,
          reproPassed: true,
          newFailures: [],
          importPathChecks: [
            { packageName: 'my-pkg', resolvedFile: '/usr/local/lib/node_modules/my-pkg/index.js' }, // Escape!
          ],
        };
      },
    });

    expect(res.evaluations).toHaveLength(2);
    expect(res.evaluations[0]?.clean).toBe(true);
    expect(res.evaluations[0]?.newFailuresCount).toBe(0);
    expect(res.evaluations[0]?.reproPassed).toBe(true);
    expect(res.envErrors).toHaveLength(1);
    expect(res.envErrors[0]).toContain('ENV_ERROR: Candidate c1 resolved my-pkg to host path');
  });
});
