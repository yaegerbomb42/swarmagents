import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSwarmTelemetry } from '@/hooks/useSwarmTelemetry';

const swarmStatus = {
  status: 'active',
  agentCount: 4,
  activeTasks: 2,
  queuedTasks: 1,
  completedTasks: 9,
  collectiveHealth: 0.9,
  lifecycle: 'ACTIVE',
  throughput: 3.2,
};

const engineHealth = {
  status: 'healthy',
  active_agents: 4,
  tasks_queued: 1,
  tasks_running: 2,
  tasks_completed: 9,
  total_tokens: 12000,
  avg_latency_ms: 410,
};

describe('useSwarmTelemetry (real endpoints)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = String(url).includes('/api/engine/health') ? engineHealth : swarmStatus;
      return { ok: true, json: async () => body } as Response;
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('binds swarm status + engine health into counts, never touches SSE telemetry', async () => {
    const { result } = renderHook(() => useSwarmTelemetry(60_000));
    await waitFor(() => expect(result.current.engineReachable).toBe(true));
    expect(result.current.counts.agents).toBe(4);
    expect(result.current.counts.activeTasks).toBe(2);
    expect(result.current.counts.totalTokens).toBe(12000);
    expect(result.current.counts.avgLatencyMs).toBe(410);
    expect(result.current.phase).toBe('executing');
    expect(result.current.journal.length).toBeGreaterThan(0);
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/api/telemetry'))).toBe(false);
  });

  it('stays offline-safe with empty counts when both endpoints fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) } as Response)));
    const { result } = renderHook(() => useSwarmTelemetry(60_000));
    await waitFor(() => expect(result.current.lastUpdate).toBeGreaterThan(0));
    expect(result.current.engineReachable).toBe(false);
    expect(result.current.counts.totalTokens).toBeNull();
  });
});
