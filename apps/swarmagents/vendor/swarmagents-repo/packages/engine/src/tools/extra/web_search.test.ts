import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types.js';
import {
  buildFallbackChain,
  clearWebSearchCache,
  parseDuckDuckGoHtml,
  parseGoogleHtml,
  setWebSearchConfig,
  webSearchTool,
} from './web_search.js';

const DDG_HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc&rut=xyz">Example Doc</a>
  <a class="result__snippet">A useful snippet about docs.</a>
</div>`;

const GOOGLE_HTML = `
<div class="g">
  <a href="/url?q=https%3A%2F%2Fexample.org%2Fapi&sa=U"><h3>API Docs</h3></a>
  <div class="VwiC3b">Description text here</div>
</div>`;

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

function errorResponse(status = 404): Response {
  return {
    ok: false,
    status,
    statusText: 'Not Found',
    url: '',
    headers: new Headers(),
    body: null,
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response;
}

function mkCtx(): ToolContext {
  return {
    store: { runId: 'test-run' },
    redactor: { text: (s: string) => s },
  } as unknown as ToolContext;
}

describe('parseDuckDuckGoHtml', () => {
  it('parses result blocks and decodes the uddg redirect wrapper', () => {
    expect(parseDuckDuckGoHtml(DDG_HTML)).toEqual([
      {
        title: 'Example Doc',
        url: 'https://example.com/doc',
        snippet: 'A useful snippet about docs.',
      },
    ]);
  });

  it('skips blocks without a title or URL', () => {
    expect(parseDuckDuckGoHtml('<a class="result__a">No href</a>')).toEqual([]);
  });
});

describe('parseGoogleHtml', () => {
  it('parses result blocks with decoded /url?q= links', () => {
    const results = parseGoogleHtml(GOOGLE_HTML);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'API Docs',
      url: 'https://example.org/api',
      snippet: 'Description text here',
    });
  });

  it('returns empty array for markup with no results', () => {
    expect(parseGoogleHtml('<html><body><p>no links</p></body></html>')).toEqual([]);
  });
});

describe('buildFallbackChain', () => {
  beforeEach(() => clearWebSearchCache());
  afterEach(() => setWebSearchConfig(undefined));

  it('orders configured primary before free fallbacks', () => {
    setWebSearchConfig({ search: 'brave' });
    expect(buildFallbackChain().map((c) => c.id)).toEqual([
      'brave',
      'duckduckgo',
      'google',
    ]);
  });

  it('inserts searxng when a search_url is configured', () => {
    setWebSearchConfig({ search: 'brave', search_url: 'https://search.example.net' });
    expect(buildFallbackChain().map((c) => c.id)).toEqual([
      'brave',
      'searxng',
      'duckduckgo',
      'google',
    ]);
  });
});

describe('webSearchTool', () => {
  beforeEach(() => clearWebSearchCache());
  afterEach(() => {
    setWebSearchConfig(undefined);
    vi.unstubAllGlobals();
  });

  it('reports when no search backend is configured', async () => {
    setWebSearchConfig(undefined);
    const out = await webSearchTool.run({ query: 'x' }, mkCtx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain('No web search backend');
  });

  it('falls back to DuckDuckGo when the configured backend has no API key', async () => {
    setWebSearchConfig({ search: 'brave' });
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit): Promise<Response> => {
        const url = String(_input);
        if (url.includes('duckduckgo.com')) return htmlResponse(DDG_HTML);
        return errorResponse();
      },
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await webSearchTool.run({ query: 'typescript concurrency' }, mkCtx());
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Example Doc');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('duckduckgo.com'),
      expect.anything(),
    );
  });

  it('returns a graceful failure without throwing when every engine fails', async () => {
    setWebSearchConfig({ search: 'brave' });
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(404)) as unknown as typeof fetch);

    const out = await webSearchTool.run({ query: 'anything' }, mkCtx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain('Search failed');
  });
});
