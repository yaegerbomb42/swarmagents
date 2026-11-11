import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authHeaders: () => ({ Authorization: 'Bearer test' }),
}));

import { apiGet, unifiedApi } from './api_client';

describe('api_client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes GET through /api/engine proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ status: 'ok' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await apiGet<{ status: string }>('/health');
    expect(data.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/engine/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('retries GET on 503 with exponential backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 'ok' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const promise = apiGet<{ status: string }>('/health');
    await vi.advanceTimersByTimeAsync(300);
    const data = await promise;

    expect(data.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('exposes unifiedApi shortcuts', () => {
    expect(typeof unifiedApi.health).toBe('function');
    expect(typeof unifiedApi.gatewayAudit).toBe('function');
    expect(typeof unifiedApi.hamiltonianPlan).toBe('function');
    expect(typeof unifiedApi.fleetStatus).toBe('function');
    expect(typeof unifiedApi.launchSnapshot).toBe('function');
    expect(typeof unifiedApi.v1Meta).toBe('function');
    expect(typeof unifiedApi.groupchatConsensus).toBe('function');
    expect(typeof unifiedApi.groupchatMessages).toBe('function');
    expect(typeof unifiedApi.groupchatSend).toBe('function');
    expect(typeof unifiedApi.reorderTasks).toBe('function');
    expect(typeof unifiedApi.sseLogsUrl).toBe('function');
  });
});
