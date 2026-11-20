import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { OmnexxConfig } from '../config/schema.js';
import type { Clock } from '../core/clock.js';
import type { EventLog } from '../core/events.js';
import type { ResolvedModel } from '../providers/pricing.js';
import {
  emptyUsage,
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type Message,
  type Provider,
} from '../providers/types.js';
import type { Tool, ToolContext } from '../tools/types.js';
import { runAgentLoop, type ControlSignal, type LoopDeps } from './loop.js';

const MODEL: ResolvedModel = {
  provider: 'test',
  alias: 'test-model',
  id: 'test-model-1',
  price: {
    id: 'test-model-1',
    input: 0,
    output: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
  },
};

const BUDGET = {
  max_usd: 1,
  max_usd_per_day: 1,
  max_hours: 1,
  max_cycles: 10,
  cycles_per_hour: 12,
  max_turns_per_cycle: 3,
  max_tokens_per_cycle: 1_000_000,
  max_cmd_timeout: 60_000,
  max_provider_wait: 1_000,
  warn_at: 0.8,
  wrapup_reserve: 0.08,
} as unknown as OmnexxConfig['budget'];

/** A clock the test drives by hand; `sleep` advances it instead of waiting. */
function testClock(start = 1_000): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new Error('aborted');
      now += ms;
    },
  };
}

function testEvents(): EventLog & { types: string[] } {
  const types: string[] = [];
  const stub = {
    types,
    emit: (type: string) => {
      types.push(type);
      return { type };
    },
    cycle: 0,
  };
  return stub as unknown as EventLog & { types: string[] };
}

function testToolCtx(): ToolContext {
  return {
    reads: new Map<string, string>(),
    redactor: { text: (text: string) => text },
    store: { logsDir: '/tmp/omnexx-loop-test' },
    env: {},
    cycle: 1,
    today: '2026-01-01',
    maxCmdTimeoutMs: 60_000,
    notesMaxTokens: 1_000,
    edited: new Set<string>(),
    nextCommandId: () => 'cmd-1',
  } as unknown as ToolContext;
}

const echoSchema = z.object({ text: z.string().optional() });

const echoTool: Tool<typeof echoSchema> = {
  name: 'echo',
  description: 'Echo a value without touching the workspace.',
  schema: echoSchema,
  readOnly: true,
  concurrent: true,
  run: async (input) => ({ content: `echo:${input.text ?? ''}` }),
};

function toolUse(id: string, name = 'echo', input: unknown = {}): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

/** A provider that calls one tool for `toolCalls` turns, then answers with text. */
function scriptedProvider(
  toolCalls: number,
  toolName = 'echo',
): Provider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    name: 'test',
    calls,
    complete: async (req) => {
      calls.push(req);
      const n = calls.length;
      const content: ContentBlock[] =
        n <= toolCalls ? [toolUse(`call-${n}`, toolName)] : [{ type: 'text', text: 'finished' }];
      const res: CompletionResponse = {
        content,
        stopReason: n <= toolCalls ? 'tool_use' : 'end_turn',
        usage: emptyUsage(),
        model: MODEL.id,
      };
      return res;
    },
  };
}

function deps(overrides: Partial<LoopDeps> = {}): LoopDeps {
  return {
    provider: scriptedProvider(0),
    models: [MODEL],
    tools: [echoTool],
    toolCtx: testToolCtx(),
    budget: BUDGET,
    maxTokens: 64,
    clock: testClock(),
    events: testEvents(),
    spentUsd: () => 0,
    onUsage: async () => undefined,
    control: async () => 'continue',
    ...overrides,
  };
}

const FIRST: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'do the task' }],
};

function run(overrides: Partial<LoopDeps> = {}) {
  const d = deps(overrides);
  return runAgentLoop({ system: [{ text: 'system' }], first: FIRST, tools: [] }, d);
}

describe('runAgentLoop termination', () => {
  it('stops at max_turns_per_cycle even while the model keeps calling tools', async () => {
    const provider = scriptedProvider(Infinity);
    const result = await run({ provider });

    expect(result.end).toBe('max_turns_per_cycle');
    expect(result.turns).toBe(3);
    expect(provider.calls).toHaveLength(3);

    // Every tool_use still has a tool_result, even on the turn that hits the ceiling.
    const assistantTurns = result.messages.filter(
      (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'),
    );
    expect(assistantTurns).toHaveLength(3);
    for (const turn of assistantTurns) {
      const id = turn.content.find((b) => b.type === 'tool_use');
      const next = result.messages[result.messages.indexOf(turn) + 1];
      expect(
        next?.content.some(
          (b) => b.type === 'tool_result' && b.toolUseId === (id as { id: string }).id,
        ),
      ).toBe(true);
    }
  });

  it('returns done when the model stops calling tools', async () => {
    const result = await run({ provider: scriptedProvider(1) });

    expect(result.end).toBe('done');
    expect(result.turns).toBe(2);
    expect(result.finalText).toBe('finished');
  });

  it('ends the cycle at the run deadline instead of paying for another turn', async () => {
    const clock = testClock(5_000);
    const provider = scriptedProvider(Infinity);
    const result = await run({
      clock,
      provider,
      deadlineMs: 4_999,
    });

    expect(result.end).toBe('stop');
    expect(result.detail).toBe('run deadline reached');
    expect(result.turns).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(result.messages).toHaveLength(1);
  });

  it('leaves a pause immediately when the abort signal is already set', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = testEvents();
    const pauses: boolean[] = [];
    const provider = scriptedProvider(Infinity);

    const result = await run({
      provider,
      events,
      signal: controller.signal,
      control: async () => 'pause' as ControlSignal,
      onPauseChange: (paused) => pauses.push(paused),
    });

    expect(result.end).toBe('stop-now');
    expect(result.turns).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(pauses).toEqual([true, false]);
    expect(events.types).toContain('control.aborted');
  });
});

describe('runAgentLoop abort pairing', () => {
  it('synthesizes an interrupted tool_result for a tool that ignores the signal', async () => {
    const controller = new AbortController();
    const provider = scriptedProvider(1, 'hang');
    const hanging: Tool = {
      name: 'hang',
      description: 'Never resolves; ignores the abort signal.',
      schema: z.object({}),
      readOnly: false,
      run: () => {
        queueMicrotask(() => controller.abort());
        return new Promise(() => undefined);
      },
    };

    const result = await run({
      provider,
      tools: [hanging],
      signal: controller.signal,
    });

    expect(result.end).toBe('stop-now');
    expect(provider.calls).toHaveLength(1);
    const toolResult = result.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result');
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call-1',
      isError: true,
    });
    expect(toolResult?.type === 'tool_result' ? toolResult.content : '').toContain(
      '[harness:interrupted]',
    );
  });
});
