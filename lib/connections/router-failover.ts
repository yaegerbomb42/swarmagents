import type { ProviderConfig } from "../types";
import { getProviders } from "../store";

/**
 * Robust Provider Failover & Clean Fallback Routing.
 * If a provider connection fails, is removed, or encounters quota/auth errors,
 * seamlessly selects the next best available connection or model.
 */

export interface FailoverSelection {
  activeProvider?: ProviderConfig;
  fallbackChain: ProviderConfig[];
  reason?: string;
}

export function getEligibleProviders(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.filter((p) => {
    if (!p.enabled) return false;
    // Must have a model specified or resolvable
    if (!p.model && p.kind !== "openrouter") return false;
    // Needs API key unless it is a local/custom endpoint without auth
    if (p.preset === "ollama" || p.preset === "lmstudio" || p.preset === "vllm") return true;
    return Boolean(p.apiKey);
  });
}

/**
 * Determine the next provider to use when a given provider fails or is removed.
 * Preserves user's configured priority list order.
 */
export function resolveProviderFailover(
  currentProviderId: string | undefined,
  failedReason?: string,
  configuredProviders: ProviderConfig[] = getProviders()
): FailoverSelection {
  const eligible = getEligibleProviders(configuredProviders);

  if (eligible.length === 0) {
    return {
      activeProvider: undefined,
      fallbackChain: [],
      reason: "No enabled or configured providers with valid credentials available.",
    };
  }

  // If no provider specified or current provider is missing, use the highest priority eligible provider
  if (!currentProviderId) {
    return {
      activeProvider: eligible[0],
      fallbackChain: eligible.slice(1),
    };
  }

  const currentIndex = eligible.findIndex((p) => p.id === currentProviderId);

  // If current provider is not found or not eligible, fall back to first eligible
  if (currentIndex === -1) {
    return {
      activeProvider: eligible[0],
      fallbackChain: eligible.slice(1),
      reason: `Provider ${currentProviderId} is no longer available or enabled. Fallen back to ${eligible[0].label || eligible[0].id}.`,
    };
  }

  // If failing over from current provider, select the next one in priority order
  const remaining = eligible.filter((p) => p.id !== currentProviderId);
  const nextProvider = remaining[0];

  return {
    activeProvider: nextProvider,
    fallbackChain: remaining.slice(1),
    reason: failedReason
      ? `Failed on ${eligible[currentIndex].label || eligible[currentIndex].id} (${failedReason}). Falling back to ${nextProvider?.label || nextProvider?.id || "none"}.`
      : undefined,
  };
}
