/**
 * Prompt-cache hit-rate telemetry + context-budget aggregation
 * (lib/client/tokenBudget.ts).
 *
 * Pure functions over per-turn token usage (the `usage` SSE events the
 * runner reports, surfaced per turn as ThreadEntry tokensIn / tokensOut /
 * tokensCached). No I/O, no React, no provider knowledge: the caller hands
 * in the turns and, when known, the active model's context window and the
 * prices to value cache savings at.
 *
 * Every input is sanitized: missing, non-numeric, negative, or infinite
 * counts read as zero, so a provider that reports no usage (or a partial
 * usage event) never produces NaN or a rate above 100%. Cached tokens are
 * a subset of input tokens by definition (cache_read <= input_tokens), so
 * a cached count above the input total is capped at the input total.
 */

/** One turn's token usage; every field is optional — providers may report none. */
export interface TokenUsageInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Cache-read tokens (cache reads + creations, as the runner reports them). */
  cachedTokens?: number | null;
  /** Model that served the turn, when known (used only as a label). */
  model?: string | null;
}

/** Prices to value cache savings at, in USD per 1M tokens. */
export interface TokenBudgetPrices {
  /** Uncached input-token price. */
  inputPerMillionUsd: number;
  /**
   * Cache-read price. Defaults to 10% of the input price — the cache-read
   * rate most providers publish (Anthropic, OpenAI) — when omitted.
   */
  cachedPerMillionUsd?: number;
}

export interface TokenBudgetOptions {
  /**
   * Active model context window in tokens. When omitted (no window is
   * known for the model), contextUtilizationPct is null.
   */
  contextWindowTokens?: number | null;
  /** Prices to value cache savings at; without them estimatedSavedUsd is null. */
  prices?: TokenBudgetPrices | null;
}

export interface TokenBudget {
  /** Turns handed in, including ones with no usage. */
  turns: number;
  /** Turns that reported at least one token count. */
  turnsWithUsage: number;
  /** True when at least one input or output token was reported. */
  hasUsage: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  /**
   * cached / input * 100, capped at 100. Null when no input tokens were
   * reported (a hit rate over zero input is meaningless).
   */
  cacheHitRatePct: number | null;
  /**
   * input / context window * 100. Null when the window is unknown; may
   * exceed 100 when the reported input overshoots the window.
   */
  contextUtilizationPct: number | null;
  /**
   * USD saved by serving cached tokens at the cache-read price instead of
   * the input price: cached * (inputPrice - cachedPrice) / 1M. Null when no
   * prices were supplied. Never negative (a cache-read price above the
   * input price saves nothing).
   */
  estimatedSavedUsd: number | null;
  /** Model label, when every turn with usage agrees on one. */
  model?: string;
  /** Context window the utilization was computed against, when supplied. */
  contextWindowTokens?: number;
}

/** Finite, non-negative count, or zero for anything unusable. */
function cleanCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Percentage rounded to one decimal; null when the denominator is zero. */
function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function aggregateTokenBudget(
  turns: readonly TokenUsageInput[],
  options?: TokenBudgetOptions,
): TokenBudget {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let turnsWithUsage = 0;
  let model: string | undefined;

  for (const turn of turns) {
    const input = cleanCount(turn.inputTokens);
    const output = cleanCount(turn.outputTokens);
    const cached = Math.min(cleanCount(turn.cachedTokens), input);
    totalInput += input;
    totalOutput += output;
    totalCached += cached;
    if (input > 0 || output > 0) {
      turnsWithUsage += 1;
      const turnModel = typeof turn.model === "string" && turn.model.trim() !== "" ? turn.model : undefined;
      if (turnModel !== undefined) {
        if (model === undefined) model = turnModel;
        else if (model !== turnModel) model = undefined;
      }
    }
  }

  const window = cleanCount(options?.contextWindowTokens ?? null);
  const prices = options?.prices ?? null;
  const inputPrice =
    prices !== null && Number.isFinite(prices.inputPerMillionUsd) && prices.inputPerMillionUsd > 0
      ? prices.inputPerMillionUsd
      : null;
  let estimatedSavedUsd: number | null = null;
  if (inputPrice !== null && totalCached > 0) {
    const cachedPrice =
      prices !== null &&
      typeof prices.cachedPerMillionUsd === "number" &&
      Number.isFinite(prices.cachedPerMillionUsd) &&
      prices.cachedPerMillionUsd >= 0
        ? prices.cachedPerMillionUsd
        : inputPrice * 0.1;
    estimatedSavedUsd = Math.max(0, (totalCached / 1_000_000) * (inputPrice - cachedPrice));
  }

  return {
    turns: turns.length,
    turnsWithUsage,
    hasUsage: totalInput > 0 || totalOutput > 0,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCachedTokens: totalCached,
    cacheHitRatePct: pct(totalCached, totalInput),
    contextUtilizationPct: window > 0 ? pct(totalInput, window) : null,
    estimatedSavedUsd,
    ...(model !== undefined ? { model } : {}),
    ...(window > 0 ? { contextWindowTokens: window } : {}),
  };
}
