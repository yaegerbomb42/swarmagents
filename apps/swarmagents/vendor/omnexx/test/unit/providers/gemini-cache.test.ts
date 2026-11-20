import { describe, expect, it, vi } from 'vitest';
import {
  computeGeminiCacheKey,
  DEFAULT_GEMINI_CACHE_TTL_SECONDS,
  GEMINI_MIN_CACHE_TOKENS,
  GeminiCacheManager,
} from '../../../src/providers/gemini-cache.js';
import { GeminiProvider } from '../../../src/providers/gemini.js';
import type { CompletionRequest, SystemBlock, ToolSpec } from '../../../src/providers/types.js';

describe('Step 2.6: Google Gemini Context Caching API Integration', () => {
  it('computes deterministic SHA-256 ignoring volatile system blocks', () => {
    const system1: SystemBlock[] = [
      { text: 'You are an expert system.' },
      { text: 'Session ID: 12345 (Turn 1)', volatile: true },
    ];
    const system2: SystemBlock[] = [
      { text: 'You are an expert system.' },
      { text: 'Session ID: 99999 (Turn 42)', volatile: true },
    ];
    const tools: ToolSpec[] = [
      { name: 'read_file', description: 'reads', inputSchema: { type: 'object' } },
    ];

    const key1 = computeGeminiCacheKey('models/gemini-2.0-flash', system1, tools);
    const key2 = computeGeminiCacheKey('models/gemini-2.0-flash', system2, tools);

    expect(key1).toBe(key2);
    expect(key1.length).toBe(64); // SHA-256 hex
  });

  it('skips caching and degrades cleanly when context is below 32k tokens', async () => {
    const fetchMock = vi.fn();
    const manager = new GeminiCacheManager({
      apiKey: 'test-key',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const cache = await manager.getOrCreateCache({
      model: 'models/gemini-2.0-flash',
      system: [{ text: 'Small system prompt' }],
      tools: [],
      estimatedTokens: 5_000, // < 32,768
    });

    expect(cache).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it('creates and reuses cachedContents for context >= 32,768 tokens', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      callCount++;
      expect(url).toContain('/v1beta/cachedContents');
      const body = JSON.parse(init?.body as string) as { ttl?: string; model?: string };
      expect(body.ttl).toBe(`${String(DEFAULT_GEMINI_CACHE_TTL_SECONDS)}s`);
      expect(body.model).toBe('models/gemini-2.0-flash');

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            name: 'cachedContents/cache_hash_123',
            expireTime: new Date(Date.now() + 300_000).toISOString(),
            usageMetadata: { totalTokenCount: 35_000 },
          }),
      });
    });

    const manager = new GeminiCacheManager({
      apiKey: 'test-key',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const system: SystemBlock[] = [{ text: 'Large codebase context... '.repeat(1000) }];
    const tools: ToolSpec[] = [{ name: 'read_file', description: 'read', inputSchema: {} }];

    // First call: creates cache
    const cache1 = await manager.getOrCreateCache({
      model: 'gemini-2.0-flash',
      system,
      tools,
      estimatedTokens: GEMINI_MIN_CACHE_TOKENS + 1000,
    });

    expect(cache1).toBeDefined();
    expect(cache1?.name).toBe('cachedContents/cache_hash_123');
    expect(callCount).toBe(1);
    expect(manager.size).toBe(1);

    // Second call with same system & tools: cache hit in memory, no fetch
    const cache2 = await manager.getOrCreateCache({
      model: 'gemini-2.0-flash',
      system,
      tools,
      estimatedTokens: GEMINI_MIN_CACHE_TOKENS + 1000,
    });

    expect(cache2).toBe(cache1);
    expect(callCount).toBe(1); // Reused without calling API again!
  });

  it('integrates with GeminiProvider to pass cachedContent and map cachedContentTokenCount to cacheRead', async () => {
    const cacheMock = {
      name: 'cachedContents/cache_999',
      model: 'models/gemini-2.0-flash',
      hash: 'abc',
      tokenCount: 40_000,
      expiresAt: Date.now() + 300_000,
    };

    const manager = new GeminiCacheManager({ apiKey: 'fake-key' });
    vi.spyOn(manager, 'getOrCreateCache').mockResolvedValue(cacheMock);

    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        cachedContent?: string;
        system_instruction?: unknown;
      };
      expect(body.cachedContent).toBe('cachedContents/cache_999');
      // system_instruction and tools are omitted because they live in the cache
      expect(body.system_instruction).toBeUndefined();

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [{ content: { parts: [{ text: 'Answer' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 42_000,
              cachedContentTokenCount: 40_000,
              candidatesTokenCount: 150,
            },
          }),
      });
    });

    const provider = new GeminiProvider({
      apiKey: 'fake-key',
      timeoutMs: 5000,
      fetch: fetchMock as typeof fetch,
      cacheManager: manager,
    });

    const req: CompletionRequest = {
      model: 'gemini-2.0-flash',
      system: [{ text: 'x'.repeat(150_000) }],
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      maxTokens: 1000,
      messageBreakpoints: [],
    };

    const res = await provider.complete(req);

    expect(res.content[0]).toEqual({ type: 'text', text: 'Answer' });
    expect(res.usage.cacheRead).toBe(40_000);
    expect(res.usage.uncached).toBe(2_000); // 42,000 - 40,000
    expect(res.usage.output).toBe(150);
  });
});
