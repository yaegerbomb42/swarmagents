/**
 * Per-user TTL cache over provider model discovery.
 *
 * Discovery (GET /v1/models and friends) is a live network call with the
 * user's own key. The settings flow wants the live list, but re-fetching on
 * every drawer open is slow and hammers the provider. This wrapper caches
 * the last successful list per (owner, provider, endpoint) for a short TTL
 * and fails open: when a refresh errors, callers get the stale cached list
 * (or a caller-supplied fallback such as the saved availableModels or the
 * catalog's popular list) instead of an error, so a flaky provider never
 * empties the model picker.
 *
 * The cache key deliberately excludes the API key: a rotated key for the
 * same account serves the same list, and `force` is available when a
 * different account's entitlements matter. Errors are never cached.
 */

import { baseUrlFor } from "./adapters";
import { discoverProviderModels } from "./discovery";
import type { DiscoveryResult, ProbeOptions } from "./discovery";
import { errorMessage } from "./errors";
import type { ProviderConfig } from "./types";

/** Default freshness window for a cached model list. */
export const MODEL_CACHE_TTL_MS = 15 * 60_000;

export type ModelListSource = "live" | "cache" | "stale-cache" | "fallback";

export interface CachedDiscoveryResult extends DiscoveryResult {
  /** Where this list came from. */
  source: ModelListSource;
  /** True when the list may be out of date (served after a failed refresh). */
  stale: boolean;
  /**
   * Epoch ms of the successful fetch that produced the list. For a fallback
   * result this is the time of the failed attempt.
   */
  fetchedAt: number;
  /** Why the refresh failed, when serving stale or fallback data. */
  warning?: string;
}

interface CacheEntry {
  result: DiscoveryResult;
  fetchedAt: number;
}

function cacheKeyFor(owner: string, config: ProviderConfig): string {
  return [
    owner,
    config.id,
    config.baseUrl ?? "",
    config.apiStyle ?? config.kind,
  ].join("|");
}

/** In-memory model-list cache. One entry per owner × provider × endpoint. */
export class ModelListCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = MODEL_CACHE_TTL_MS) {}

  get(owner: string, config: ProviderConfig): CacheEntry | undefined {
    return this.entries.get(cacheKeyFor(owner, config));
  }

  set(owner: string, config: ProviderConfig, result: DiscoveryResult, fetchedAt: number): void {
    this.entries.set(cacheKeyFor(owner, config), { result, fetchedAt });
  }

  /** Drop every cached list (tests, and operator resets). */
  clear(): void {
    this.entries.clear();
  }

  /** Age check against this cache's TTL. */
  isFresh(entry: CacheEntry, now: number): boolean {
    return now - entry.fetchedAt < this.ttlMs;
  }
}

/** Process-wide cache used by the discover route. */
export const sharedModelListCache = new ModelListCache();

export interface DiscoverWithCacheOptions extends ProbeOptions {
  /** The signed-in user whose key (and cache slot) this is. */
  owner: string;
  /** Bypass a fresh cache entry and fetch live. */
  force?: boolean;
  /**
   * Model ids to serve when the live fetch fails and nothing is cached
   * (saved availableModels, or the catalog's popular list for a draft).
   */
  fallbackModels?: readonly string[];
  /** Cache to use; defaults to the shared process-wide cache. */
  cache?: ModelListCache;
  /** Injectable clock, primarily for deterministic tests. */
  now?: () => number;
}

/**
 * Discover a provider's models with caching and fail-open semantics.
 *
 * Order: fresh cache → live fetch (cached on success) → stale cache →
 * caller fallback → rethrow. The returned list is always safe to render;
 * `stale`/`warning` tell the UI when it is not live.
 */
export async function discoverModelsWithCache(
  config: ProviderConfig,
  apiKey: string,
  options: DiscoverWithCacheOptions,
): Promise<CachedDiscoveryResult> {
  const cache = options.cache ?? sharedModelListCache;
  const now = options.now ?? Date.now;
  const cached = cache.get(options.owner, config);

  if (cached && !options.force && cache.isFresh(cached, now())) {
    return { ...cached.result, source: "cache", stale: false, fetchedAt: cached.fetchedAt };
  }

  try {
    const result = await discoverProviderModels(config, apiKey, options);
    const fetchedAt = now();
    cache.set(options.owner, config, result, fetchedAt);
    return { ...result, source: "live", stale: false, fetchedAt };
  } catch (err) {
    const warning = errorMessage(err);
    if (cached) {
      return {
        ...cached.result,
        source: "stale-cache",
        stale: true,
        fetchedAt: cached.fetchedAt,
        warning,
      };
    }
    const fallback = (options.fallbackModels ?? []).filter((id) => id.trim() !== "");
    if (fallback.length > 0) {
      return {
        models: fallback.map((id) => ({ id })),
        // The API root we would have queried (no credentials, no key material).
        endpoint: baseUrlFor(config),
        source: "fallback",
        stale: true,
        fetchedAt: now(),
        warning,
      };
    }
    throw err;
  }
}
