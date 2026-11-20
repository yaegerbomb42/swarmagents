/**
 * Running a lens.
 *
 * A lens is a short prompt sent to the cheapest capable model the user has:
 * the "fast" tier of their own providers, ordered by price (free providers
 * first, then the cheapest known price, unknown prices last). The user's
 * keys never leave the server — the lens goes through the same provider
 * router as everything else.
 *
 * The call is attributed to the agent run the message belongs to: its cost
 * lands on that run's telemetry (`llm.call`), so it shows up in the telemetry
 * drawer and in the usage meter next to the run that produced the message.
 */

import { createRouter } from "../providers";
import { modelForTier } from "../providers/adapters";
import { configuredPrice, estimateCostUsd, priceForModel } from "../providers/pricing";
import { routerProviders } from "../providers/store";
import type { ProviderConfig } from "../providers/types";
import { telemetryBus } from "../telemetry";
import { getCachedLens, lensCacheKey, writeLensCacheEntry, type LensCacheContext } from "./cache";
import { buildLensUserMessage, lensSystemPrompt, type ReferencedFile } from "./prompts";
import type { LensId, LensResult } from "./types";

/** Output cap for one lens answer. */
export const LENS_MAX_TOKENS = 1200;

export interface RunLensInput {
  /** Owner of the message (the signed-in user). */
  userId: string;
  lens: LensId;
  /** The agent message the lens reads. */
  message: string;
  /** Referenced files/diff the message talked about. */
  files?: readonly ReferencedFile[];
  /** Agent run the message belongs to (telemetry attribution + ownership). */
  runId?: string;
  signal?: AbortSignal;
}

/** Price of a provider's cheapest (fast tier) model, if it is known. */
export function providerModelPrice(
  config: ProviderConfig,
): { model: string; price: number | null; isFree: boolean } {
  const model = modelForTier(config, "fast");
  const isFree = config.isFree === true;
  if (isFree) return { model, price: 0, isFree: true };
  const price = configuredPrice(config) ?? priceForModel(config.id, model);
  if (!price) return { model, price: null, isFree: false };
  return { model, price: price.inputPer1m + price.outputPer1m, isFree: false };
}

/**
 * Order the user's providers cheapest-first and renumber their ranks so the
 * router tries them in that order. Free providers come first, then known
 * prices ascending, then unknown prices; the user's own rank breaks ties.
 */
export function orderProvidersByCost(providers: readonly ProviderConfig[]): ProviderConfig[] {
  const scored = providers.map((config, index) => {
    const { price } = providerModelPrice(config);
    return {
      config,
      index,
      rank: config.rank ?? index,
      price: price ?? Number.POSITIVE_INFINITY,
    };
  });
  scored.sort(
    (a, b) =>
      a.price - b.price ||
      a.rank - b.rank ||
      a.index - b.index,
  );
  return scored.map(({ config }, index) => ({ ...config, rank: index }));
}

/**
 * The cached answer for one (message, lens, run, files) tuple, if it was
 * already run. Callers use this to skip a provider call (and its cost)
 * entirely. The context must match the call that will run the lens — the
 * same message with different run files is a different answer.
 */
export function cachedLens(
  userId: string,
  message: string,
  lens: LensId,
  context?: LensCacheContext,
): LensResult | undefined {
  const cached = getCachedLens(userId, lensCacheKey(message, lens, context));
  if (!cached) return undefined;
  return {
    lens: cached.lens,
    text: cached.text,
    provider: cached.provider,
    model: cached.model,
    costUsd: cached.costUsd,
    latencyMs: cached.latencyMs,
    cached: true,
    createdAt: cached.createdAt,
  };
}

/**
 * Run one lens for one message. Answers are cached per (message, lens, run,
 * files) in the user's own store, so a second pick of the same lens on the
 * same message and files is free — but a different run or different files
 * always runs fresh.
 */
export async function runLens(input: RunLensInput): Promise<LensResult> {
  const context: LensCacheContext = { runId: input.runId, files: input.files };
  const key = lensCacheKey(input.message, input.lens, context);
  const cached = cachedLens(input.userId, input.message, input.lens, context);
  if (cached) return cached;

  const providers = orderProvidersByCost(routerProviders(input.userId));
  const router = createRouter({ providers });
  const completion = await router.complete({
    tier: "fast",
    system: lensSystemPrompt(input.lens),
    messages: [
      {
        role: "user",
        content: buildLensUserMessage({ message: input.message, files: input.files }),
      },
    ],
    maxTokens: LENS_MAX_TOKENS,
    temperature: 0.2,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const config = providers.find((candidate) => candidate.id === completion.provider);
  const costUsd = config
    ? estimateCostUsd(config, completion.model, completion.usage) ?? null
    : null;

  // Attribute the lens call to the agent run, so its cost shows up in that
  // run's telemetry and in the usage meter.
  if (input.runId) {
    telemetryBus.publish(input.runId, {
      type: "llm.call",
      data: {
        provider: completion.provider,
        model: completion.model,
        attempt: 1,
        outcome: "ok",
        latencyMs: completion.latencyMs,
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        costUsd,
        lens: input.lens,
        source: "lens",
      },
    });
  }

  const createdAt = Date.now();
  const entry = {
    lens: input.lens,
    text: completion.text,
    provider: completion.provider,
    model: completion.model,
    costUsd,
    latencyMs: completion.latencyMs,
    createdAt,
  };
  writeLensCacheEntry(input.userId, key, entry);

  return { ...entry, cached: false };
}
