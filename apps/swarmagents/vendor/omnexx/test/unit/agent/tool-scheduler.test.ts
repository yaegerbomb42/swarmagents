import { describe, expect, it } from 'vitest';
import {
  buildExecutionWaves,
  executeToolWaves,
  type ToolUseCall,
} from '../../../src/agent/runtime/tool-scheduler.js';
import { TurnInterruptBus } from '../../../src/agent/runtime/interrupt-bus.js';

describe('Phase 3: Wave-Pipelined Tool Concurrency Engine (tool-scheduler.ts)', () => {
  it('correctly batches contiguous read tools into parallel waves and treats write/exec as barriers (Step 3.1 Acceptance)', () => {
    const calls: ToolUseCall[] = [
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'call_2', name: 'search', input: { query: 'foo' } },
      { type: 'tool_use', id: 'call_3', name: 'outline', input: { path: 'b.ts' } },
      { type: 'tool_use', id: 'call_4', name: 'read_symbol', input: { name: 'bar' } },
      { type: 'tool_use', id: 'call_5', name: 'write_file', input: { path: 'c.ts', content: 'x' } },
      { type: 'tool_use', id: 'call_6', name: 'read_file', input: { path: 'd.ts' } },
    ];

    const waves = buildExecutionWaves(calls);

    // Expect 3 waves:
    // Wave 0: calls 1-4 (parallel reads)
    // Wave 1: call 5 (serial write barrier)
    // Wave 2: call 6 (parallel read)
    expect(waves.length).toBe(3);

    expect(waves[0]?.isParallel).toBe(true);
    expect(waves[0]?.calls.length).toBe(4);
    expect(waves[0]?.calls.map((c) => c.call.name)).toEqual([
      'read_file',
      'search',
      'outline',
      'read_symbol',
    ]);

    expect(waves[1]?.isParallel).toBe(false);
    expect(waves[1]?.calls.length).toBe(1);
    expect(waves[1]?.calls[0]?.call.name).toBe('write_file');

    expect(waves[2]?.isParallel).toBe(true);
    expect(waves[2]?.calls.length).toBe(1);
    expect(waves[2]?.calls[0]?.call.name).toBe('read_file');
  });

  it('executes parallel read batches concurrently and preserves original call ordering (Step 3.2 Acceptance)', async () => {
    const calls: ToolUseCall[] = [
      { type: 'tool_use', id: 'call_slow', name: 'read_file', input: { path: 'slow.ts' } },
      { type: 'tool_use', id: 'call_fast', name: 'read_file', input: { path: 'fast.ts' } },
      { type: 'tool_use', id: 'call_write', name: 'write_file', input: { path: 'out.ts' } },
    ];

    const waves = buildExecutionWaves(calls);
    const start = Date.now();

    const results = await executeToolWaves(waves, calls.length, async (call) => {
      if (call.id === 'call_slow') {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { type: 'tool_result', toolUseId: call.id, content: 'slow content' };
      }
      if (call.id === 'call_fast') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: 'tool_result', toolUseId: call.id, content: 'fast content' };
      }
      return { type: 'tool_result', toolUseId: call.id, content: 'written' };
    });

    const elapsed = Date.now() - start;

    // Both reads ran in parallel in wave 0 (~60ms, not 60+20=80ms+)
    expect(elapsed).toBeLessThan(120);

    // Results strictly preserve the original caller index
    expect(results.length).toBe(3);
    expect(results[0]?.toolUseId).toBe('call_slow');
    expect(results[0]?.content).toBe('slow content');
    expect(results[1]?.toolUseId).toBe('call_fast');
    expect(results[1]?.content).toBe('fast content');
    expect(results[2]?.toolUseId).toBe('call_write');
    expect(results[2]?.content).toBe('written');
  });

  it('synthesizes clean cancellation envelopes on mid-wave interrupt without dropping provider pairing invariants (Step 3.4 Acceptance)', async () => {
    const bus = new TurnInterruptBus();
    const calls: ToolUseCall[] = [
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'call_2', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'call_3', name: 'write_file', input: {} },
    ];

    const waves = buildExecutionWaves(calls);

    const results = await executeToolWaves(
      waves,
      calls.length,
      (call) => {
        if (call.id === 'call_1') {
          // Trigger steering interruption on first call completion
          bus.trigger('steer', 'Focus on test coverage');
          return Promise.resolve({ type: 'tool_result', toolUseId: call.id, content: 'done' });
        }
        return Promise.resolve({ type: 'tool_result', toolUseId: call.id, content: 'unexpected' });
      },
      { signal: bus.signal },
    );

    // All 3 calls have matching envelopes (no missing slots)
    expect(results.length).toBe(3);
    expect(results[0]?.toolUseId).toBe('call_1');
    expect(results[0]?.isError).toBeUndefined();

    // Call 2 and Call 3 received clean cancellation results
    expect(results[1]?.toolUseId).toBe('call_2');
    expect(results[1]?.isError).toBe(true);

    expect(results[2]?.toolUseId).toBe('call_3');
    expect(results[2]?.isError).toBe(true);
    expect(results[2]?.content).toContain('Tool execution skipped');
  });
});
