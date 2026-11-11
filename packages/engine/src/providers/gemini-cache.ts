/**
 * Google Gemini Context Caching API Integration (Step 2.6).
 *
 * Implements context caching for Google Gemini models via `/v1beta/cachedContents`.
 *
 * Key behaviors:
 * 1. Requires minimum context size: 32,768 tokens (GEMINI_MIN_CACHE_TOKENS).
 * 2. Caches Level 0 + Level 1 system prefix, keyed by SHA-256 digest.
 * 3. Default TTL: 300 seconds (5 minutes). Reuses existing active caches before expiry.
 * 4. Graceful degradation: If the cache API returns 400, 404, or fails, degrades cleanly
 *    to standard un-cached requests without failing the agent cycle.
 */

import { createHash } from 'node:crypto';
import type { SystemBlock, ToolSpec } from './types.js';

export const GEMINI_MIN_CACHE_TOKENS = 32_768;
export const DEFAULT_GEMINI_CACHE_TTL_SECONDS = 300;

export interface GeminiCacheEntry {
  name: string;
  model: string;
  hash: string;
  tokenCount: number;
  expiresAt: number;
}

export interface GeminiCacheOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  defaultTtlSeconds?: number;
}

/**
 * Computes deterministic SHA-256 digest of system blocks and tool definitions.
 */
export function computeGeminiCacheKey(
  model: string,
  system: readonly SystemBlock[],
  tools: readonly ToolSpec[],
): string {
  const hash = createHash('sha256');
  hash.update(model);
  for (const block of system) {
    if (!block.volatile) {
      hash.update(block.text);
    }
  }
  for (const tool of tools) {
    hash.update(tool.name);
    hash.update(tool.description);
    hash.update(JSON.stringify(tool.inputSchema));
  }
  return hash.digest('hex');
}

/**
 * Manages Google Gemini cachedContents lifecycle.
 */
export class GeminiCacheManager {
  private readonly caches = new Map<string, GeminiCacheEntry>();
  private readonly defaultTtl: number;

  constructor(private readonly opts: GeminiCacheOptions = {}) {
    this.defaultTtl = opts.defaultTtlSeconds ?? DEFAULT_GEMINI_CACHE_TTL_SECONDS;
  }

  /**
   * Look up an existing unexpired cache entry by hash.
   */
  get(hash: string): GeminiCacheEntry | undefined {
    const entry = this.caches.get(hash);
    if (!entry) return undefined;
    // Buffer 10s before expiry to avoid racing server-side eviction
    if (Date.now() >= entry.expiresAt - 10_000) {
      this.caches.delete(hash);
      return undefined;
    }
    return entry;
  }

  /**
   * Invalidate a cache entry (e.g. if the API returns 404 Not Found on usage).
   */
  invalidate(hashOrName: string): void {
    for (const [key, entry] of this.caches.entries()) {
      if (key === hashOrName || entry.name === hashOrName) {
        this.caches.delete(key);
      }
    }
  }

  /**
   * Creates or retrieves a cached content reference.
   *
   * Degrades cleanly by returning undefined if context < 32k tokens,
   * if no API key is available, or if the server returns an error.
   */
  async getOrCreateCache(params: {
    model: string;
    system: readonly SystemBlock[];
    tools: readonly ToolSpec[];
    estimatedTokens: number;
    timeoutMs?: number;
  }): Promise<GeminiCacheEntry | undefined> {
    // Only context >= 32,768 tokens qualifies for Gemini context caching
    if (params.estimatedTokens < GEMINI_MIN_CACHE_TOKENS) {
      return undefined;
    }

    const hash = computeGeminiCacheKey(params.model, params.system, params.tools);
    const existing = this.get(hash);
    if (existing) {
      return existing;
    }

    const apiKey = this.opts.apiKey;
    if (!apiKey) {
      return undefined;
    }

    const base = (this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
      /\/+$/,
      '',
    );
    const url = `${base}/v1beta/cachedContents`;

    const nonVolatileSystem = params.system.filter((b) => !b.volatile);
    const toolsPayload = params.tools.length
      ? [
          {
            functionDeclarations: params.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            })),
          },
        ]
      : undefined;

    const normalizedModel = params.model.startsWith('models/')
      ? params.model
      : `models/${params.model}`;

    const body = {
      model: normalizedModel,
      systemInstruction: nonVolatileSystem.length
        ? { parts: nonVolatileSystem.map((b) => ({ text: b.text })) }
        : undefined,
      tools: toolsPayload,
      ttl: `${String(this.defaultTtl)}s`,
    };

    try {
      const fetchFn = this.opts.fetch ?? fetch;
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(params.timeoutMs ?? 5_000),
      });

      if (!res.ok) {
        // Degrade cleanly on 400/404 or any API rejection
        return undefined;
      }

      const data = (await res.json()) as {
        name?: string;
        expireTime?: string;
        usageMetadata?: { totalTokenCount?: number };
      };

      if (!data.name) {
        return undefined;
      }

      const expiresAt = data.expireTime
        ? new Date(data.expireTime).getTime()
        : Date.now() + this.defaultTtl * 1000;

      const entry: GeminiCacheEntry = {
        name: data.name,
        model: normalizedModel,
        hash,
        tokenCount: data.usageMetadata?.totalTokenCount ?? params.estimatedTokens,
        expiresAt,
      };

      this.caches.set(hash, entry);
      return entry;
    } catch {
      // Degrade cleanly on network/timeout/parse errors
      return undefined;
    }
  }

  /** Current active cache count. */
  get size(): number {
    return this.caches.size;
  }

  /** Clears all cached entries. */
  clear(): void {
    this.caches.clear();
  }
}
