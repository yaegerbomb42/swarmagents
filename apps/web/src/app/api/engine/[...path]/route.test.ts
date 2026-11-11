import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SWARM_API_TOKEN;
});

describe('engine proxy', () => {
  it('streams SSE without a timeout, forwards Last-Event-ID, sets no-buffer headers', async () => {
    let seenInit: RequestInit | undefined;
    let seenUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seenUrl = url; seenInit = init;
      return new Response('id: 1\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': '99' },
      });
    }));
    const req = new NextRequest('http://localhost/api/engine/v1/runs/run-1/events?stream=1&since=4', {
      headers: { accept: 'text/event-stream', 'last-event-id': '4', authorization: 'Bearer user' },
    });
    const res = await GET(req, ctx(['v1', 'runs', 'run-1', 'events']));
    expect(seenUrl).toMatch(/\/v1\/runs\/run-1\/events\?stream=1&since=4$/);
    const h = seenInit!.headers as Record<string, string>;
    expect(h['last-event-id']).toBe('4');
    expect(h['accept-encoding']).toBe('identity');
    expect(seenInit!.signal).toBe(req.signal);
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toContain('id: 1');
  });

  it('swaps in SWARM_API_TOKEN for /v1/runs and requires a caller bearer', async () => {
    process.env.SWARM_API_TOKEN = 'srv';
    const f = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    const anon = new NextRequest('http://localhost/api/engine/v1/runs/run-1/pause', { method: 'POST' });
    expect((await POST(anon, ctx(['v1', 'runs', 'run-1', 'pause']))).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
    const authed = new NextRequest('http://localhost/api/engine/v1/runs/run-1/pause', { method: 'POST', headers: { authorization: 'Bearer user' } });
    expect((await POST(authed, ctx(['v1', 'runs', 'run-1', 'pause']))).status).toBe(200);
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer srv');
  });
});
