import { describe, expect, it } from 'vitest';
import {
  generateIntentSpec,
  admitReproTest,
  runSpecification,
  type ReproTestRunner,
} from '../../../src/agent/fsm/phases/specify.js';
import type { StructuredCaller } from '../../../src/agent/fsm/structured.js';

describe('Step 6.5: Phase B Specification & Reproduction Admission', () => {
  it('generateIntentSpec extracts root cause, fix strategy, and edge cases', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        return {
          content: [
            {
              type: 'tool_use',
              id: 'intent_1',
              name: 'answer',
              input: {
                rootCause: 'Missing null check on parsed token',
                fixStrategy: 'Add optional chaining and default fallback',
                edgeCases: ['Empty string token', 'Trailing whitespace'],
              },
            },
          ],
        };
      },
    };

    const intent = await generateIntentSpec(
      'TypeError: Cannot read property token of null',
      { files: ['src/parser.ts'], spans: [], confidence: 0.9 },
      caller,
    );

    expect(intent.rootCause).toContain('Missing null check');
    expect(intent.fixStrategy).toContain('optional chaining');
    expect(intent.edgeCases).toHaveLength(2);
  });

  it('admits reproduction test when it stably fails on baseline across 2 consecutive runs', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        return {
          content: [
            {
              type: 'tool_use',
              id: 'repro_1',
              name: 'answer',
              input: {
                candidates: [
                  {
                    path: 'test/repro.test.ts',
                    code: 'expect(parse(null)).toThrow()',
                    expectedError: 'TypeError',
                  },
                ],
              },
            },
          ],
        };
      },
    };

    let runsCount = 0;
    const runner: ReproTestRunner = {
      runOnBaseline: async () => {
        await Promise.resolve();
        runsCount += 1;
        // Both runs fail with exit code 1
        return { exitCode: 1, timedOut: false, output: 'AssertionError: expected throw' };
      },
    };

    const intent = { rootCause: 'Bug', fixStrategy: 'Fix', edgeCases: [] };
    const res = await admitReproTest('Bug', intent, caller, runner);

    expect(runsCount).toBe(2);
    expect(res.reproStatus).toBe('reproduced');
    expect(res.repro?.admitted).toBe(true);
    expect(res.repro?.baselineFailCount).toBe(2);
    expect(res.repro?.sha256).toBeDefined();
  });

  it('rejects test when it passes on baseline (not reproduced) and falls back to unavailable', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        return {
          content: [
            {
              type: 'tool_use',
              id: 'repro_1',
              name: 'answer',
              input: {
                candidates: [
                  {
                    path: 'test/repro.test.ts',
                    code: 'expect(true).toBe(true)',
                    expectedError: 'None',
                  },
                ],
              },
            },
          ],
        };
      },
    };

    const runner: ReproTestRunner = {
      runOnBaseline: async () => {
        await Promise.resolve();
        // Passes on baseline: not a valid bug reproduction!
        return { exitCode: 0, timedOut: false, output: 'All tests passed' };
      },
    };

    const intent = { rootCause: 'Bug', fixStrategy: 'Fix', edgeCases: [] };
    const res = await admitReproTest('Bug', intent, caller, runner);

    expect(res.reproStatus).toBe('unavailable');
    expect(res.repro).toBeUndefined();
  });

  it('rejects flaky test that passes on second run', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        return {
          content: [
            {
              type: 'tool_use',
              id: 'repro_1',
              name: 'answer',
              input: {
                candidates: [
                  {
                    path: 'test/flaky.test.ts',
                    code: 'flakyTest()',
                    expectedError: 'Timeout',
                  },
                ],
              },
            },
          ],
        };
      },
    };

    let runs = 0;
    const runner: ReproTestRunner = {
      runOnBaseline: async () => {
        await Promise.resolve();
        runs += 1;
        // Run 1 fails, Run 2 passes (flaky!)
        return { exitCode: runs === 1 ? 1 : 0, timedOut: false, output: 'Flaky' };
      },
    };

    const intent = { rootCause: 'Bug', fixStrategy: 'Fix', edgeCases: [] };
    const res = await admitReproTest('Bug', intent, caller, runner);

    expect(runs).toBe(2);
    expect(res.reproStatus).toBe('unavailable');
  });

  it('runSpecification orchestrator returns complete specification artifact', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        return {
          content: [
            {
              type: 'tool_use',
              id: 'spec_1',
              name: 'answer',
              input: {
                rootCause: 'Root Cause',
                fixStrategy: 'Strategy',
                edgeCases: [],
              },
            },
          ],
        };
      },
    };

    const res = await runSpecification(
      'Bug',
      { files: ['src/f.ts'], spans: [], confidence: 0.9 },
      caller,
    );
    expect(res.intent.rootCause).toBe('Root Cause');
    expect(res.reproStatus).toBe('unavailable');
  });
});
