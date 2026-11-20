import { describe, expect, it } from 'vitest';
import {
  runCandidateSynthesis,
  sanitizeTouchedFiles,
  type StaticPreflightFilter,
} from '../../../src/agent/fsm/phases/synthesize.js';
import type { StructuredCaller } from '../../../src/agent/fsm/structured.js';

describe('Step 6.6: Phase C Candidate Synthesis with Constructive Diversity (N=3)', () => {
  const mockLocalization = {
    files: ['src/core/parser.ts'],
    spans: [{ path: 'src/core/parser.ts', startLine: 15, endLine: 30 }],
    confidence: 0.9,
  };

  const mockIntent = {
    rootCause: 'Unchecked null',
    fixStrategy: 'Add optional chaining',
    edgeCases: ['Empty string'],
  };

  it('sanitizeTouchedFiles filters out reproduction and test file modifications', () => {
    const files = [
      'src/core/parser.ts',
      '.omnexx-repro/__repro_123.test.ts',
      'test/parser.spec.ts',
      'src/__tests__/app.test.js',
    ];
    const sanitized = sanitizeTouchedFiles(files);
    expect(sanitized).toEqual(['src/core/parser.ts']);
  });

  it('generates N=3 diverse candidates across temperature and rung schedules', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async (req) => {
        await Promise.resolve();
        const configId = req.tools[0]?.name.replace('SynthesizePatch_', '') ?? 'c0';
        return {
          content: [
            {
              type: 'tool_use',
              id: `patch_${configId}`,
              name: 'answer',
              input: {
                hypothesis: `Candidate fix for ${configId}`,
                diff: `diff --git a/src/core/parser.ts b/src/core/parser.ts\n--- a/src/core/parser.ts\n+++ b/src/core/parser.ts\n@@ -15,1 +15,1 @@\n- return obj.val;\n+ return obj?.val ?? null;`,
                filesTouched: ['src/core/parser.ts'],
              },
            },
          ],
        };
      },
    };

    const candidates = await runCandidateSynthesis(
      'Null pointer in parser',
      mockLocalization,
      mockIntent,
      caller,
    );
    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.id).toBe('c0');
    expect(candidates[1]?.id).toBe('c1');
    expect(candidates[2]?.id).toBe('c2');
    expect(candidates[0]?.temperature).toBe(0.0);
    expect(candidates[1]?.temperature).toBe(0.3);
    expect(candidates[2]?.temperature).toBe(0.3);
    expect(candidates[2]?.rung).toBe(1);
  });

  it('preflight filter drops syntax-broken candidates before test execution', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async (req) => {
        await Promise.resolve();
        const configId = req.tools[0]?.name.replace('SynthesizePatch_', '') ?? 'c0';
        return {
          content: [
            {
              type: 'tool_use',
              id: `patch_${configId}`,
              name: 'answer',
              input: {
                hypothesis: `Fix for ${configId}`,
                diff: 'diff --git a/src/core/parser.ts...',
                filesTouched: ['src/core/parser.ts'],
              },
            },
          ],
        };
      },
    };

    const preflight: StaticPreflightFilter = {
      validateDiff: async () => {
        await Promise.resolve();
        // c1 introduces syntax error
        return { syntaxValid: false, diagnosticsDelta: 1 };
      },
    };

    const candidates = await runCandidateSynthesis(
      'Bug',
      mockLocalization,
      mockIntent,
      caller,
      preflight,
    );
    // All dropped due to preflight syntax failure
    expect(candidates).toHaveLength(0);
  });
});
