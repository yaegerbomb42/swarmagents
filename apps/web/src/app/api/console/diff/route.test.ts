import { describe, it, expect } from 'vitest';
import { POST } from '@/app/api/console/diff/route';

describe('/api/console/diff POST', () => {
  it('approves a patch', async () => {
    const req = new Request('http://localhost/api/console/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'approve',
        sessionId: 'test-sess',
        filename: 'app.ts',
        patch: '+new line',
      }),
    });
    const res = await POST(req as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('approved');
  });

  it('rejects invalid action', async () => {
    const req = new Request('http://localhost/api/console/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'maybe', sessionId: 'x', filename: 'y' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});
