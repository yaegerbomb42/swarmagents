import { z } from 'zod';
import type { ToolSource } from './types.js';
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from '../types.js';
import type { OmnexxConfig } from '../../config/schema.js';
import type { SearchBackend, WebConfig } from '../../config/sections/web.js';
import { parseDuration } from '../../config/duration.js';
import { fetchWithRetry } from './web_http.js';
import { privateTarget } from './private-address.js';

const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
/** Queries remembered per run; the oldest go first. */
const MAX_CACHED_QUERIES = 50;
/** Snippets are hints, not content: web_fetch reads the page. */
const MAX_SNIPPET_CHARS = 300;

let activeWebConfig: WebConfig | undefined;
/** Formatted results per run, count and query. One run never serves another. */
const searchCache = new Map<string, string>();

export function setWebSearchConfig(config?: Partial<WebConfig>): void {
  activeWebConfig = config as WebConfig | undefined;
}

export function clearWebSearchCache(): void {
  searchCache.clear();
}

function searchTimeoutMs(): number {
  try {
    return parseDuration(activeWebConfig?.search_timeout ?? '15s');
  } catch {
    return DEFAULT_SEARCH_TIMEOUT_MS;
  }
}

/** Search APIs get a timeout per attempt and retries on 429/5xx/network errors. */
function searchFetch(url: string, init: RequestInit): Promise<Response> {
  return fetchWithRetry(url, init, { timeoutMs: searchTimeoutMs() });
}

const clipSnippet = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SNIPPET_CHARS ? `${flat.slice(0, MAX_SNIPPET_CHARS)}…` : flat;
};

const schema = z.strictObject({
  query: z.string().describe('Search query string'),
  n: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of results to return (default: 5)'),
});

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/** The free, no-key engines used as fallbacks when a configured backend fails or returns nothing. */
export type SearchEngineId =
  | 'brave'
  | 'tavily'
  | 'exa'
  | 'searxng'
  | 'duckduckgo'
  | 'google';

/** A browser-grade User-Agent so public HTML endpoints don't refuse the request. */
const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function stripTagsInline(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses DuckDuckGo's HTML endpoint (<html.duckduckgo.com>) result page. Exported so unit
 * tests can feed canned markup without a network round trip.
 */
export function parseDuckDuckGoHtml(html: string): SearchResultItem[] {
  const anchors = Array.from(
    html.matchAll(/<a[^>]*class="[^"]*result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi),
  );
  const snippets = Array.from(
    html.matchAll(/<a[^>]*class="[^"]*result__snippet"[^>]*>([\s\S]*?)<\/a>/gi),
  );
  const results: SearchResultItem[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (!a) continue;
    let url = (a[1] ?? '').trim();
    const uddg = /uddg=([^&]+)/.exec(url);
    if (uddg) url = safeDecode(uddg[1] ?? '');
    const title = stripTagsInline(a[2] ?? '');
    if (!url || !title) continue;
    const snippet = stripTagsInline(snippets[i]?.[1] ?? '');
    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Parses a Google HTML results page (best effort; structure shifts over time). Exported for
 * tests. Never throws: malformed blocks are skipped.
 */
export function parseGoogleHtml(html: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bg\b[^"]*"/gi);
  for (const block of blocks.slice(1)) {
    const hrefMatch =
      /<a[^>]*href="\/url\?q=([^"&]+)/i.exec(block) ??
      /<a[^>]*href="(https?:\/\/[^"]+)/i.exec(block);
    const titleMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    if (!hrefMatch || !titleMatch) continue;
    const rawUrl = hrefMatch[1] ?? hrefMatch[0];
    const url = /^https?:\/\//i.test(rawUrl)
      ? rawUrl.replace(/&amp;/g, '&')
      : safeDecode(rawUrl);
    const title = stripTagsInline(titleMatch[1] ?? '');
    if (!url || !title) continue;
    const snippetMatch =
      /<div[^>]*class="[^"]*(?:VwiC3b|IsZvec)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const snippet = stripTagsInline(snippetMatch?.[1] ?? '');
    results.push({ title, url, snippet });
  }
  return results;
}

async function searchBrave(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResultItem[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const res = await searchFetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!res.ok) {
    throw new Error(`Brave search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  const results: SearchResultItem[] = [];
  for (const item of data.web?.results ?? []) {
    if (item.title && item.url) {
      results.push({
        title: item.title,
        url: item.url,
        snippet: item.description ?? '',
      });
    }
  }
  return results;
}

async function searchTavily(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResultItem[]> {
  const res = await searchFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: count,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tavily search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const results: SearchResultItem[] = [];
  for (const item of data.results ?? []) {
    if (item.title && item.url) {
      results.push({
        title: item.title,
        url: item.url,
        snippet: item.content ?? '',
      });
    }
  }
  return results;
}

async function searchExa(
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResultItem[]> {
  const res = await searchFetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: count,
    }),
  });

  if (!res.ok) {
    throw new Error(`Exa search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; text?: string }[];
  };
  const results: SearchResultItem[] = [];
  for (const item of data.results ?? []) {
    if (item.title && item.url) {
      results.push({
        title: item.title,
        url: item.url,
        snippet: item.text ?? '',
      });
    }
  }
  return results;
}

async function searchSearxng(
  query: string,
  count: number,
  baseUrl: string,
): Promise<SearchResultItem[]> {
  const url = new URL(baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const res = await searchFetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`SearXNG search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const results: SearchResultItem[] = [];
  for (const item of (data.results ?? []).slice(0, count)) {
    if (item.title && item.url) {
      results.push({
        title: item.title,
        url: item.url,
        snippet: item.content ?? '',
      });
    }
  }
  return results;
}

async function searchDuckDuckGo(query: string, count: number): Promise<SearchResultItem[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const res = await searchFetch(url.toString(), {
    headers: { 'User-Agent': WEB_USER_AGENT },
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  const html = await res.text();
  return parseDuckDuckGoHtml(html).slice(0, count);
}

async function searchGoogle(query: string, count: number): Promise<SearchResultItem[]> {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(count));
  const res = await searchFetch(url.toString(), {
    headers: { 'User-Agent': WEB_USER_AGENT, Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`Google returned ${res.status}`);
  const html = await res.text();
  return parseGoogleHtml(html).slice(0, count);
}

/** Rejects when the configured SearXNG instance is a private/implicit URL. */
async function assertSafeSearx(baseUrl: string): Promise<void> {
  const parsed = new URL(baseUrl);
  const allowList = activeWebConfig?.allow ?? ['*'];
  const named = allowList.filter((a) => a !== '*');
  const allowed =
    named.length > 0 &&
    named.some((a) => parsed.hostname === a || parsed.hostname.endsWith(`.${a}`));
  if (allowed) return;
  try {
    const why = await privateTarget(parsed.hostname);
    if (why) throw new Error(`SearXNG URL refused: ${why}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SearXNG URL refused')) throw err;
    throw new Error('Invalid SearXNG URL');
  }
}

/**
 * Ordered list of engines to try for one query: the configured primary first, then the free
 * fallbacks (searxng when configured, DuckDuckGo, then Google). Exported for tests.
 */
export function buildFallbackChain(): Array<{ id: SearchEngineId; label: string }> {
  const chain: Array<{ id: SearchEngineId; label: string }> = [];
  const backend = activeWebConfig?.search;
  if (backend === 'brave') chain.push({ id: 'brave', label: 'Brave' });
  else if (backend === 'tavily') chain.push({ id: 'tavily', label: 'Tavily' });
  else if (backend === 'exa') chain.push({ id: 'exa', label: 'Exa' });
  else if (backend === 'searxng') chain.push({ id: 'searxng', label: 'SearXNG' });

  if (backend !== 'searxng' && (activeWebConfig?.search_url || process.env.SEARXNG_URL)) {
    chain.push({ id: 'searxng', label: 'SearXNG' });
  }
  chain.push({ id: 'duckduckgo', label: 'DuckDuckGo' });
  chain.push({ id: 'google', label: 'Google' });
  return chain;
}

async function searchWith(
  id: SearchEngineId,
  query: string,
  count: number,
): Promise<SearchResultItem[]> {
  switch (id) {
    case 'brave': {
      const key = resolveSearchKey('brave', activeWebConfig?.search_key_env);
      if (!key) throw new Error('missing BRAVE_API_KEY (set BRAVE_API_KEY or [web] search_key_env)');
      return searchBrave(query, count, key);
    }
    case 'tavily': {
      const key = resolveSearchKey('tavily', activeWebConfig?.search_key_env);
      if (!key) throw new Error('missing TAVILY_API_KEY (set TAVILY_API_KEY or [web] search_key_env)');
      return searchTavily(query, count, key);
    }
    case 'exa': {
      const key = resolveSearchKey('exa', activeWebConfig?.search_key_env);
      if (!key) throw new Error('missing EXA_API_KEY (set EXA_API_KEY or [web] search_key_env)');
      return searchExa(query, count, key);
    }
    case 'searxng': {
      const base = activeWebConfig?.search_url ?? process.env.SEARXNG_URL;
      if (!base) throw new Error('missing SearXNG instance URL (set SEARXNG_URL or [web] search_url)');
      await assertSafeSearx(base);
      return searchSearxng(query, count, base);
    }
    case 'duckduckgo':
      return searchDuckDuckGo(query, count);
    case 'google':
      return searchGoogle(query, count);
  }
}

export function resolveSearchKey(backend: SearchBackend, keyEnv?: string): string | undefined {
  if (keyEnv) {
    return process.env[keyEnv];
  }
  switch (backend) {
    case 'brave':
      return process.env.BRAVE_API_KEY ?? process.env.BRAVE_SEARCH_API_KEY;
    case 'tavily':
      return process.env.TAVILY_API_KEY;
    case 'exa':
      return process.env.EXA_API_KEY;
    case 'searxng':
      return undefined;
  }
}

export const webSearchTool: Tool<typeof schema> = {
  name: 'web_search',
  description:
    'Search the web (configured backend with free multi-engine fallbacks). Returns titles, URLs and short snippets; read a result with web_fetch. Cached per run.',
  schema,
  readOnly: true,
  async run(input, ctx: ToolContext): Promise<ToolOutput> {
    const backend = activeWebConfig?.search;
    if (!backend) {
      return fail('No web search backend configured in [web] search.');
    }

    const count = input.n ?? 5;
    const cacheKey = `${ctx.store.runId}\n${count}\n${input.query}`;
    const cached = searchCache.get(cacheKey);
    if (cached !== undefined) return ok(cached);

    const errors: string[] = [];
    let anySuccess = false;
    let items: SearchResultItem[] = [];

    for (const { id, label } of buildFallbackChain()) {
      try {
        const found = await searchWith(id, input.query, count);
        anySuccess = true;
        if (found.length > 0) {
          items = found;
          break;
        }
        errors.push(`${label}: no results`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${label}: ${msg}`);
      }
    }

    if (items.length === 0) {
      if (!anySuccess && errors.length > 0) {
        return fail(`Search failed: ${ctx.redactor.text(errors.join('; '))}`);
      }
      return ok(`No search results found for: ${input.query}`);
    }

    const formatted = ctx.redactor.text(
      items
        .slice(0, count)
        .map(
          (item, idx) =>
            `${idx + 1}. [${item.title}](${item.url})\n   ${clipSnippet(item.snippet)}`,
        )
        .join('\n\n'),
    );
    searchCache.set(cacheKey, formatted);
    const oldest = searchCache.keys().next().value;
    if (searchCache.size > MAX_CACHED_QUERIES && oldest !== undefined) searchCache.delete(oldest);
    return ok(formatted);
  },
};

export const source: ToolSource = {
  load(config: OmnexxConfig): readonly Tool[] {
    setWebSearchConfig(config.web);
    if (!config.web.search) {
      return [];
    }
    return [webSearchTool];
  },
};
