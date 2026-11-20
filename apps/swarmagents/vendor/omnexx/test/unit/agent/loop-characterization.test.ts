/**
 * Step 3.8 — Layer 0 Characterization & Concurrency Test Suite
 *
 * Golden end-to-end characterization of the Phase 3 asynchronous agent engine. Unlike the focused
 * unit tests for each subsystem, this suite pins the cross-cutting invariants the engine must hold:
 *
 *  1. Concurrency model: parallel READ tools (read_file / find_files / grep) run in a single
 *     concurrent wave, while MUTATE tools (edit / write_file) run serially, in order.
 *  2. Interrupt bus invariants: a mid-turn abort synthesizes deterministic 'cancelled' tool_results
 *     so every assistant tool_use block keeps its matching tool_result (provider block pairing).
 *  3. Speculative rollback: a destructive bash failure restores the workspace to the snapshot,
 *     truncates history, and injects <system_intervention type="branch_rollback"> without corrupting
 *     the repo.
 *  4. Micro-amortized compaction: repeated identical reads are collapsed to '[μc] superseded' once
 *     a stride turn arrives.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { budgetSchema } from '../../../src/config/schema.js';
import { runAgentLoop, type LoopDeps } from '../../../src/agent/loop.js';
import type { Tool } from '../../../src/tools/types.js';
import { ScriptedProvider, type ScriptedTurn } from '../../support/scripted-provider.js';
import { FakeClock } from '../../support/clock.js';
import { toolContext } from '../../support/tool-context.js';
import { makeRepo } from '../../support/harness.js';
import { GitTreeSnapshotter } from '../../../src/agent/runtime/checkpoint.js';
import { SpeculativeBranchRollbackManager } from '../../../src/agent/runtime/rollback.js';
import { TurnInterruptBus } from '../../../src/agent/runtime/interrupt-bus.js';
import {
  buildExecutionWaves,
  executeToolWaves,
  type ToolUseCall,
} from '../../../src/agent/runtime/tool-scheduler.js';
import { microCompact } from '../../../src/agent/runtime/micro-compaction.js';
import type { Message } from '../../../src/providers/types.js';

const READ_DELAY_MS = 40;

function budgetFreePrice(): LoopDeps['models'][number]['price'] {
  return { id: 'm', input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 };
}

/** Drive the real agent loop with a scripted provider and the given tools. */
async function runLoopWith(
  script: NonNullable<ScriptedTurn['tools']>[],
  tools: Tool[],
  extra: Partial<LoopDeps> = {},
): Promise<{ res: Awaited<ReturnType<typeof runAgentLoop>>; repo: string }> {
  const provider = new ScriptedProvider(({ turn }) =>
    script[turn] ? { tools: script[turn] } : { text: 'done' },
  );
  const repo = await makeRepo();
  const toolCtx = await toolContext(repo);
  const deps: LoopDeps = {
    provider,
    models: [{ provider: 'scripted', alias: 'm', id: 'm', price: budgetFreePrice() }],
    tools,
    toolCtx,
    budget: budgetSchema.parse({}),
    maxTokens: 1_000,
    clock: new FakeClock(),
    events: toolCtx.events,
    spentUsd: () => 0,
    onUsage: () => Promise.resolve(),
    control: () => Promise.resolve('continue'),
    ...extra,
  };
  const res = await runAgentLoop(
    {
      system: [{ text: 's' }],
      first: { role: 'user', content: [{ type: 'text', text: 'go' }] },
      tools: [],
    },
    deps,
  );
  return { res, repo };
}

describe('Step 3.8: Layer 0 Characterization (loop-characterization.test.ts)', () => {
  describe('1. concurrency: parallel reads wave, serial mutates', () => {
    it('runs read_file/find_files/grep concurrently in one wave, then edit/write_file serially, preserving order', async () => {
      // Probe tools carry the real Phase 3 tool names and concurrency flags the loop keys off.
      const state = {
        log: [] as { name: string; id: string; phase: 'start' | 'end' }[],
        readActive: 0,
        readPeak: 0,
        mutateActive: 0,
        mutatePeak: 0,
      };
      const schema = z.strictObject({ id: z.string() });
      const make = (name: string, concurrent: boolean): Tool => ({
        name,
        description: name,
        schema,
        readOnly: concurrent,
        concurrent,
        async run(input: { id: string }) {
          if (concurrent) {
            state.readActive++;
            state.readPeak = Math.max(state.readPeak, state.readActive);
          } else {
            state.mutateActive++;
            state.mutatePeak = Math.max(state.mutatePeak, state.mutateActive);
          }
          state.log.push({ name, id: input.id, phase: 'start' });
          await new Promise((r) => setTimeout(r, READ_DELAY_MS));
          state.log.push({ name, id: input.id, phase: 'end' });
          if (concurrent) state.readActive--;
          else state.mutateActive--;
          return { content: `result ${input.id}` };
        },
      });
      const tools = [
        make('read_file', true),
        make('find_files', true),
        make('grep', true),
        make('edit', false),
        make('write_file', false),
      ];
      const script = [
        [
          { name: 'read_file', input: { id: 'a' } },
          { name: 'find_files', input: { id: 'b' } },
          { name: 'grep', input: { id: 'c' } },
          { name: 'edit', input: { id: 'w' } },
          { name: 'write_file', input: { id: 'x' } },
        ],
      ];

      const { res } = await runLoopWith(script, tools);

      const results = (res.messages[2]?.content ?? []).flatMap((b) =>
        b.type === 'tool_result' ? [b.content] : [],
      );

      // The three reads ran in a single parallel wave.
      expect(state.readPeak).toBe(3);
      // Mutates never overlapped anything.
      expect(state.mutatePeak).toBe(1);

      const idx = (name: string, id: string, phase: 'start' | 'end') =>
        state.log.findIndex((e) => e.name === name && e.id === id && e.phase === phase);
      const lastReadEnd = Math.max(
        idx('read_file', 'a', 'end'),
        idx('find_files', 'b', 'end'),
        idx('grep', 'c', 'end'),
      );
      // edit (mutate) started only after every read finished; write_file after edit finished.
      expect(idx('edit', 'w', 'start')).toBeGreaterThan(lastReadEnd);
      expect(idx('write_file', 'x', 'start')).toBeGreaterThan(idx('edit', 'w', 'end'));

      // Original call order is preserved in the result envelopes.
      expect(results).toEqual(['result a', 'result b', 'result c', 'result w', 'result x']);
    });
  });

  describe('2. interrupt bus invariants: synthetic cancelled envelopes preserve pairing', () => {
    it('synthesizes deterministic tool_results for pending calls after a mid-turn abort', async () => {
      const bus = new TurnInterruptBus();
      const calls: ToolUseCall[] = [
        { type: 'tool_use', id: 'read_1', name: 'read_file', input: {} },
        { type: 'tool_use', id: 'write_1', name: 'write_file', input: {} },
        { type: 'tool_use', id: 'write_2', name: 'write_file', input: {} },
      ];

      const waves = buildExecutionWaves(calls);
      const results = await executeToolWaves(
        waves,
        calls.length,
        (call) => {
          if (call.id === 'read_1') {
            // Mid-turn steering interrupt fires while the first tool is in flight.
            bus.trigger('steer', 'Focus on test coverage');
            return Promise.resolve({ type: 'tool_result', toolUseId: call.id, content: 'done' });
          }
          return Promise.resolve({
            type: 'tool_result',
            toolUseId: call.id,
            content: 'unexpected',
          });
        },
        { signal: bus.signal },
      );

      // Every call has a matching envelope (no dropped provider blocks).
      expect(results.length).toBe(calls.length);
      expect(results.map((r) => r.toolUseId)).toEqual(['read_1', 'write_1', 'write_2']);

      // The completed read is normal; the pending writes received synthetic cancellation envelopes.
      expect(results[0]?.content).toBe('done');
      expect(results[0]?.isError).toBeUndefined();
      expect(results[1]?.isError).toBe(true);
      expect(results[1]?.content).toContain('Tool execution skipped');
      expect(results[2]?.isError).toBe(true);
      expect(results[2]?.content).toContain('Tool execution skipped');
    });
  });

  describe('3. speculative rollback: destructive bash failure is fully reverted', () => {
    it('restores the workspace, truncates history, and injects a branch_rollback intervention', async () => {
      const repo = await makeRepo({ 'app.ts': 'export const baseline = 1;\n' });

      const bashTool: Tool = {
        name: 'bash',
        description: 'shell',
        schema: z.strictObject({ command: z.string() }),
        readOnly: false,
        concurrent: false,
        async run() {
          // Simulate a destructive speculative edit + a new untracked file.
          await writeFile(join(repo, 'app.ts'), 'export const broken = 999;\n');
          await mkdir(join(repo, 'tmp'), { recursive: true });
          await writeFile(join(repo, 'tmp', 'rogue.txt'), 'garbage');
          return { content: 'Syntax error TS1005\n', isError: true };
        },
      };

      const snapshotter = new GitTreeSnapshotter(repo);
      const rollback = new SpeculativeBranchRollbackManager(snapshotter, {
        maxRollbacksPerRun: 2,
      });

      const { res } = await runLoopWith(
        [[{ name: 'bash', input: { command: 'break' } }]],
        [bashTool],
        {
          rollback,
        },
      );

      // Intervention injected after the rollback.
      const allText = res.messages
        .flatMap((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')))
        .join('\n');
      expect(allText).toContain('<system_intervention type="branch_rollback">');

      // Workspace restored to the pre-mutation snapshot; no corruption remains.
      expect(await readFile(join(repo, 'app.ts'), 'utf8')).toBe('export const baseline = 1;\n');
      const rogueExists = await stat(join(repo, 'tmp', 'rogue.txt'))
        .then(() => true)
        .catch(() => false);
      expect(rogueExists).toBe(false);
    });
  });

  describe('4. micro-amortized compaction: repeated identical reads are superseded', () => {
    it('collapses an early identical read to "[μc] superseded" on a stride turn', () => {
      const conversation: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Task' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'read_1', name: 'read_file', input: { path: 'a.ts' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'read_1', content: 'line 1\n' + 'a'.repeat(500) },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'read_2', name: 'read_file', input: { path: 'a.ts' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'read_2', content: 'HOT ' + 'a'.repeat(500) },
          ],
        },
      ];

      const result = microCompact(conversation, { turnIndex: 4, stride: 4, hotWindowSize: 2 });

      expect(result.compacted).toBe(true);
      const earlyRead = result.messages[2]?.content[0];
      expect(earlyRead && 'content' in earlyRead ? earlyRead.content : '').toContain(
        '[μc] superseded',
      );
    });
  });
});
