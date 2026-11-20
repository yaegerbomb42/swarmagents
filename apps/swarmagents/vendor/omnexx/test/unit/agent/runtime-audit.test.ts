/**
 * Subsystem 1 audit — Agent Runtime, Concurrency & Interrupt Engine.
 *
 * Merged audit: this file combines two parallel Subsystem 1 audits on
 * audit/subsystem-1-agent-runtime — the landed origin suite (8 tests, kept
 * verbatim) and the rebased suite below. Where they disagreed, the landed
 * design wins: invalid maxConcurrency falls back to the default 4, and the
 * final fill synthesizes an `unknown-<i>` envelope for an uncovered index
 * instead of failing loudly (pinned by a CHAR test; the residual provider-400
 * risk is an open question for the PR).
 *
 * Mandate: no bug report or audit claim without a reproducing Vitest unit test.
 * Every finding below is either
 *   (a) a test that FAILS before its minimal fix and passes after it (marked BUG), or
 *   (b) a characterization test pinning the correct behavior (marked CHAR).
 *
 * Coverage map (checklist):
 *   1. Unhandled rejections & process leaks — scheduler abort race, PTY/process-registry
 *      pid -1 signalling, dispose ordering.
 *   2. Provider contract invariant — every tool_use gets a 1:1 tool_result at the same
 *      index, through success, tool error, executor throw, timeout, abort, duplicate ids,
 *      empty calls, and unknown tools (loop.ts runCall + executeToolWaves).
 *   3. Concurrency wave edge cases — empty/single/all-read/all-mutate/mixed waves,
 *      mutation failure mid-wave, abort between waves, duplicate ids, maxConcurrency clamp.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { budgetSchema } from '../../../src/config/schema.js';
import { runAgentLoop, type LoopDeps } from '../../../src/agent/loop.js';
import type { Tool } from '../../../src/tools/types.js';
import { ScriptedProvider, type ScriptedTurn } from '../../support/scripted-provider.js';
import { FakeClock } from '../../support/clock.js';
import { toolContext } from '../../support/tool-context.js';
import { makeRepo } from '../../support/harness.js';
import { isolatedEnv } from '../../support/tmp.js';
import { resolvePaths, runDir } from '../../../src/core/paths.js';
import { bindRun, killRunChildren, type ChildEntry } from '../../../src/core/process-registry.js';
import { pidAlive } from '../../../src/core/lock.js';
import { PtyBridge, type PtyBackend, type PtyExitInfo } from '../../../src/sandbox/pty-bridge.js';
import { TurnInterruptBus } from '../../../src/agent/runtime/interrupt-bus.js';
import {
  buildExecutionWaves,
  executeToolWaves,
  type ExecutionWave,
  type ToolExecutor,
  type ToolResultBlock,
  type ToolUseCall,
} from '../../../src/agent/runtime/tool-scheduler.js';
import { microCompact } from '../../../src/agent/runtime/micro-compaction.js';
import type { ContentBlock, Message } from '../../../src/providers/types.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeCall = (id: string, name: string): ToolUseCall => ({
  type: 'tool_use',
  id,
  name,
  input: {},
});

const okResult = (call: ToolUseCall, content: string): ToolResultBlock => ({
  type: 'tool_result',
  toolUseId: call.id,
  content,
});

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
    models: [
      {
        provider: 'scripted',
        alias: 'm',
        id: 'm',
        price: {
          id: 'm',
          input: 0,
          output: 0,
          cache_write_5m: 0,
          cache_write_1h: 0,
          cache_read: 0,
        },
      },
    ],
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

const loopToolSchema = z.strictObject({ id: z.string() });

function makeLoopTool(
  name: string,
  run: (input: { id: string }) => Promise<{ content: string }>,
  concurrent = false,
): Tool {
  return {
    name,
    description: name,
    schema: loopToolSchema,
    readOnly: concurrent,
    concurrent,
    run,
  };
}

const toolUseBlocks = (
  message: Message | undefined,
): Extract<ContentBlock, { type: 'tool_use' }>[] =>
  (message?.content ?? []).filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );

const toolResultBlocks = (
  message: Message | undefined,
): Extract<ContentBlock, { type: 'tool_result' }>[] =>
  (message?.content ?? []).filter(
    (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
  );

describe('Subsystem 1 Audit: Mid-Wave Abort & Process Cleanup', () => {
  it('handles AbortSignal mid-wave with zero unhandled rejections and synthesizes envelopes', async () => {
    const controller = new AbortController();
    const calls: ToolUseCall[] = [
      { type: 'tool_use', id: 'call_fast', name: 'read_file', input: { path: 'fast.ts' } },
      { type: 'tool_use', id: 'call_mid', name: 'read_file', input: { path: 'mid.ts' } },
      { type: 'tool_use', id: 'call_slow', name: 'read_file', input: { path: 'slow.ts' } },
      { type: 'tool_use', id: 'call_pending', name: 'read_file', input: { path: 'pending.ts' } },
    ];

    const waves = buildExecutionWaves(calls);
    const unhandledRejections: unknown[] = [];
    const rejectionHandler = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', rejectionHandler);

    try {
      const results = await executeToolWaves(
        waves,
        calls.length,
        async (call, signal) => {
          if (call.id === 'call_fast') {
            return { type: 'tool_result', toolUseId: call.id, content: 'fast success' };
          }
          if (call.id === 'call_mid') {
            // Abort mid-wave
            controller.abort(new Error('Mid-wave user abort'));
            return { type: 'tool_result', toolUseId: call.id, content: 'mid finished before trip' };
          }
          if (call.id === 'call_slow') {
            // Hang until signal or timeout
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                resolve({ type: 'tool_result', toolUseId: call.id, content: 'slow finished' });
              }, 200);
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('Operation aborted'));
              });
            });
          }
          return { type: 'tool_result', toolUseId: call.id, content: 'pending finished' };
        },
        { signal: controller.signal, maxConcurrency: 2 },
      );

      // Verify zero unhandled promise rejections occurred
      expect(unhandledRejections).toHaveLength(0);

      // Verify strict contract: every single tool call has a result at identical index
      expect(results).toHaveLength(4);
      expect(results[0]?.toolUseId).toBe('call_fast');
      expect(results[0]?.content).toBe('fast success');

      expect(results[1]?.toolUseId).toBe('call_mid');
      expect(results[1]?.content).toBe('mid finished before trip');

      // The slow and pending calls must be safely synthesized with error/cancellation results
      expect(results[2]?.toolUseId).toBe('call_slow');
      expect(results[2]?.isError).toBe(true);

      expect(results[3]?.toolUseId).toBe('call_pending');
      expect(results[3]?.isError).toBe(true);
      expect(results[3]?.content).toContain('Tool execution skipped');
    } finally {
      process.off('unhandledRejection', rejectionHandler);
    }
  });

  it('latching behavior in TurnInterruptBus prevents redundant abort signals', () => {
    const bus = new TurnInterruptBus();
    const firedEvents: string[] = [];

    const unsubscribe = bus.onInterrupt((event) => {
      firedEvents.push(event.reason);
    });

    expect(bus.isInterrupted).toBe(false);
    expect(bus.reason).toBeNull();

    bus.trigger('steer', 'First interrupt');
    expect(bus.isInterrupted).toBe(true);
    expect(bus.reason).toBe('steer');
    expect(bus.payload).toBe('First interrupt');

    // Subsequent trigger should be a no-op (latched)
    bus.trigger('cancel', 'Second interrupt');
    expect(bus.reason).toBe('steer');
    expect(bus.payload).toBe('First interrupt');
    expect(firedEvents).toEqual(['steer']);

    unsubscribe();
    bus.reset();
    expect(bus.isInterrupted).toBe(false);
    expect(bus.reason).toBeNull();
  });
});

describe('Subsystem 1 Audit: Strict Provider Contract Invariants', () => {
  it('strictly enforces tool_result envelope count and 1-to-1 index matching', async () => {
    const calls: ToolUseCall[] = [
      { type: 'tool_use', id: 'call_alpha', name: 'read_file', input: { path: '1.ts' } },
      { type: 'tool_use', id: 'call_beta', name: 'write_file', input: { path: '2.ts' } },
      { type: 'tool_use', id: 'call_gamma', name: 'read_file', input: { path: '3.ts' } },
    ];

    const waves = buildExecutionWaves(calls);

    const results = await executeToolWaves(waves, calls.length, (call) => {
      if (call.id === 'call_beta') {
        return Promise.reject(new Error('Disk full'));
      }
      return Promise.resolve({
        type: 'tool_result',
        toolUseId: call.id,
        content: `output-${call.id}`,
      });
    });

    expect(results).toHaveLength(3);
    for (let i = 0; i < calls.length; i++) {
      expect(results[i]?.type).toBe('tool_result');
      expect(results[i]?.toolUseId).toBe(calls[i]?.id);
    }
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.content).toContain('Disk full');
  });

  it('overwrites corrupted or mismatched toolUseId returned by buggy executor', async () => {
    const calls: ToolUseCall[] = [
      { type: 'tool_use', id: 'call_expected_1', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'call_expected_2', name: 'read_file', input: {} },
    ];

    const waves = buildExecutionWaves(calls);

    // Buggy executor returns wrong toolUseId
    const results = await executeToolWaves(waves, calls.length, (call) =>
      Promise.resolve({
        type: 'tool_result',
        toolUseId: 'corrupted_foreign_id',
        content: `ran ${call.name}`,
      }),
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.toolUseId).toBe('call_expected_1');
    expect(results[1]?.toolUseId).toBe('call_expected_2');
  });
});

describe('Subsystem 1 Audit: Concurrency Boundaries & Edge Cases', () => {
  it('respects maxConcurrency = 1 strictly serializing parallel waves', async () => {
    const calls: ToolUseCall[] = [
      { type: 'tool_use', id: 'c1', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'c2', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'c3', name: 'read_file', input: {} },
    ];

    const waves = buildExecutionWaves(calls);
    let activeWorkers = 0;
    let maxObservedConcurrency = 0;

    await executeToolWaves(
      waves,
      calls.length,
      async (call) => {
        activeWorkers++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeWorkers);
        await new Promise((r) => setTimeout(r, 20));
        activeWorkers--;
        return { type: 'tool_result', toolUseId: call.id, content: 'done' };
      },
      { maxConcurrency: 1 },
    );

    expect(maxObservedConcurrency).toBe(1);
  });

  it('handles invalid maxConcurrency gracefully (0, -5, NaN, Infinity)', async () => {
    const calls: ToolUseCall[] = [
      { type: 'tool_use', id: 'c1', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'c2', name: 'read_file', input: {} },
    ];
    const waves = buildExecutionWaves(calls);

    for (const badConcurrency of [0, -5, NaN, Infinity]) {
      const results = await executeToolWaves(
        waves,
        calls.length,
        (call) =>
          Promise.resolve({
            type: 'tool_result',
            toolUseId: call.id,
            content: 'ok',
          }),
        { maxConcurrency: badConcurrency },
      );

      expect(results).toHaveLength(2);
      expect(results[0]?.toolUseId).toBe('c1');
      expect(results[1]?.toolUseId).toBe('c2');
    }
  });

  it('handles zero calls cleanly without errors', async () => {
    const waves: ExecutionWave[] = [];
    const results = await executeToolWaves(waves, 0, (call) =>
      Promise.resolve({
        type: 'tool_result',
        toolUseId: call.id,
        content: '',
      }),
    );

    expect(results).toEqual([]);
  });
});

describe('Subsystem 1 Audit: Micro-Compaction Invariants', () => {
  it('protects hot window and applies periodic stride compaction', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Task request' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'test.ts' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tu1',
            content: 'very long content '.repeat(30), // > 200 chars
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu2', name: 'read_file', input: { path: 'test.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tu2', content: 'new content' }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'hot 1' }] },
      { role: 'user', content: [{ type: 'text', text: 'hot 2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hot 3' }] },
      { role: 'user', content: [{ type: 'text', text: 'hot 4' }] },
    ];

    // Stride check: stride 4, turn 3 -> should skip
    const skipped = microCompact(messages, { turnIndex: 3, stride: 4 });
    expect(skipped.compacted).toBe(false);

    // Stride check: stride 4, turn 4 -> should compact superseded reads
    const result = microCompact(messages, { turnIndex: 4, stride: 4, hotWindowSize: 4 });
    expect(result.compacted).toBe(true);
    expect(result.rulesApplied.supersededReads).toBe(1);

    const compactedMsg = result.messages[2];
    expect(compactedMsg?.content[0]?.type).toBe('tool_result');
    if (compactedMsg?.content[0]?.type === 'tool_result') {
      expect(compactedMsg.content[0].content).toContain('[μc] superseded');
    }
  });
});

describe('Subsystem 1 audit: concurrency waves (executeToolWaves)', () => {
  it('CHAR: empty wave list returns an empty result list', async () => {
    expect(
      await executeToolWaves([], 0, () =>
        Promise.resolve(okResult(makeCall('x', 'read_file'), 'x')),
      ),
    ).toEqual([]);
  });

  it('CHAR: a single read-only tool runs in one parallel wave and keeps its id', async () => {
    const calls = [makeCall('r1', 'read_file')];
    const results = await executeToolWaves(buildExecutionWaves(calls), calls.length, (call) =>
      Promise.resolve(okResult(call, 'content')),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.toolUseId).toBe('r1');
    expect(results[0]?.content).toBe('content');
  });

  it('CHAR: all read-only tools run in parallel and results preserve call order', async () => {
    const calls = [makeCall('a', 'read_file'), makeCall('b', 'search'), makeCall('c', 'grep')];
    let inFlight = 0;
    let peak = 0;
    const results = await executeToolWaves(
      buildExecutionWaves(calls),
      calls.length,
      async (call) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(20);
        inFlight--;
        return okResult(call, `out-${call.id}`);
      },
    );
    expect(peak).toBe(3);
    expect(results.map((r) => r.toolUseId)).toEqual(['a', 'b', 'c']);
    expect(results.map((r) => r.content)).toEqual(['out-a', 'out-b', 'out-c']);
  });

  it('CHAR: all mutation tools run serially, one at a time, in order', async () => {
    const calls = [makeCall('w1', 'write_file'), makeCall('w2', 'edit'), makeCall('w3', 'bash')];
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const results = await executeToolWaves(
      buildExecutionWaves(calls),
      calls.length,
      async (call) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        order.push(call.id);
        await sleep(5);
        inFlight--;
        return okResult(call, `out-${call.id}`);
      },
    );
    expect(peak).toBe(1);
    expect(order).toEqual(['w1', 'w2', 'w3']);
    expect(results.map((r) => r.toolUseId)).toEqual(['w1', 'w2', 'w3']);
  });

  it('CHAR: a mutation serializes against concurrent reads — reads after it start only once it ends', async () => {
    const calls = [
      makeCall('r1', 'read_file'),
      makeCall('r2', 'read_file'),
      makeCall('m1', 'write_file'),
      makeCall('r3', 'read_file'),
    ];
    const log: string[] = [];
    const results = await executeToolWaves(
      buildExecutionWaves(calls),
      calls.length,
      async (call) => {
        log.push(`start:${call.id}`);
        await sleep(call.id === 'm1' ? 30 : 10);
        log.push(`end:${call.id}`);
        return okResult(call, `out-${call.id}`);
      },
    );
    // Wave 0 (r1, r2) runs before the mutation barrier; r3 starts only after m1 ends.
    expect(log.indexOf('start:r3')).toBeGreaterThan(log.indexOf('end:m1'));
    expect(log.indexOf('start:m1')).toBeGreaterThan(log.indexOf('end:r1'));
    expect(log.indexOf('start:m1')).toBeGreaterThan(log.indexOf('end:r2'));
    expect(results.map((r) => r.toolUseId)).toEqual(['r1', 'r2', 'm1', 'r3']);
  });

  it('CHAR: a mutation that fails mid-wave still runs later waves and preserves earlier results', async () => {
    const calls = [
      makeCall('r1', 'read_file'),
      makeCall('m1', 'write_file'),
      makeCall('r2', 'read_file'),
    ];
    const ran: string[] = [];
    const executor: ToolExecutor = (call) => {
      ran.push(call.id);
      if (call.id === 'm1') return Promise.reject(new Error('disk full'));
      return Promise.resolve(okResult(call, `out-${call.id}`));
    };
    const results = await executeToolWaves(buildExecutionWaves(calls), calls.length, executor);
    expect(ran).toEqual(['r1', 'm1', 'r2']);
    expect(results[0]?.content).toBe('out-r1');
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.content).toContain('disk full');
    expect(results[2]?.content).toBe('out-r2');
  });

  it('CHAR: abort between waves synthesizes skipped envelopes and never starts later calls', async () => {
    const bus = new TurnInterruptBus();
    const calls = [
      makeCall('r1', 'read_file'),
      makeCall('m1', 'write_file'),
      makeCall('r2', 'read_file'),
    ];
    const ran: string[] = [];
    const results = await executeToolWaves(
      buildExecutionWaves(calls),
      calls.length,
      (call) => {
        ran.push(call.id);
        if (call.id === 'r1') {
          bus.trigger('cancel');
          return Promise.resolve(okResult(call, 'out-r1'));
        }
        return Promise.resolve(okResult(call, 'unexpected'));
      },
      { signal: bus.signal },
    );
    expect(ran).toEqual(['r1']);
    expect(results).toHaveLength(3);
    expect(results[0]?.content).toBe('out-r1');
    expect(results[0]?.isError).toBeUndefined();
    expect(results[1]?.toolUseId).toBe('m1');
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.content).toContain('Tool execution skipped');
    expect(results[2]?.toolUseId).toBe('r2');
    expect(results[2]?.isError).toBe(true);
  });

  it('CHAR: duplicate tool_use ids pass through positionally (two results, same id)', async () => {
    const calls = [makeCall('dup', 'read_file'), makeCall('dup', 'read_file')];
    const results = await executeToolWaves(buildExecutionWaves(calls), calls.length, (call) =>
      Promise.resolve(okResult(call, `out-${call.id}`)),
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.toolUseId)).toEqual(['dup', 'dup']);
  });

  it('CHAR: invalid maxConcurrency (0, -5, NaN, Infinity) falls back to the default 4', async () => {
    const calls = [
      makeCall('a', 'read_file'),
      makeCall('b', 'read_file'),
      makeCall('c', 'read_file'),
    ];
    // Origin's invalid-maxConcurrency test pins the result shape; this one pins
    // the concurrency actually observed: the fallback is 4, so all three calls
    // run at once instead of being serialized to 1.
    for (const badConcurrency of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let inFlight = 0;
      let peak = 0;
      const results = await executeToolWaves(
        buildExecutionWaves(calls),
        calls.length,
        async (call) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(5);
          inFlight--;
          return okResult(call, `out-${call.id}`);
        },
        { maxConcurrency: badConcurrency },
      );
      expect(peak).toBe(3);
      expect(results.map((r) => r.toolUseId)).toEqual(['a', 'b', 'c']);
    }
  });

  it('BUG: abort mid-wave resolves even when the executor ignores the signal and never settles', async () => {
    const bus = new TurnInterruptBus();
    const calls = [makeCall('never_1', 'read_file')];
    setTimeout(() => {
      bus.trigger('cancel');
    }, 10);
    const results = await executeToolWaves(
      buildExecutionWaves(calls),
      calls.length,
      () => new Promise<ToolResultBlock>(() => undefined),
      { signal: bus.signal },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.toolUseId).toBe('never_1');
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain('Tool execution skipped');
  }, 1000);

  it('CHAR: an uncovered index gets an unknown-<i> envelope (landed fallback; residual provider-400 risk, see PR)', async () => {
    const calls = [makeCall('only_1', 'read_file')];
    const results = await executeToolWaves(buildExecutionWaves(calls), 2, (call) =>
      Promise.resolve(okResult(call, 'ok')),
    );
    // The landed final-fill synthesizes an envelope for the uncovered slot with
    // a fabricated id. No tool_use with that id exists, so a strict provider
    // would reject the result — this test pins the behavior, it does not bless it.
    expect(results).toHaveLength(2);
    expect(results[0]?.toolUseId).toBe('only_1');
    expect(results[1]?.toolUseId).toBe('unknown-1');
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.content).toContain('Tool execution skipped');
  });
});

describe('Subsystem 1 audit: provider contract invariant (loop.ts runCall)', () => {
  it('CHAR: a successful tool call yields a 1:1 tool_use/tool_result pair at the same index', async () => {
    const read = makeLoopTool(
      'read_file',
      () => Promise.resolve({ content: 'file content' }),
      true,
    );
    const { res } = await runLoopWith(
      [
        [
          { name: 'read_file', input: { id: 'a' } },
          { name: 'read_file', input: { id: 'b' } },
        ],
      ],
      [read],
    );
    expect(res.end).toBe('done');
    const uses = toolUseBlocks(res.messages[1]);
    const results = toolResultBlocks(res.messages[2]);
    expect(uses).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.toolUseId)).toEqual(uses.map((u) => u.id));
    expect(results.map((r) => r.content)).toEqual(['file content', 'file content']);
    expect(results.map((r) => r.isError)).toEqual([undefined, undefined]);
  });

  it('BUG: a tool whose run() throws still yields an error tool_result (loop does not throw)', async () => {
    const boom = makeLoopTool('boom', () => Promise.reject(new Error('kaboom')));
    const { res } = await runLoopWith([[{ name: 'boom', input: { id: 'x' } }]], [boom]);
    expect(res.end).toBe('done');
    const uses = toolUseBlocks(res.messages[1]);
    const results = toolResultBlocks(res.messages[2]);
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.toolUseId).toBe(uses[0]?.id);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain('kaboom');
  });

  it('BUG: a throwing systemOne.afterTool hook still yields an error tool_result (loop does not throw)', async () => {
    const read = makeLoopTool(
      'read_file',
      () => Promise.resolve({ content: 'file content' }),
      true,
    );
    const { res } = await runLoopWith([[{ name: 'read_file', input: { id: 'a' } }]], [read], {
      systemOne: {
        onPrompt: () => Promise.resolve(undefined),
        beforeTool: () => Promise.resolve(undefined),
        afterTool: () => Promise.reject(new Error('triage boom')),
        afterTurn: () => Promise.resolve(undefined),
      },
    });
    expect(res.end).toBe('done');
    const uses = toolUseBlocks(res.messages[1]);
    const results = toolResultBlocks(res.messages[2]);
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.toolUseId).toBe(uses[0]?.id);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain('triage boom');
  });

  it('CHAR: an unknown tool name yields an error tool_result, not a dropped call', async () => {
    const read = makeLoopTool(
      'read_file',
      () => Promise.resolve({ content: 'file content' }),
      true,
    );
    const { res } = await runLoopWith([[{ name: 'no_such_tool', input: { id: 'x' } }]], [read]);
    expect(res.end).toBe('done');
    const uses = toolUseBlocks(res.messages[1]);
    const results = toolResultBlocks(res.messages[2]);
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.toolUseId).toBe(uses[0]?.id);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain('unknown tool');
  });

  it('CHAR: invalid tool input yields an error tool_result, not a dropped call', async () => {
    const read = makeLoopTool(
      'read_file',
      () => Promise.resolve({ content: 'file content' }),
      true,
    );
    const { res } = await runLoopWith([[{ name: 'read_file', input: {} }]], [read]);
    expect(res.end).toBe('done');
    const uses = toolUseBlocks(res.messages[1]);
    const results = toolResultBlocks(res.messages[2]);
    expect(uses).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.toolUseId).toBe(uses[0]?.id);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain('invalid input for read_file');
  });

  it('CHAR: a turn with no tool calls ends cleanly with no tool_result message', async () => {
    const read = makeLoopTool(
      'read_file',
      () => Promise.resolve({ content: 'file content' }),
      true,
    );
    const { res } = await runLoopWith([], [read]);
    expect(res.end).toBe('done');
    expect(res.messages).toHaveLength(2);
    expect(res.messages[1]?.role).toBe('assistant');
    expect(toolResultBlocks(res.messages[1])).toHaveLength(0);
  });
});

describe('Subsystem 1 audit: interrupt bus (interrupt-bus.ts)', () => {
  it('CHAR: trigger latches — later triggers are ignored', () => {
    const bus = new TurnInterruptBus();
    const seen: string[] = [];
    bus.onInterrupt((event) => {
      seen.push(event.reason);
    });
    bus.trigger('steer');
    bus.trigger('cancel');
    expect(seen).toEqual(['steer']);
    expect(bus.signal.aborted).toBe(true);
    expect(bus.reason).toBe('steer');
    expect(bus.signal.reason).toBeInstanceOf(Error);
  });

  it('CHAR: reset re-arms the bus with a fresh, un-aborted signal', () => {
    const bus = new TurnInterruptBus();
    bus.trigger('steer');
    bus.reset();
    expect(bus.signal.aborted).toBe(false);
    expect(bus.reason).toBeNull();
    const seen: string[] = [];
    bus.onInterrupt((event) => {
      seen.push(event.reason);
    });
    bus.trigger('cancel');
    expect(seen).toEqual(['cancel']);
  });

  it('CHAR: unsubscribe stops notifications', () => {
    const bus = new TurnInterruptBus();
    const seen: string[] = [];
    const off = bus.onInterrupt((event) => {
      seen.push(event.reason);
    });
    off();
    bus.trigger('steer');
    expect(seen).toEqual([]);
  });

  it('CHAR: a throwing listener does not prevent other listeners from firing', () => {
    const bus = new TurnInterruptBus();
    const seen: string[] = [];
    bus.onInterrupt(() => {
      throw new Error('listener boom');
    });
    bus.onInterrupt((event) => {
      seen.push(event.reason);
    });
    bus.trigger('steer');
    expect(seen).toEqual(['steer']);
  });

  it('CHAR: trigger payload reaches listeners', () => {
    const bus = new TurnInterruptBus();
    const seen: unknown[] = [];
    bus.onInterrupt((event) => {
      seen.push(event.payload);
    });
    bus.trigger('steer', 'Focus on test coverage');
    expect(seen).toEqual(['Focus on test coverage']);
    expect(bus.payload).toBe('Focus on test coverage');
  });
});

describe('Subsystem 1 audit: micro-compaction (micro-compaction.ts)', () => {
  const toolResult = (id: string, content: string, isError: boolean): Message => ({
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: id, content, isError }],
  });

  /** 9 messages: anchor + 4 turns. Cold zone is [1, 3): the turn-1 tool_use and its result. */
  const conversation = (coldContent: string, coldIsError = false): Message[] => [
    { role: 'user', content: [{ type: 'text', text: 'Task' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'read_1', name: 'read_file', input: { path: 'a.ts' } }],
    },
    toolResult('read_1', coldContent, coldIsError),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'bash_1', name: 'bash', input: { command: 'npm test' } }],
    },
    toolResult('bash_1', 'ok', false),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'bash_2', name: 'bash', input: { command: 'ls' } }],
    },
    toolResult('bash_2', 'ok2', false),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'read_2', name: 'read_file', input: { path: 'b.ts' } }],
    },
    toolResult('read_2', 'hot content', false),
  ];

  const coldResultBlock = (
    messages: Message[],
  ): Extract<ContentBlock, { type: 'tool_result' }> | undefined => toolResultBlocks(messages[2])[0];

  it('BUG: Rule C with a small maxColdChars must not inflate the output or report a negative omitted count', () => {
    const original = 'R'.repeat(600);
    const result = microCompact(conversation(original), {
      turnIndex: 4,
      stride: 4,
      maxColdChars: 500,
    });
    expect(result.compacted).toBe(true);
    const cold = coldResultBlock(result.messages);
    expect(cold).toBeDefined();
    // The 600-char output must shrink, not grow to ~1,060 chars via a fixed 1,000+400 split.
    expect(cold?.content.length).toBeLessThan(600);
    expect(cold?.content).not.toContain('-800 cold characters omitted');
    expect(result.charsSaved).toBeGreaterThan(0);
  });

  it('CHAR: Rule C on a long output keeps the head and tail with a correct omitted count', () => {
    const original = 'x'.repeat(4000);
    const result = microCompact(conversation(original), { turnIndex: 4, stride: 4 });
    const cold = coldResultBlock(result.messages);
    expect(cold?.content).toContain('2600 cold characters omitted');
    expect(cold?.content.startsWith('x'.repeat(1000))).toBe(true);
    expect(cold?.content.endsWith('x'.repeat(400))).toBe(true);
    expect(cold?.content.length).toBeLessThan(4000);
  });

  it('CHAR: Rule B collapses a verbose cold error to its first line even with no later success', () => {
    const original = 'FAIL first line\n' + 'x'.repeat(390);
    const result = microCompact(conversation(original, true), { turnIndex: 4, stride: 4 });
    const cold = coldResultBlock(result.messages);
    expect(result.compacted).toBe(true);
    expect(cold?.content).toBe('[μc] resolved error: FAIL first line');
  });

  it('CHAR: Rule B leaves a short cold error untouched', () => {
    const original = 'ERR\n' + 'x'.repeat(100);
    const result = microCompact(conversation(original, true), { turnIndex: 4, stride: 4 });
    const cold = coldResultBlock(result.messages);
    expect(cold?.content).toBe(original);
  });
});

describe('Subsystem 1 audit: process cleanup — failed spawns must never signal PID 1', () => {
  it('BUG: disposing a PTY whose spawn failed does not signal PID 1 and registers no -1 pid', async () => {
    const kills: { pid: number; signal: string }[] = [];
    const spy = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid: number, signal?: string | number) => {
        kills.push({ pid, signal: typeof signal === 'string' ? signal : String(signal ?? '') });
        return true;
      });
    const register = vi.fn<(entry: ChildEntry) => void>();
    const unregister = vi.fn<(pid: number) => void>();
    try {
      const bridge = new PtyBridge({
        command: 'omnexx-audit-no-such-command-xyz',
        registry: { register, unregister },
      });
      bridge.start();
      await bridge.dispose();
      // A failed spawn leaves pid -1: process.kill(-(-1)) would target PID 1 and
      // process.kill(-1) would broadcast to every process the caller may signal.
      expect(kills.some((k) => k.pid === 1 || k.pid === -1)).toBe(false);
      expect(register.mock.calls.some((call) => call[0].pid <= 0)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('BUG: killRunChildren on a stale -1 entry does not signal PID 1 or broadcast to -1', async () => {
    // A pid of -1 is never a live process: process.kill(-1, 0) returns true in
    // this environment, so pidAlive(-1) must not report it as alive.
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    const env = await isolatedEnv();
    const paths = resolvePaths(env);
    const runId = 'r_audit_pid';
    const dir = runDir(paths, runId);
    await mkdir(dir, { recursive: true });
    // Simulate a children.json written before the fix (failed PTY spawn registered pid -1).
    await writeFile(
      join(dir, 'children.json'),
      JSON.stringify([{ pid: -1, pgid: -1, kind: 'task', command: 'dead' }]),
      'utf8',
    );
    // bindRun is only needed so the run dir resolves the same way the reaper sees it.
    bindRun(paths, runId);
    const kills: { pid: number; signal: string }[] = [];
    const spy = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid: number, signal?: string | number) => {
        kills.push({ pid, signal: typeof signal === 'string' ? signal : String(signal ?? '') });
        return true;
      });
    try {
      const result = await killRunChildren(paths, runId, { graceMs: 100 });
      expect(kills.some((k) => k.pid === 1 || k.pid === -1)).toBe(false);
      expect(result.survivors).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('CHAR: dispose sends SIGTERM, waits for exit, then SIGKILLs, and unregisters (fake backend)', async () => {
    const kills: string[] = [];
    const exitCbs = new Set<(info: PtyExitInfo) => void>();
    const fakeBackend: PtyBackend = {
      pid: 4242,
      exitCode: null,
      write: () => undefined,
      resize: () => undefined,
      onData: () => () => undefined,
      onExit: (cb) => {
        exitCbs.add(cb);
        return () => {
          exitCbs.delete(cb);
        };
      },
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        kills.push(signal);
        if (signal === 'SIGTERM') {
          for (const cb of [...exitCbs]) cb({ exitCode: 0, signal: null });
        }
      },
    };
    const register = vi.fn<(entry: ChildEntry) => void>();
    const unregister = vi.fn<(pid: number) => void>();
    const bridge = new PtyBridge({
      command: 'sleep 30',
      backend: () => fakeBackend,
      registry: { register, unregister },
    });
    bridge.start();
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242 }));
    await bridge.dispose();
    // Note: SIGKILL is sent even though the backend already exited on SIGTERM —
    // a dead group is a no-op for the real backends, and the test pins that order.
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(unregister).toHaveBeenCalledWith(4242);
    await bridge.dispose();
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
