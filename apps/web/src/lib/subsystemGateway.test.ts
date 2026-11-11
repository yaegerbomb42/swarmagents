import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchDesktopLlmStatus, fetchModalAppsRegistry, fetchTestConsensus } from '@/lib/subsystemGateway';

describe('subsystemGateway', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/desktop-llm/status')) {
          return new Response(JSON.stringify({ available: true, metrics: {} }), { status: 200 });
        }
        if (url.includes('/api/modal-apps/registry')) {
          return new Response(
            JSON.stringify({ available: true, count: 1, apps: [{ id: 'test-app', endpoint: 'https://x' }] }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 404 });
      }),
    );
  });

  it('fetches desktop llm status via engine proxy', async () => {
    const status = await fetchDesktopLlmStatus();
    expect(status.available).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/engine/api/desktop-llm/status', expect.objectContaining({ cache: 'no-store' }));
  });

  it('fetches modal registry via engine proxy', async () => {
    const reg = await fetchModalAppsRegistry();
    expect(reg.count).toBe(1);
    expect(reg.apps[0].id).toBe('test-app');
  });

  it('fetches test consensus via engine proxy', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string) => {
      if (url.includes('/api/benchmark/test-consensus')) {
        return new Response(
          JSON.stringify({
            ok: true,
            demo: true,
            report: { trajectory_id: 't1', resolved: true, rounds: 2, winning_patch: 'fix-v2' },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    const res = await fetchTestConsensus(true);
    expect(res.report.resolved).toBe(true);
    expect(res.report.winning_patch).toBe('fix-v2');
  });
});
