import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Cockpit from './Cockpit';
import { dropRunStore } from '@/stores/runStore';

vi.mock('@/lib/auth', () => ({ authHeaders: (extra?: Record<string, string>) => ({ ...(extra ?? {}) }) }));

const events = [
  { v: 2, seq: 1, step: 0, kind: 'run.state', status: 'running' },
  { v: 2, seq: 2, step: 1, kind: 'tool_call', tool: 'shell_exec', params: { command: 'pytest -q' } },
  { v: 2, seq: 3, step: 1, kind: 'tool_result', tool: 'shell_exec', ok: false, exit_code: 1, ms: 2800, result: { stderr: 'E AssertionError' } },
  { v: 2, seq: 4, step: 2, kind: 'file.diff', path: 'src/a.ts', op: 'write', adds: 1, dels: 1, patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new' },
  { v: 2, seq: 5, step: 2, kind: 'decision', title: 'Verify JWT in middleware', confidence: 0.78 },
];

afterEach(() => { vi.unstubAllGlobals(); dropRunStore('run-t', 'live'); });

describe('Cockpit', () => {
  it('renders status, terminal, diff, decision from the stream and sends pause on space', async () => {
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(url); return new Response('{"ok":true}', { status: 200 }); }
      if (url.includes('stream=1')) return new Response(new ReadableStream({ start() { /* stay open */ } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      if (url.includes('/events')) {
        const since = Number(new URL(url, 'http://x').searchParams.get('since') ?? 0);
        return new Response(JSON.stringify({ events: since === 0 ? events : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ run_id: 'run-t', status: 'running', steps_done: 2, tokens_est: 1200, budgets: { max_steps: 100, max_wallclock_s: 3600, max_tokens: 100000 }, started_at: Date.now() / 1000 - 30 }), { status: 200 });
    }));
    render(<Cockpit runId="run-t" />);
    await waitFor(() => expect(screen.getByTestId('run-status')).toHaveTextContent('RUNNING'), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText('pytest -q')).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getAllByText('src/a.ts').length).toBeGreaterThan(0);
    expect(screen.getByText('Verify JWT in middleware')).toBeInTheDocument();
    await act(async () => { fireEvent.keyDown(window, { key: ' ' }); });
    await waitFor(() => expect(posts.some((u) => u.endsWith('/v1/runs/run-t/pause'))).toBe(true));
    await waitFor(() => expect(screen.getByText(/awaiting engine ack/)).toBeInTheDocument());
  });
});
