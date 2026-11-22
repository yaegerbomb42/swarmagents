/**
 * Host-side web search (lib/web/search.ts).
 *
 * Ported from vendor/omnexx/src/tools/extra/web_search.ts (+ web_http.ts
 * retry logic), adapted to this app's per-user BYOK model: the caller passes
 * the run owner's own search config (lib/providers/settings.ts), the search
 * runs on the server, and the API key never enters the user's VM — the VM
 * only holds the per-run token (see app/api/runtime/web/[runToken]/search).
 *
 * Backends: Brave, Tavily, Exa, SearXNG. Results are normalized to
 * {title, url, snippet} with snippets clipped to 300 chars (snippets are
 * hints, not content). Every attempt has a timeout; 429/5xx/network
 * failures retry with backoff. Errors are structured (WebSearchError.code)
 * and scrubbed of key material — a backend error must never leak the key
 * into a tool result, a log line, or an HTTP response.
 */

import { privateTarget, type Resolve } from "./private-address";

/** Per-attempt timeout; a hung search API never stalls a run longer than this. */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 400;
/** A Retry-After longer than this isn't worth waiting for inside a tool call. */
const MAX_RETRY_AFTER_MS = 5_000;
/** Snippets are hints, not content: web_fetch reads the page. */
const MAX_SNIPPET_CHARS = 300;
/** Queries are short by nature; anything longer is a prompt dump, not a search. */
const MAX_QUERY_CHARS = 400;
/** Hard cap on results per call, whatever the caller asks for. */
export const MAX_SEARCH_RESULTS = 10;
export const DEFAULT_SEARCH_RESULTS = 5;
/** Cached result sets kept host-wide; the oldest go first. */
const MAX_CACHED_SEARCHES = 500;

export type SearchBackend = "brave" | "tavily" | "exa" | "searxng";

export const SEARCH_BACKENDS: readonly SearchBackend[] = ["brave", "tavily", "exa", "searxng"];

export function isSearchBackend(value: unknown): value is SearchBackend {
  return typeof value === "string" && (SEARCH_BACKENDS as readonly string[]).includes(value);
}

/**
 * One account's web-search configuration. Stored per-user in
 * lib/providers/settings.ts; `apiKey` is that user's own key for the chosen
 * backend (SearXNG is keyless and uses `searxngUrl` instead).
 */
export interface WebSearchConfig {
  backend: SearchBackend;
  apiKey?: string;
  searxngUrl?: string;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchErrorCode =
  | "not_configured"
  | "missing_api_key"
  | "invalid_config"
  | "invalid_query"
  | "blocked_url"
  | "backend_error"
  | "timeout";

/** Structured search failure. `message` is safe to show the agent/user. */
export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  constructor(code: WebSearchErrorCode, message: string) {
    super(message);
    this.name = "WebSearchError";
    this.code = code;
  }
}

export interface WebSearchDeps {
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver for the SearXNG SSRF guard (tests). */
  resolve?: Resolve;
  /** Per-attempt timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Extra attempts after the first, for network errors, 429 and 5xx. Defaults to 2. */
  retries?: number;
  /**
   * Cache scope (the route passes `<owner>:<runId>`). When set, identical
   * backend+count+query calls inside the scope are served from cache — one
   * run never serves another, and one user's results never serve another's.
   */
  cacheScope?: string;
}

/** Remove every occurrence of `secret` from `text` (error hygiene). */
function scrub(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

const clipSnippet = (s: string): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SNIPPET_CHARS ? `${flat.slice(0, MAX_SNIPPET_CHARS)}…` : flat;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const retryable = (status: number): boolean => status === 429 || status >= 500;

function retryDelay(res: Response | undefined, attempt: number, base: number): number {
  const backoff = base * 2 ** attempt;
  const after = Number(res?.headers.get("retry-after"));
  return Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_RETRY_AFTER_MS) : backoff;
}

/**
 * fetch with a timeout on every attempt and retries on transient failures
 * (network errors, timeouts, 429, 5xx). Returns the last response (possibly
 * an error status) or throws the last network error. Ported from
 * vendor/omnexx/src/tools/extra/web_http.ts, with an injectable fetch.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; retries: number; fetchImpl: typeof fetch },
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    let res: Response | undefined;
    try {
      res = await opts.fetchImpl(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
      if (!retryable(res.status) || attempt === opts.retries) return res;
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      lastErr =
        err instanceof Error && err.name === "TimeoutError"
          ? new WebSearchError("timeout", `search timed out after ${opts.timeoutMs}ms`)
          : err;
      if (attempt === opts.retries) break;
    }
    await sleep(retryDelay(res, attempt, DEFAULT_BASE_DELAY_MS));
  }
  if (lastErr instanceof WebSearchError) throw lastErr;
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${msg} (after ${opts.retries + 1} attempts)`);
}

interface SearchFetch {
  (url: string, init: RequestInit): Promise<Response>;
}

async function searchBrave(
  searchFetch: SearchFetch,
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResultItem[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const res = await searchFetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });
  if (!res.ok) {
    throw new WebSearchError("backend_error", `Brave search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  const results: SearchResultItem[] = [];
  for (const item of data.web?.results ?? []) {
    if (item.title && item.url) {
      results.push({ title: item.title, url: item.url, snippet: clipSnippet(item.description ?? "") });
    }
  }
  return results;
}

async function searchTavily(
  searchFetch: SearchFetch,
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResultItem[]> {
  const res = await searchFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count }),
  });
  if (!res.ok) {
    throw new WebSearchError("backend_error", `Tavily search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const results: SearchResultItem[] = [];
  for (const item of data.results ?? []) {
    if (item.title && item.url) {
      results.push({ title: item.title, url: item.url, snippet: clipSnippet(item.content ?? "") });
    }
  }
  return results;
}

async function searchExa(
  searchFetch: SearchFetch,
  query: string,
  count: number,
  apiKey: string,
): Promise<SearchResultItem[]> {
  const res = await searchFetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    // Exa only returns page text when contents are requested; without this
    // every snippet is empty (the vendor port omitted it).
    body: JSON.stringify({ query, numResults: count, contents: { text: true } }),
  });
  if (!res.ok) {
    throw new WebSearchError("backend_error", `Exa search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; text?: string }[];
  };
  const results: SearchResultItem[] = [];
  for (const item of data.results ?? []) {
    if (item.title && item.url) {
      results.push({ title: item.title, url: item.url, snippet: clipSnippet(item.text ?? "") });
    }
  }
  return results;
}

/**
 * Normalize a user-configured SearXNG base URL: http(s) only, no embedded
 * credentials, and a bare host gets the standard `/search` path (the vendor
 * port required the path in the configured URL; instances are usually
 * configured by host only).
 */
export function normalizeSearxngUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebSearchError("invalid_config", "SearXNG URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebSearchError("invalid_config", "SearXNG URL must use http(s).");
  }
  if (url.username || url.password) {
    throw new WebSearchError("invalid_config", "SearXNG URL must not carry credentials.");
  }
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/search";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function searchSearxng(
  searchFetch: SearchFetch,
  query: string,
  count: number,
  baseUrl: string,
  resolve?: Resolve,
): Promise<SearchResultItem[]> {
  const normalized = normalizeSearxngUrl(baseUrl);
  const url = new URL(normalized);
  // The instance URL is user-configured: never let it point the server at
  // itself, the LAN, or the cloud metadata service.
  const why = await privateTarget(url.hostname, resolve);
  if (why) {
    throw new WebSearchError("blocked_url", `SearXNG URL refused: ${why}`);
  }
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");

  const res = await searchFetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new WebSearchError("backend_error", `SearXNG search returned ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const results: SearchResultItem[] = [];
  for (const item of (data.results ?? []).slice(0, count)) {
    if (item.title && item.url) {
      results.push({ title: item.title, url: item.url, snippet: clipSnippet(item.content ?? "") });
    }
  }
  return results;
}

/** Result sets per cache scope, backend, count and query. Bounded, oldest first. */
const searchCache = new Map<string, SearchResultItem[]>();

/** Test hook: clear the result cache. */
export function clearWebSearchCache(): void {
  searchCache.clear();
}

/**
 * Run one web search with the given per-user config. Throws WebSearchError
 * (structured, key-scrubbed) on any failure; the caller maps it to a tool
 * error — a failed search must never throw into the agent's turn.
 */
export async function webSearch(
  config: WebSearchConfig | undefined,
  query: string,
  count: number = DEFAULT_SEARCH_RESULTS,
  deps: WebSearchDeps = {},
): Promise<SearchResultItem[]> {
  if (!config || !isSearchBackend(config.backend)) {
    throw new WebSearchError("not_configured", "Web search is not configured for this account.");
  }
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed) {
    throw new WebSearchError("invalid_query", "A non-empty search query is required.");
  }
  const cappedQuery = trimmed.slice(0, MAX_QUERY_CHARS);
  const cappedCount = Math.max(
    1,
    Math.min(MAX_SEARCH_RESULTS, Number.isFinite(count) && count > 0 ? Math.floor(count) : DEFAULT_SEARCH_RESULTS),
  );

  const cacheKey = deps.cacheScope
    ? `${deps.cacheScope}\n${config.backend}\n${cappedCount}\n${cappedQuery}`
    : null;
  if (cacheKey) {
    const cached = searchCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = deps.retries ?? DEFAULT_RETRIES;
  const searchFetch: SearchFetch = (url, init) => fetchWithRetry(url, init, { timeoutMs, retries, fetchImpl });

  let items: SearchResultItem[] = [];
  try {
    switch (config.backend) {
      case "brave": {
        if (!config.apiKey) {
          throw new WebSearchError("missing_api_key", "No Brave API key is configured for this account.");
        }
        items = await searchBrave(searchFetch, cappedQuery, cappedCount, config.apiKey);
        break;
      }
      case "tavily": {
        if (!config.apiKey) {
          throw new WebSearchError("missing_api_key", "No Tavily API key is configured for this account.");
        }
        items = await searchTavily(searchFetch, cappedQuery, cappedCount, config.apiKey);
        break;
      }
      case "exa": {
        if (!config.apiKey) {
          throw new WebSearchError("missing_api_key", "No Exa API key is configured for this account.");
        }
        items = await searchExa(searchFetch, cappedQuery, cappedCount, config.apiKey);
        break;
      }
      case "searxng": {
        if (!config.searxngUrl) {
          throw new WebSearchError("invalid_config", "No SearXNG instance URL is configured for this account.");
        }
        items = await searchSearxng(searchFetch, cappedQuery, cappedCount, config.searxngUrl, deps.resolve);
        break;
      }
    }
  } catch (err) {
    if (err instanceof WebSearchError) {
      // Belt and braces: no error text may carry the key, whatever produced it.
      throw new WebSearchError(err.code, scrub(err.message, config.apiKey));
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new WebSearchError("backend_error", scrub(`Search failed: ${msg}`, config.apiKey));
  }

  const capped = items.slice(0, cappedCount);
  if (cacheKey) {
    searchCache.set(cacheKey, capped);
    if (searchCache.size > MAX_CACHED_SEARCHES) {
      const oldest = searchCache.keys().next().value;
      if (oldest !== undefined) searchCache.delete(oldest);
    }
  }
  return capped;
}
