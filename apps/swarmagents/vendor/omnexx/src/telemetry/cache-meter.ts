/**
 * KV-Cache Hit-Ratio Telemetry Meter.
 *
 * Tracks cache hit ratios across turns and sessions, supporting multiple
 * provider token formats (Anthropic, OpenAI, DeepSeek).
 */
export interface TurnUsage {
  /** Total prompt tokens sent to the provider. */
  promptTokens: number;
  /** Tokens read from the cache (Anthropic: cache_read_input_tokens). */
  cachedPromptTokens?: number | undefined;
  /** Alternative cached token field (OpenAI/DeepSeek mapping). */
  readCacheTokens?: number | undefined;
  /** Tokens written into the cache. */
  writeCacheTokens?: number | undefined;
}

export interface SessionStats {
  totalPrompt: number;
  totalCached: number;
  overallHitRatio: number;
  estimatedDollarSavings: number;
}

/**
 * CacheMeter records turn-level cache usage and computes session-wide
 * hit ratios and dollar savings estimates.
 *
 * Supports three provider formats:
 * - Anthropic: uses `cache_read_input_tokens` as cachedPromptTokens
 * - OpenAI: uses `prompt_tokens_details.cached_tokens` (cachedTokens field)
 * - DeepSeek: uses `cache_ro_ratio` / `cachehit_rate` fields
 */
export class CacheMeter {
  /** Accumulated prompt tokens across all recorded turns. */
  private totalPrompt = 0;
  /** Accumulated cached prompt tokens across all recorded turns. */
  private totalCached = 0;
  /** Accumulated read cache tokens across all recorded turns. */
  private totalReadCache = 0;
  /** Accumulated write cache tokens across all recorded turns. */
  private totalWriteCache = 0;
  /** Number of turns recorded. */
  private turnCount = 0;

  get promptTotal(): number {
    return this.totalPrompt;
  }

  get cachedTotal(): number {
    return this.totalCached;
  }

  get readCacheTotal(): number {
    return this.totalReadCache;
  }

  get writeCacheTotal(): number {
    return this.totalWriteCache;
  }

  get turns(): number {
    return this.turnCount;
  }

  /** Record a single turn's cache usage. */
  recordTurn(usage: TurnUsage): void {
    const { promptTokens, cachedPromptTokens, readCacheTokens, writeCacheTokens } = usage;

    this.totalPrompt += promptTokens;
    this.totalCached += cachedPromptTokens ?? 0;
    this.totalReadCache += readCacheTokens ?? 0;
    this.totalWriteCache += writeCacheTokens ?? 0;
    this.turnCount++;
  }

  /** Convert an Anthropic-format usage object into a TurnUsage. */
  static fromAnthropic(promptTokens: number, cacheReadInputTokens?: number): TurnUsage {
    return {
      promptTokens,
      cachedPromptTokens: cacheReadInputTokens,
    };
  }

  /** Convert an OpenAI-format usage object into a TurnUsage. */
  static fromOpenAI(promptTokens: number, cachedTokens?: number): TurnUsage {
    return {
      promptTokens,
      cachedPromptTokens: cachedTokens,
    };
  }

  /** Convert a DeepSeek-format usage object into a TurnUsage. */
  static fromDeepSeek(
    promptTokens: number,
    cachedTokens?: number,
    readCacheTokens?: number,
  ): TurnUsage {
    return {
      promptTokens,
      cachedPromptTokens: cachedTokens,
      readCacheTokens,
    };
  }

  /** Get the cached-to-prompt ratio for the current session. */
  getTurnRatio(): number {
    if (this.totalPrompt === 0) return 0;
    return this.totalCached / this.totalPrompt;
  }

  /** Get session-wide statistics. */
  getSessionStats(): SessionStats {
    const overallHitRatio = this.getTurnRatio();
    const pricePerMillion = 3;
    const estimatedDollarSavings = (this.totalCached * pricePerMillion * 0.9) / 1_000_000;

    return {
      totalPrompt: this.totalPrompt,
      totalCached: this.totalCached,
      overallHitRatio,
      estimatedDollarSavings,
    };
  }
}
export const fromAnthropic = (promptTokens: number, cacheReadInputTokens?: number): TurnUsage =>
  CacheMeter.fromAnthropic(promptTokens, cacheReadInputTokens);
export const fromOpenAI = (promptTokens: number, cachedTokens?: number): TurnUsage =>
  CacheMeter.fromOpenAI(promptTokens, cachedTokens);
export const fromDeepSeek = (
  promptTokens: number,
  cachedTokens?: number,
  readCacheTokens?: number,
): TurnUsage => CacheMeter.fromDeepSeek(promptTokens, cachedTokens, readCacheTokens);
