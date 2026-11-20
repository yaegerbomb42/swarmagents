import { describe, expect, it } from 'vitest';
import {
  rankSuspectFiles,
  runLocalization,
  A4_MAX_TOTAL_CALLS,
  type A4ToolContext,
} from '../../../src/agent/fsm/phases/localize.js';
import type { StructuredCaller } from '../../../src/agent/fsm/structured.js';

describe('Step 6.4: Phase A Hierarchical Localization & Bounded Exploration (A4)', () => {
  it('rankSuspectFiles ranks files matching problem keywords', () => {
    const files = [
      'src/network/http.ts',
      'src/parser/ast.ts',
      'src/utils/logger.ts',
      'src/parser/lexer.ts',
    ];
    const ranked = rankSuspectFiles('Fix SyntaxError in parser ast generation', files);
    expect(ranked[0]).toBe('src/parser/ast.ts');
    expect(ranked[1]).toBe('src/parser/lexer.ts');
  });

  it('completes localization without A4 when confidence >= 0.5', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        return {
          content: [
            {
              type: 'tool_use',
              id: 'loc_1',
              name: 'answer',
              input: {
                files: ['src/parser/ast.ts'],
                spans: [
                  { path: 'src/parser/ast.ts', startLine: 12, endLine: 35, symbol: 'parseNode' },
                ],
                confidence: 0.85,
                exploredViaA4: false,
              },
            },
          ],
        };
      },
    };

    let a4Called = false;
    const toolCtx: A4ToolContext = {
      outline: async () => {
        await Promise.resolve();
        a4Called = true;
        return 'outline';
      },
    };

    const res = await runLocalization('Bug in parseNode', ['src/parser/ast.ts'], caller, toolCtx);
    expect(res.confidence).toBe(0.85);
    expect(res.exploredViaA4).toBe(false);
    expect(a4Called).toBe(false);
  });

  it('triggers A4 bounded exploration when initial confidence < 0.5', async () => {
    let callIndex = 0;
    let outlineCalls = 0;

    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        callIndex += 1;
        if (callIndex === 1) {
          // Initial low confidence call
          return {
            content: [
              {
                type: 'tool_use',
                id: 'loc_1',
                name: 'answer',
                input: {
                  files: ['src/parser/ast.ts'],
                  spans: [{ path: 'src/parser/ast.ts', startLine: 1, endLine: 10 }],
                  confidence: 0.35,
                  exploredViaA4: false,
                },
              },
            ],
          };
        }
        // Second call during A4 synthesis
        return {
          content: [
            {
              type: 'tool_use',
              id: 'a4_synth',
              name: 'answer',
              input: {
                spans: [
                  {
                    path: 'src/parser/ast.ts',
                    startLine: 45,
                    endLine: 60,
                    symbol: 'buildAst',
                  },
                ],
                confidence: 0.8,
              },
            },
          ],
        };
      },
    };

    const toolCtx: A4ToolContext = {
      outline: async () => {
        await Promise.resolve();
        outlineCalls += 1;
        return 'function buildAst() {}';
      },
    };

    const res = await runLocalization(
      'Unclear syntax error',
      ['src/parser/ast.ts'],
      caller,
      toolCtx,
    );
    expect(res.exploredViaA4).toBe(true);
    expect(outlineCalls).toBeGreaterThan(0);
    expect(outlineCalls).toBeLessThanOrEqual(A4_MAX_TOTAL_CALLS);
    expect(res.spans[0]?.symbol).toBe('buildAst');
  });
});
