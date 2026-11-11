import { describe, expect, it, vi } from 'vitest';
import { backoffMs, frameToRecord, loadHistory, runStreamLoop, SseParser, streamUrl } from './useRunStream';
import { RunStore } from '@/stores/runStore';

vi.mock('@/lib/auth', () => ({ authHeaders: (extra?: Record<string, string>) => ({ Authorization: 'Bearer t', ...(extra ?? {}) }) }));

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
}

describe('SseParser', () => {
  it('parses frames split across chunks, CRLF, comments and multi-line data', () => {
    const p = new SseParser();
    const out = [
      ...p.feed('retry: 2000\n\n: hb\n\nid: 1\ndata: {"kind":"run.st'),
      ...p.feed('ate","seq":1}\r\n\r\nid: 2\r'),
      ...p.feed('\ndata: a\ndata: b\n\n'),
    ];
    expect(out).toEqual([
      { id: '1', event: undefined, data: '{"kind":"run.state","seq":1}', retry: undefined },
      { id: '2', event: undefined, data: 'a\nb', retry: undefined },
    ]);
    expect(p.comments).toBe(1);
    expect(p.lastEventId).toBe('2');
  });

  it('maps legacy named frames and status strings', () => {
    expect(frameToRecord({ event: 'status', data: 'running' })).toEqual({ kind: 'run.state', status: 'running' });
    expect(frameToRecord({ event: 'tool_call', data: '{"tool":"x"}' })).toEqual({ tool: 'x', kind: 'tool_call' });
    expect(frameToRecord({ id: '9', data: '{"kind":"finish"}' })).toEqual({ kind: 'finish', seq: 9 });
    // synthetic frames never adopt an id as seq
    expect(frameToRecord({ data: '{"kind":"run.state","status":"finished","synthetic":true,"seq":4}' })).toMatchObject({ synthetic: true });
  });
});

describe('resume', () => {
  it('builds since= only when we have server seqs', () => {
    expect(streamUrl('run-1', -1, false)).toBe('/api/engine/v1/runs/run-1/events?stream=1');
    expect(streamUrl('run-1', 41, true)).toBe('/api/engine/v1/runs/run-1/events?stream=1&since=41');
  });

  it('backoff is exponential and capped', () => {
    const r = () => 1;
    expect(backoffMs(0, 500, 30_000, r)).toBe(500);
    expect(backoffMs(3, 500, 30_000, r)).toBe(4000);
    expect(backoffMs(20, 500, 30_000, r)).toBe(30_000);
  });

  it('reconnects with since/Last-Event-ID after a drop and stops on terminal state', async () => {
    const store = new RunStore('run-1');
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let n = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes('stream=1')) {
        n++;
        if (n === 1) {
          return new Response(sseBody([
            'retry: 2000\n\n',
            'id: 1\ndata: {"v":2,"seq":1,"kind":"run.state","status":"running"}\n\n',
            'id: 2\ndata: {"v":2,"seq":2,"kind":"checkpoint.saved"}\n\n',
            ': hb\n\n',
          ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(sseBody([
          'id: 2\ndata: {"v":2,"seq":2,"kind":"checkpoint.saved"}\n\n', // overlap → deduped
          'id: 3\ndata: {"v":2,"seq":3,"kind":"run.state","status":"finished"}\n\n',
          'data: {"v":2,"seq":3,"kind":"run.state","status":"finished","synthetic":true}\n\n',
        ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      // snapshot probe after first drop: still running
      return new Response(JSON.stringify({ run_id: 'run-1', status: 'running' }), { status: 200 });
    });
    const sleep = vi.fn(async () => {});
    await runStreamLoop(store, new AbortController().signal, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep });

    const streams = calls.filter((c) => c.url.includes('stream=1'));
    expect(streams).toHaveLength(2);
    expect(streams[0].url).not.toContain('since=');
    expect(streams[1].url).toContain('since=2');
    expect(streams[1].headers['Last-Event-ID']).toBe('2');
    expect(streams[1].headers.Authorization).toBe('Bearer t');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(store.d.status).toBe('finished');
    expect(store.d.lastSeq).toBe(3);
    expect(store.d.events.filter((e) => e.kind === 'checkpoint.saved')).toHaveLength(1);
    expect(store.conn.phase).toBe('closed');
  });

  it('gives up on 404 without retrying', async () => {
    const store = new RunStore('run-404');
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    await runStreamLoop(store, new AbortController().signal, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.conn.phase).toBe('error');
  });
});

describe('loadHistory', () => {
  it('pages by since for v2 engines', async () => {
    const store = new RunStore('run-h');
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      const since = Number(new URL(url, 'http://x').searchParams.get('since'));
      const evs = since === 0 ? [{ v: 2, seq: 1, kind: 'a' }, { v: 2, seq: 2, kind: 'b' }] : since === 2 ? [{ v: 2, seq: 3, kind: 'c' }] : [];
      return new Response(JSON.stringify({ events: evs }), { status: 200 });
    });
    const n = await loadHistory(store, undefined, 2, 10, fetchImpl as unknown as typeof fetch);
    expect(n).toBe(3);
    expect(urls[1]).toContain('since=2');
    expect(store.d.lastSeq).toBe(3);
  });

  it('falls back to offset paging when the engine ignores since', async () => {
    const store = new RunStore('run-legacy');
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      const off = Number(new URL(url, 'http://x').searchParams.get('offset') ?? 0);
      const all = [{ kind: 'tool_call' }, { kind: 'tool_result' }, { kind: 'finish' }];
      return new Response(JSON.stringify({ events: all.slice(off, off + 2) }), { status: 200 });
    });
    const n = await loadHistory(store, undefined, 2, 10, fetchImpl as unknown as typeof fetch);
    expect(n).toBe(3);
    expect(urls.some((u) => u.includes('offset=2'))).toBe(true);
    expect(store.d.events).toHaveLength(3);
    expect(store.d.hasServerSeq).toBe(false);
  });
});
