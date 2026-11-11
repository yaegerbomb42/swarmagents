import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TelemetryEvent } from '@/lib/sandboxTypes';

describe('telemetryBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          workers: [{ id: 'w1', model: 'gpt-test', status: 'ready' }],
        }),
      }),
    );
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('broadcasts agent updates to subscribed sinks', async () => {
    const { telemetryBridge } = await import('./telemetryBridge');
    const writes: string[] = [];
    const sink = {
      write: (data: string) => writes.push(data),
      closed: false,
    };

    const unsubscribe = telemetryBridge.subscribe('proj-1', sink);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetch).toHaveBeenCalled();
    expect(writes.some((w) => w.includes('w1'))).toBe(true);
    unsubscribe();
  });

  it('deduplicates identical worker snapshots', async () => {
    const { telemetryBridge } = await import('./telemetryBridge');
    const writes: string[] = [];
    const sink = {
      write: (data: string) => writes.push(data),
      closed: false,
    };

    telemetryBridge.subscribe('proj-dedup', sink);
    await vi.advanceTimersByTimeAsync(0);
    const afterFirst = writes.length;

    await vi.advanceTimersByTimeAsync(3000);
    expect(writes.length).toBe(afterFirst);

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workers: [{ id: 'w2', model: 'new-model', status: 'ready' }],
      }),
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(writes.length).toBeGreaterThan(afterFirst);
  });

  it('manual broadcast delivers SSE payload', async () => {
    const { telemetryBridge } = await import('./telemetryBridge');
    const writes: string[] = [];
    const sink = { write: (data: string) => writes.push(data), closed: false };

    telemetryBridge.subscribe('proj-manual', sink);
    const event: TelemetryEvent = {
      type: 'agent_update',
      agentId: 'agent-x',
      ts: 1,
      payload: { id: 'agent-x', status: 'running' },
    };
    telemetryBridge.broadcast('proj-manual', event);

    expect(writes[0]).toContain('agent-x');
    expect(writes[0]).toMatch(/^data: /);
  });
});
