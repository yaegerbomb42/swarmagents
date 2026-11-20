import { describe, expect, it } from 'vitest';
import { microCompact } from '../../../src/agent/runtime/micro-compaction.js';
import type { Message } from '../../../src/providers/types.js';

describe('Step 3.5: Micro-Amortized History Compaction (micro-compaction.ts)', () => {
  const makeConversation = (): Message[] => [
    // Message 0: Frozen anchor
    { role: 'user', content: [{ type: 'text', text: 'Task M1.T01' }] },
    // Turn 1 (Cold): Read file
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'read_1', name: 'read_file', input: { path: 'a.ts' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'read_1',
          content: 'line 1\nline 2\n' + 'a'.repeat(500),
        },
      ],
    },
    // Turn 2 (Cold): Verbose build error
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'bash_1', name: 'bash', input: { command: 'npm test' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'bash_1',
          content:
            'FAIL src/app.test.ts\nError: Assert failed at Object.<anonymous> (test.ts:45)\n' +
            '    at runTest (runner.js:12)\n'.repeat(20),
          isError: true,
        },
      ],
    },
    // Turn 3 (Cold): Huge output
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'bash_huge', name: 'bash', input: { command: 'cat huge.log' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'bash_huge',
          content: 'LOG START: ' + 'x'.repeat(4000) + ' LOG END',
        },
      ],
    },
    // Turn 4 (Hot): Second identical read of a.ts
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'read_2', name: 'read_file', input: { path: 'a.ts' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'read_2',
          content: 'HOT READ RESULT: line 1\nline 2\n' + 'a'.repeat(500),
        },
      ],
    },
  ];

  it('respects compaction stride and skips non-stride turns', () => {
    const messages = makeConversation();
    const result = microCompact(messages, { turnIndex: 3, stride: 4 });
    expect(result.compacted).toBe(false);
    expect(result.charsSaved).toBe(0);
  });

  it('prunes cold superseded reads, collapses cold errors, and truncates huge cold outputs on stride turns', () => {
    const messages = makeConversation();
    // Turn 4 with hotWindowSize = 2 protects the latest turn (messages 6 & 7)
    const result = microCompact(messages, { turnIndex: 4, stride: 4, hotWindowSize: 2 });

    expect(result.compacted).toBe(true);
    expect(result.charsSaved).toBeGreaterThan(1000);

    // Rule A: Turn 1 read_1 is superseded by Turn 4 read_2
    const read1Result = result.messages[2]?.content[0];
    expect(read1Result && 'content' in read1Result ? read1Result.content : '').toContain(
      '[μc] superseded',
    );

    // Rule B: Turn 2 verbose error is collapsed to single-line summary
    const errorResult = result.messages[4]?.content[0];
    expect(errorResult && 'content' in errorResult ? errorResult.content : '').toContain(
      '[μc] resolved error: FAIL src/app.test.ts',
    );

    // Rule C: Turn 3 huge output (4000+ chars) is truncated in the middle
    const hugeResult = result.messages[6]?.content[0];
    expect(hugeResult && 'content' in hugeResult ? hugeResult.content : '').toContain(
      '[... truncated by micro-compaction',
    );

    // Hot Window: Message 7 (latest turn result) is strictly untouched
    const hotResult = result.messages[8]?.content[0];
    expect(hotResult && 'content' in hotResult ? hotResult.content : '').toContain(
      'HOT READ RESULT',
    );
  });
});
