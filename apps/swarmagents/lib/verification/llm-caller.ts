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
import { modelForTier } from "../providers";
import { modelFamily, type ModelFamily } from "../providers/model-family";
import { orderProvidersByCost } from "../lenses/run";
import { routerProviders } from "../providers/store";
import { SHADOW_VERIFIER_MAX_TOKENS } from "./shadow-verifier";
import { ADVERSARIAL_QA_MAX_TOKENS, selectQaProviders } from "./adversarial-qa";
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

export interface AdversarialQaCallLLM {
  callLLM: LLMCaller;
  provider: string;
  model: string;
  family: ModelFamily;
}

/**
 * Build an LLMCaller for the adversarial QA gate (master-plan PR 2.2).
 *
 * The QA role must run on a *different model family* than the builder, so
 * the caller is built only from providers whose fast-tier model belongs
 * to another family. Returns null when no such provider is configured —
 * the gate is skipped then, never graded by the builder's own family.
 * The router may fail over between the QA providers, but never back to
 * the builder's family: every candidate passed the family filter.
 */
export function createAdversarialQaCallLLM(
  userId: string,
  builderModel: string | undefined,
  options: CheapLlmOptions = {},
): AdversarialQaCallLLM | null {
  const qaProviders = selectQaProviders(routerProviders(userId), builderModel);
  if (qaProviders.length === 0) return null;
  const primary = qaProviders[0];
  const router = createRouter({ providers: qaProviders });
  const model = modelForTier(primary, "fast");
  return {
    callLLM: async (systemPrompt, userPrompt) => {
      const completion = await router.complete({
        tier: "fast",
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: ADVERSARIAL_QA_MAX_TOKENS,
        temperature: 0,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return completion.text;
    },
    provider: primary.id,
    model,
    family: modelFamily(model),
  };
}
