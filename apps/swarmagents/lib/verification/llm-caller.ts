/**
 * Cheap-model LLM caller for the shadow verifier.
 *
 * The verifier is an auditor running on the "fast" (cheapest capable) tier of
 * the user's own providers: free providers first, then the cheapest known
 * price, unknown prices last. The user's keys never leave the server — the
 * call goes through the same provider router as everything else.
 *
 * Returns null when the account has no providers configured, so the caller can
 * skip verification entirely rather than hang or fail a run on a system error.
 */

import { createRouter } from "../providers";
import { orderProvidersByCost } from "../lenses/run";
import { routerProviders } from "../providers/store";
import { SHADOW_VERIFIER_MAX_TOKENS } from "./shadow-verifier";
import type { LLMCaller } from "../verification";

export interface CheapLlmOptions {
  signal?: AbortSignal;
}

/**
 * Build an LLMCaller that runs on the account's cheapest capable model.
 * Returns null when there is nothing to call.
 */
export function createCheapCallLLM(
  userId: string,
  options: CheapLlmOptions = {},
): LLMCaller | null {
  const providers = orderProvidersByCost(routerProviders(userId));
  if (providers.length === 0) return null;
  const router = createRouter({ providers });

  return async (systemPrompt, userPrompt) => {
    const completion = await router.complete({
      tier: "fast",
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: SHADOW_VERIFIER_MAX_TOKENS,
      temperature: 0,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return completion.text;
  };
}
