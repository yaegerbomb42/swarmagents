/**
 * Cost estimation for proxied LLM calls (lib/providers/pricing.ts).
 *
 * Every llm.call telemetry event carries an estimated cost in USD:
 *   - $0 for providers marked free (isFree),
 *   - the provider-reported cost when the response carried one
 *     (usage.costUsd — e.g. the Perplexity Agent API's usage.cost, which
 *     includes tool fees a token-rate estimate cannot see),
 *   - otherwise a per-model price table, overridable per provider by the
 *     inputPricePer1mTokens/outputPricePer1mTokens config fields,
 *   - "unknown" when no price is known for the provider/model pair.
 *
 * Prices are list prices per 1M tokens; they are estimates used only for
 * display and cost meters — never for billing.
 */

import type { ProviderConfig, TokenUsage } from "./types";

/** One price entry: USD per 1M tokens (input/output). */
export interface ModelPrice {
  inputPer1m: number;
  outputPer1m: number;
}

/**
 * Built-in per-model price table, keyed by `<providerId>:<model>`. Only
 * entries we are reasonably confident about are listed; anything else is
 * "unknown" and falls back to the provider's configured prices, then unknown.
 */
export const DEFAULT_PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  // Anthropic (2025 list prices).
  "anthropic:claude-opus-4-1": { inputPer1m: 15, outputPer1m: 75 },
  "anthropic:claude-sonnet-4-5": { inputPer1m: 3, outputPer1m: 15 },
  "anthropic:claude-sonnet-4-5-20250929": { inputPer1m: 3, outputPer1m: 15 },
  "anthropic:claude-haiku-4-5": { inputPer1m: 1, outputPer1m: 5 },
  "anthropic:claude-haiku-4-5-20251001": { inputPer1m: 1, outputPer1m: 5 },
  // OpenAI (2025 list prices).
  "openai:gpt-4.1": { inputPer1m: 2, outputPer1m: 8 },
  "openai:gpt-4.1-mini": { inputPer1m: 0.4, outputPer1m: 1.6 },
  "openai:gpt-4o-mini": { inputPer1m: 0.15, outputPer1m: 0.6 },
  "openai:o3": { inputPer1m: 10, outputPer1m: 40 },
  "openai:o4-mini": { inputPer1m: 1.1, outputPer1m: 4.4 },
  // Google Gemini (2025 list prices).
  "gemini:gemini-2.5-pro": { inputPer1m: 1.25, outputPer1m: 10 },
  "gemini:gemini-2.5-flash": { inputPer1m: 0.3, outputPer1m: 2.5 },
  "gemini:gemini-2.0-flash": { inputPer1m: 0.1, outputPer1m: 0.4 },
  // DeepSeek (2025 list prices).
  "deepseek:deepseek-chat": { inputPer1m: 0.27, outputPer1m: 1.1 },
  "deepseek:deepseek-reasoner": { inputPer1m: 0.55, outputPer1m: 2.19 },
  // Groq (2025 list prices).
  "groq:llama-3.3-70b-versatile": { inputPer1m: 0.59, outputPer1m: 0.79 },
  "groq:llama-3.1-8b-instant": { inputPer1m: 0.05, outputPer1m: 0.08 },
  // Mistral (2025 list prices).
  "mistral:mistral-large-latest": { inputPer1m: 2, outputPer1m: 6 },
  "mistral:codestral-latest": { inputPer1m: 0.3, outputPer1m: 0.9 },
  "mistral:mistral-small-latest": { inputPer1m: 0.2, outputPer1m: 0.6 },
  // Z.ai GLM (2025 list prices).
  "zai:glm-4.5": { inputPer1m: 0.6, outputPer1m: 2.2 },
  "zai:glm-4.5-air": { inputPer1m: 0.16, outputPer1m: 0.48 },
  "zai:glm-4.5-thinking": { inputPer1m: 0.6, outputPer1m: 2.2 },
};

/** True for providers marked free: estimated cost is $0. */
export function isFreeProvider(config: Pick<ProviderConfig, "isFree">): boolean {
  return config.isFree === true;
}

/** Model price from the built-in table, if the pair is known. */
export function priceForModel(providerId: string, model: string): ModelPrice | undefined {
  return DEFAULT_PRICE_TABLE[`${providerId}:${model}`];
}

/** Model price from the provider's own config fields, if both are set. */
export function configuredPrice(config: Pick<ProviderConfig, "inputPricePer1mTokens" | "outputPricePer1mTokens">): ModelPrice | undefined {
  if (config.inputPricePer1mTokens === undefined || config.outputPricePer1mTokens === undefined) {
    return undefined;
  }
  return { inputPer1m: config.inputPricePer1mTokens, outputPer1m: config.outputPricePer1mTokens };
}

/**
 * The provider-reported cost carried on this usage, when usable (finite,
 * non-negative). Undefined when the provider reported no cost or the value
 * is malformed — callers then fall back to the price-table estimate.
 */
export function providerReportedCostUsd(usage: TokenUsage): number | undefined {
  const cost = usage.costUsd;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

/** True when estimateCostUsd would return the provider-reported cost. */
export function costWasReported(config: ProviderConfig, usage: TokenUsage): boolean {
  return !isFreeProvider(config) && providerReportedCostUsd(usage) !== undefined;
}

/**
 * Estimate the USD cost of one completion. Returns 0 for free providers,
 * the provider-reported cost when the response carried one (it is the
 * amount actually billed, tool fees included, so it beats any estimate),
 * a number when a price is known, and undefined when the price is unknown.
 * Negative/NaN token counts are treated as zero.
 */
export function estimateCostUsd(
  config: ProviderConfig,
  model: string,
  usage: TokenUsage,
): number | undefined {
  if (isFreeProvider(config)) return 0;
  const reported = providerReportedCostUsd(usage);
  if (reported !== undefined) return reported;
  const price = configuredPrice(config) ?? priceForModel(config.id, model);
  if (!price) return undefined;
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  return (input / 1_000_000) * price.inputPer1m + (output / 1_000_000) * price.outputPer1m;
}
