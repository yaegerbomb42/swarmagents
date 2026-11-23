/**
 * Unit tests for the host-side web search service (lib/web/search.ts):
 * provider normalization with a mock fetch, structured errors, timeouts,
 * retries, result caps, per-scope caching, the SearXNG SSRF guard, and key
 * redaction. No network: every backend call goes through an injected fetch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  clearWebSearchCache,
  normalizeSearxngUrl,
  webSearch,
  WebSearchError,
  type WebSearchConfig,
} from "./search";

const BRAVE: WebSearchConfig = { backend: "brave", apiKey: "brave-secret-key-123" };
const TAVILY: WebSearchConfig = { backend: "tavily", apiKey: "tavily-secret-key-456" };
const EXA: WebSearchConfig = { backend: "exa", apiKey: "exa-secret-key-789" };
const SEARXNG: WebSearchConfig = { backend: "searxng", searxngUrl: "https://searx.example.com" };

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records calls and answers from a handler. */
function stubFetch(handler: (call: RecordedCall, n: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test.beforeEach(() => {
  clearWebSearchCache();
});

test("Brave results are normalized and snippets clipped to 300 chars", async () => {
  const longSnippet = "word ".repeat(120).trim();
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({
      web: {
        results: [
          { title: "Node test docs", url: "https://nodejs.org/test", description: longSnippet },
          { title: "No URL here" },
          { title: "Second", url: "https://example.com/2", description: "short" },
        ],
      },
    }),
  );
  const results = await webSearch(BRAVE, "node test runner", 5, { fetchImpl });
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Node test docs");
  assert.equal(results[0].url, "https://nodejs.org/test");
  assert.ok(results[0].snippet.length <= 301, `snippet too long: ${results[0].snippet.length}`);
  assert.ok(results[0].snippet.endsWith("…"));
  assert.equal(results[1].snippet, "short");
  // The key travels in the header, never the URL.
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["X-Subscription-Token"], "brave-secret-key-123");
  assert.equal(calls[0].url.includes("brave-secret-key-123"), false);
});

test("Tavily results are normalized from content", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({ results: [{ title: "T", url: "https://t.example", content: "body text" }] }),
  );
  const results = await webSearch(TAVILY, "query", 3, { fetchImpl });
  assert.deepEqual(results, [{ title: "T", url: "https://t.example", snippet: "body text" }]);
  const sent = JSON.parse(String(calls[0].init.body)) as { api_key: string; max_results: number };
  assert.equal(sent.api_key, "tavily-secret-key-456");
  assert.equal(sent.max_results, 3);
});

test("Exa results are normalized from text and request contents", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({ results: [{ title: "E", url: "https://e.example", text: "page text" }] }),
  );
  const results = await webSearch(EXA, "query", 2, { fetchImpl });
  assert.deepEqual(results, [{ title: "E", url: "https://e.example", snippet: "page text" }]);
  const sent = JSON.parse(String(calls[0].init.body)) as { numResults: number; contents?: { text?: boolean } };
  assert.equal(sent.numResults, 2);
  assert.equal(sent.contents?.text, true);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "exa-secret-key-789");
});

test("SearXNG results are normalized and a bare host gets the /search path", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({ results: [{ title: "S", url: "https://s.example", content: "found" }] }),
  );
  const results = await webSearch(SEARXNG, "query", 5, {
    fetchImpl,
    resolve: async () => ["93.184.216.34"],
  });
  assert.deepEqual(results, [{ title: "S", url: "https://s.example", snippet: "found" }]);
  const called = new URL(calls[0].url);
  assert.equal(called.pathname, "/search");
  assert.equal(called.searchParams.get("format"), "json");
  assert.equal(normalizeSearxngUrl("https://searx.example.com"), "https://searx.example.com/search");
  assert.equal(normalizeSearxngUrl("https://searx.example.com/search"), "https://searx.example.com/search");
});

test("unconfigured and keyless configs fail with structured codes", async () => {
  await assert.rejects(webSearch(undefined, "q"), (err: unknown) => {
    assert.ok(err instanceof WebSearchError);
    assert.equal(err.code, "not_configured");
    return true;
  });
  await assert.rejects(webSearch({ backend: "brave" }, "q"), (err: unknown) => {
    assert.ok(err instanceof WebSearchError);
    assert.equal(err.code, "missing_api_key");
    return true;
  });
  await assert.rejects(webSearch({ backend: "searxng" }, "q"), (err: unknown) => {
    assert.ok(err instanceof WebSearchError);
    assert.equal(err.code, "invalid_config");
    return true;
  });
  await assert.rejects(webSearch(BRAVE, "   "), (err: unknown) => {
    assert.ok(err instanceof WebSearchError);
    assert.equal(err.code, "invalid_query");
    return true;
  });
});

test("a SearXNG URL resolving to a private address is refused (SSRF guard)", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ results: [] }));
  await assert.rejects(
    webSearch(SEARXNG, "q", 5, { fetchImpl, resolve: async () => ["10.0.0.5"] }),
    (err: unknown) => {
      assert.ok(err instanceof WebSearchError);
      assert.equal(err.code, "blocked_url");
      return true;
    },
  );
  await assert.rejects(
    webSearch({ backend: "searxng", searxngUrl: "http://169.254.169.254" }, "q", 5, { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof WebSearchError);
      assert.equal(err.code, "blocked_url");
      return true;
    },
  );
});

test("a hung backend times out instead of stalling", async () => {
  const hangingFetch = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
  await assert.rejects(webSearch(BRAVE, "q", 5, { fetchImpl: hangingFetch, timeoutMs: 50, retries: 0 }), (err: unknown) => {
    assert.ok(err instanceof WebSearchError);
    assert.equal(err.code, "timeout");
    return true;
  });
});

test("429/5xx responses are retried, then succeed", async () => {
  const { calls, fetchImpl } = stubFetch((_call, n) =>
    n === 1
      ? jsonResponse({ error: "slow down" }, 429, "Too Many Requests")
      : jsonResponse({ web: { results: [{ title: "Ok", url: "https://ok.example", description: "d" }] } }),
  );
  const results = await webSearch(BRAVE, "q", 5, { fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(results.length, 1);
});

test("a persistent backend failure surfaces as backend_error without key material", async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse({ error: "nope" }, 401, "Unauthorized"));
  await assert.rejects(webSearch(BRAVE, "q", 5, { fetchImpl, retries: 0 }), (err: unknown) => {
    assert.ok(err instanceof WebSearchError);
    assert.equal(err.code, "backend_error");
    assert.match(err.message, /401/);
    assert.equal(err.message.includes("brave-secret-key-123"), false);
    return true;
  });
});

test("network errors are scrubbed of the API key", async () => {
  const leakyFetch = (async () => {
    throw new Error("connect failed for key brave-secret-key-123 at proxy");
  }) as unknown as typeof fetch;
  await assert.rejects(webSearch(BRAVE, "q", 5, { fetchImpl: leakyFetch, retries: 0 }), (err: unknown) => {
    assert.ok(err instanceof WebSearchError);
    assert.equal(err.message.includes("brave-secret-key-123"), false);
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
});

test("the result count is capped at the maximum", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    title: `R${i}`,
    url: `https://r.example/${i}`,
    description: "d",
  }));
  const { calls, fetchImpl } = stubFetch(() => jsonResponse({ web: { results: many } }));
  const results = await webSearch(BRAVE, "q", 50, { fetchImpl });
  assert.equal(results.length, 10);
  assert.equal(new URL(calls[0].url).searchParams.get("count"), "10");
});

test("results are cached per scope; other scopes and unscoped calls refetch", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse({ web: { results: [{ title: "C", url: "https://c.example", description: "d" }] } }),
  );
  await webSearch(BRAVE, "same query", 5, { fetchImpl, cacheScope: "user-a:run-1" });
  await webSearch(BRAVE, "same query", 5, { fetchImpl, cacheScope: "user-a:run-1" });
  assert.equal(calls.length, 1);
  await webSearch(BRAVE, "same query", 5, { fetchImpl, cacheScope: "user-b:run-2" });
  assert.equal(calls.length, 2);
  await webSearch(BRAVE, "same query", 5, { fetchImpl });
  assert.equal(calls.length, 3);
});
