import { describe, expect, it } from 'vitest';
import { CacheOptimizedAssembler } from '../../../src/core/prompt-assembler.js';
import type { ToolSpec } from '../../../src/providers/types.js';

describe('Step 2.4: Three-Level Prompt Topology Assembler (CacheOptimizedAssembler)', () => {
  const mockTools: ToolSpec[] = [
    {
      name: 'read_file',
      description: 'Read file lines',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
    {
      name: 'bash',
      description: 'Run bash command',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ];

  const level0 = {
    systemPrompt: 'You are the omnexx worker agent.',
    tools: mockTools,
  };

  const level1 = {
    repoMap: 'src/core/loop.ts\nsrc/agent/context.ts',
    goal: 'Build high-performance coding agent runtime',
    facts: 'Node 22 ESM',
    repoRoot: '/Users/mock/repo',
  };

  it('strictly places Level 0 before Level 1 in system blocks and attaches cache breakpoint at Level 1 boundary', () => {
    const assembler = new CacheOptimizedAssembler();
    const topology = assembler.assemble(level0, level1, {
      taskId: 'M1.T01',
      taskTitle: 'Bootstrap runtime',
      messages: [],
    });

    // Level 0 is first
    expect(topology.system[0]?.text).toContain('You are the omnexx worker agent.');
    expect(topology.system[0]?.volatile).toBe(false);

    // Level 1 blocks follow
    expect(topology.system[1]?.text).toContain('src/core/loop.ts');
    expect(topology.system[2]?.text).toContain('# Goal');
    expect(topology.system[3]?.text).toContain('Node 22 ESM');

    // Breakpoint sits on the final Level 1 block
    const lastSystemBlock = topology.system[topology.system.length - 1];
    expect(lastSystemBlock?.cacheBreakpoint).toBe(true);

    // Tools are sorted alphabetically
    expect(topology.tools.map((t) => t.name)).toEqual(['bash', 'read_file']);
  });

  it('keeps prefix hash byte-for-byte identical across consecutive turns when clock or messages shift (Step 2.2 Acceptance)', () => {
    const assembler = new CacheOptimizedAssembler();

    const turn1 = assembler.assemble(level0, level1, {
      taskId: 'M1.T01',
      taskTitle: 'Bootstrap runtime',
      clock: '# Clock: Elapsed 10s',
      messages: [],
    });

    const turn2 = assembler.assemble(level0, level1, {
      taskId: 'M1.T01',
      taskTitle: 'Bootstrap runtime',
      clock: '# Clock: Elapsed 25s (pace: on track)',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'Inspecting workspace...' }] },
      ],
      edgeSummary: 'Completed initial directory check',
    });

    // Verify system blocks contain zero volatile blocks
    expect(turn1.system.some((b) => b.volatile)).toBe(false);
    expect(turn2.system.some((b) => b.volatile)).toBe(false);

    // Verify clock is never placed into system blocks
    for (const b of turn1.system) {
      expect(b.text).not.toContain('# Clock');
    }
    for (const b of turn2.system) {
      expect(b.text).not.toContain('# Clock');
    }

    // Verify clock is routed to Level 2 user message
    const userMsg1 = turn1.messages[0]?.content[0];
    const userMsg2 = turn2.messages[0]?.content[0];
    expect(userMsg1 && 'text' in userMsg1 ? userMsg1.text : '').toContain('# Clock: Elapsed 10s');
    expect(userMsg2 && 'text' in userMsg2 ? userMsg2.text : '').toContain('# Clock: Elapsed 25s');
    expect(userMsg2 && 'text' in userMsg2 ? userMsg2.text : '').toContain('<history_summary>');

    // Verify system texts are byte-identical
    expect(turn1.system.map((s) => s.text)).toEqual(turn2.system.map((s) => s.text));

    // Verify telemetry byte counts
    expect(turn1.layers.level0Bytes).toBeGreaterThan(0);
    expect(turn1.layers.level1Bytes).toBeGreaterThan(0);
    expect(turn2.layers.level2Bytes).toBeGreaterThan(turn1.layers.level2Bytes);
  });
});
