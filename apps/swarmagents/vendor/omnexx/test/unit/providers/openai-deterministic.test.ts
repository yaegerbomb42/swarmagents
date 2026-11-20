import { describe, expect, it } from 'vitest';
import { stableJsonStringify, prefixHash } from '../../../src/providers/cache-pinning.js';
import type { ToolSpec } from '../../../src/providers/types.js';

describe('Step 2.3: Deterministic Serialization for OpenAI / DeepSeek Endpoints', () => {
  it('produces identical serialized JSON strings regardless of key definition order', () => {
    const toolA: ToolSpec = {
      name: 'read_file',
      description: 'Reads a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'path to file' },
          start: { type: 'number', description: 'start line' },
          end: { type: 'number', description: 'end line' },
        },
        required: ['path'],
      },
    };

    const toolB: ToolSpec = {
      description: 'Reads a file',
      name: 'read_file',
      inputSchema: {
        required: ['path'],
        properties: {
          end: { description: 'end line', type: 'number' },
          path: { description: 'path to file', type: 'string' },
          start: { description: 'start line', type: 'number' },
        },
        type: 'object',
      },
    };

    const jsonA = stableJsonStringify(toolA);
    const jsonB = stableJsonStringify(toolB);

    expect(jsonA).toBe(jsonB);
  });

  it('computes identical prefix hashes for tools specified in different array orders and property orders', () => {
    const tools1: ToolSpec[] = [
      {
        name: 'write_file',
        description: 'Writes a file',
        inputSchema: { z: 1, a: 2 },
      },
      {
        name: 'bash',
        description: 'Executes command',
        inputSchema: { command: 'string', timeout: 1000 },
      },
    ];

    const tools2: ToolSpec[] = [
      {
        name: 'bash',
        description: 'Executes command',
        inputSchema: { timeout: 1000, command: 'string' },
      },
      {
        name: 'write_file',
        description: 'Writes a file',
        inputSchema: { a: 2, z: 1 },
      },
    ];

    const system = [{ text: 'System prompt' }];

    const hash1 = prefixHash({ system, tools: tools1 });
    const hash2 = prefixHash({ system, tools: tools2 });

    expect(hash1).toBe(hash2);
  });
});
