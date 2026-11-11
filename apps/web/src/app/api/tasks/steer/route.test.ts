import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

afterEach(() => vi.unstubAllGlobals());

describe('/api/tasks/steer — harness runs', () => {
  it('forwards run-* ids to /v1/runs/{id}/steer and reports "sent", not applied', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, run_id: 'run-abc123', id: 'st-1' }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const req = new NextRequest('http://localhost/api/tasks/steer', {
      method: 'POST',
      headers: { authorization: 'Bearer u', 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run-abc123', message: 'focus on tests' }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'sent', runId: 'run-abc123' });
    expect(f).toHaveBeenCalledTimes(1); // no /health probe, no guessed endpoints
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/runs\/run-abc123\/steer$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ text: 'focus on tests', instruction: 'focus on tests' });
  });

  it('surfaces engine refusals honestly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'not steerable' }), { status: 409 })));
    const req = new NextRequest('http://localhost/api/tasks/steer', {
      method: 'POST',
      headers: { authorization: 'Bearer u', 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'run-zzz', message: 'x' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    expect((await res.json()).status).toBe('rejected');
  });
});
