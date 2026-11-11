import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useAgentTelemetry } from './useAgentTelemetry';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  emit(type: string, data?: string) {
    const event = { data: data ?? '{}' } as MessageEvent;
    if (type === 'message' && this.onmessage) this.onmessage(event);
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  close() {
    /* noop */
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ sandboxes: [{ id: 'a1', agentId: 'a1', status: 'running' }] }),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useAgentTelemetry', () => {
  it('starts SSE and polling in globalMode without session context', async () => {
    const { result } = renderHook(() =>
      useAgentTelemetry({ enabled: true, globalMode: true, pollFallbackMs: 60_000 })
    );

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].url).toContain('projectId=default');

    MockEventSource.instances[0].onopen?.();
    await waitFor(() => expect(result.current.connected).toBe(true));
  });

  it('does not subscribe when disabled without context', () => {
    renderHook(() => useAgentTelemetry({ enabled: true, globalMode: false }));
    expect(MockEventSource.instances.length).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records latency after poll completes', async () => {
    const { result } = renderHook(() =>
      useAgentTelemetry({ enabled: true, globalMode: true, pollFallbackMs: 60_000 })
    );

    await waitFor(() => expect(result.current.latencyMs).not.toBeNull());
    expect(result.current.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('stays connected on heartbeat events', async () => {
    const { result } = renderHook(() =>
      useAgentTelemetry({ enabled: true, globalMode: true, pollFallbackMs: 60_000 })
    );

    await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    MockEventSource.instances[0].emit('heartbeat');
    await waitFor(() => expect(result.current.connected).toBe(true));
  });
});
