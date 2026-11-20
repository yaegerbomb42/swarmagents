import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwarmEvent } from '@/lib/eventBus';
import { eventBus } from '@/lib/eventBus';
import {
  browse,
  captureSnapshot,
  fetchWebContent,
  searchWeb,
} from './webBrowser';
import type { BrowserSnapshotEvent } from './webBrowser';

function htmlResponse(html: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    url: '',
    headers: new Headers(),
    body: null,
    text: async () => html,
    json: async () => ({}),
  } as unknown as Response;
}

describe('Real Web Browser Tool', () => {
  it('returns fallback search results on empty/offline search queries', async () => {
    const results = await searchWeb('TypeScript React concurrency');
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBeDefined();
    expect(results[0].url).toBeDefined();
  });

  it('handles invalid or non-existent URL gracefully without throwing', async () => {
    const page = await fetchWebContent('https://invalid-non-existent-domain-test-123.org');
    expect(page).toBeDefined();
    expect(page.statusCode).toBeDefined();
    expect(page.content).toBeDefined();
  });
});

describe('browser telemetry events', () => {
  const events: Array<Pick<SwarmEvent, 'action' | 'payload'>> = [];
  let unsubscribe: () => void;

  beforeEach(() => {
    events.length = 0;
    unsubscribe = eventBus.subscribe((ev) => {
      if (ev.type === 'browser') events.push({ action: ev.action, payload: ev.payload });
    });
  });

  afterEach(() => {
    unsubscribe();
    vi.unstubAllGlobals();
  });

  it('emits browser:navigating then browser:loaded on fetchWebContent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          htmlResponse(
            '<html><head><title>T</title></head><body><p>hi</p></body></html>',
          ),
      ) as unknown as typeof fetch,
    );

    await fetchWebContent('https://example.com/doc');

    expect(events.map((e) => e.action)).toEqual(['navigating', 'loaded']);
    const navigating = events[0]!.payload as { url: string; timestamp: number };
    expect(navigating.url).toBe('https://example.com/doc');
    expect(typeof navigating.timestamp).toBe('number');

    const loaded = events[1]!.payload as {
      url: string;
      title: string;
      statusCode: number;
      contentLength: number;
    };
    expect(loaded.url).toBe('https://example.com/doc');
    expect(loaded.title).toBe('T');
    expect(loaded.statusCode).toBe(200);
    expect(loaded.contentLength).toBeGreaterThan(0);
  });

  it('emits browser:snapshot when a snapshot is captured', () => {
    captureSnapshot('https://example.com', 'line one\nline two');

    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('snapshot');
    const snap = events[0]!.payload as unknown as BrowserSnapshotEvent;
    expect(snap.url).toBe('https://example.com');
    expect(snap.wireframeSnippet).toContain('line one');
    expect(typeof snap.screenshotUrl).toBe('string');
  });

  it('browse emits all three events in order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          htmlResponse(
            '<html><head><title>T2</title></head><body><main><p>Body text here</p></main></body></html>',
          ),
      ) as unknown as typeof fetch,
    );

    const result = await browse('https://example.org/api');

    expect(result.page.title).toBe('T2');
    expect(result.snapshot.wireframeSnippet).toContain('Body text');
    expect(events.map((e) => e.action)).toEqual(['navigating', 'loaded', 'snapshot']);
  });
});
