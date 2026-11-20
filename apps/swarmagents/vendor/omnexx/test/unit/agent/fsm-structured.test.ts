import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  structuredCall,
  type StructuredCaller,
  type StructuredSpec,
} from '../../../src/agent/fsm/structured.js';

describe('Step 6.3: Universal structuredCall Contract', () => {
  const testSchema = z.object({
    filePath: z.string(),
    lineCount: z.number().int().positive(),
  });

  type TestType = z.infer<typeof testSchema>;

  it('returns valid data immediately when model answers properly', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        return {
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'answer',
              input: { filePath: 'src/main.ts', lineCount: 42 },
            },
          ],
        };
      },
    };

    const spec: StructuredSpec<TestType> = {
      name: 'TestAnswer',
      system: 'You are a test helper',
      prompt: 'Analyze file',
      schema: testSchema,
    };

    const res = await structuredCall(caller, spec);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.filePath).toBe('src/main.ts');
      expect(res.data.lineCount).toBe(42);
      expect(res.turns).toBe(1);
      expect(res.escalated).toBe(false);
    }
  });

  it('handles repair turn when schema validation fails initially', async () => {
    let callCount = 0;
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        callCount += 1;
        if (callCount === 1) {
          // Bad input: lineCount is negative
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'answer',
                input: { filePath: 'src/main.ts', lineCount: -5 },
              },
            ],
          };
        }
        // Repaired on turn 2
        return {
          content: [
            {
              type: 'tool_use',
              id: 'call_2',
              name: 'answer',
              input: { filePath: 'src/main.ts', lineCount: 10 },
            },
          ],
        };
      },
    };

    const spec: StructuredSpec<TestType> = {
      name: 'TestAnswer',
      system: 'You are a test helper',
      prompt: 'Analyze file',
      schema: testSchema,
    };

    const res = await structuredCall(caller, spec);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.lineCount).toBe(10);
      expect(res.turns).toBe(2);
      expect(res.escalated).toBe(false);
    }
  });

  it('runs ground-truth validator and triggers repair when validation fails', async () => {
    let callCount = 0;
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        callCount += 1;
        if (callCount === 1) {
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'answer',
                input: { filePath: 'nonexistent.ts', lineCount: 10 },
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'tool_use',
              id: 'call_2',
              name: 'answer',
              input: { filePath: 'src/real.ts', lineCount: 10 },
            },
          ],
        };
      },
    };

    const spec: StructuredSpec<TestType> = {
      name: 'TestAnswer',
      system: 'You are a test helper',
      prompt: 'Analyze file',
      schema: testSchema,
      validator: (data) => {
        if (data.filePath === 'nonexistent.ts') {
          return { valid: false, error: "File 'nonexistent.ts' does not exist on disk." };
        }
        return { valid: true };
      },
    };

    const res = await structuredCall(caller, spec);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.filePath).toBe('src/real.ts');
      expect(res.turns).toBe(2);
    }
  });

  it('escalates to Tier 2/3 when cheap repair turns fail', async () => {
    let escalatedSeen = false;

    const caller: StructuredCaller = {
      cheapComplete: async (_req, opts) => {
        await Promise.resolve();
        if (opts?.escalate) {
          escalatedSeen = true;
          return {
            content: [
              {
                type: 'tool_use',
                id: 'call_esc',
                name: 'answer',
                input: { filePath: 'src/escalated.ts', lineCount: 100 },
              },
            ],
          };
        }
        // Always fail on unescalated attempts
        return {
          content: [
            {
              type: 'tool_use',
              id: 'call_bad',
              name: 'answer',
              input: { filePath: 'bad', lineCount: -1 },
            },
          ],
        };
      },
    };

    const spec: StructuredSpec<TestType> = {
      name: 'TestAnswer',
      system: 'You are a test helper',
      prompt: 'Analyze file',
      schema: testSchema,
    };

    const res = await structuredCall(caller, spec);
    expect(res.success).toBe(true);
    expect(escalatedSeen).toBe(true);
    if (res.success) {
      expect(res.data.filePath).toBe('src/escalated.ts');
      expect(res.escalated).toBe(true);
    }
  });

  it('returns SCHEMA_EXHAUSTED when model fails all repair and escalation attempts', async () => {
    const caller: StructuredCaller = {
      cheapComplete: async () => {
        await Promise.resolve();
        return {
          content: [
            {
              type: 'text',
              text: 'I cannot answer this.',
            },
          ],
        };
      },
    };

    const spec: StructuredSpec<TestType> = {
      name: 'TestAnswer',
      system: 'You are a test helper',
      prompt: 'Analyze file',
      schema: testSchema,
    };

    const res = await structuredCall(caller, spec);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toBe('SCHEMA_EXHAUSTED');
      expect(res.turns).toBe(4); // 1 initial + 2 repairs + 1 escalated
      expect(res.escalated).toBe(true);
    }
  });
});
