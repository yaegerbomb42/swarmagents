/**
 * Team Mode — free-first provider rotation.
 *
 * Ordering rules, in order:
 *   1. Only providers the user enabled in Settings are eligible.
 *   2. Free-tier providers come first (Groq / Cerebras / Gemini / OpenRouter
 *      free endpoints, or any provider with a zero daily budget).
 *   3. Paid providers follow, cheapest-looking quota first.
 *
 * Within a provider the models list is the key pool: successive assignments
 * rotate through it, so one rate-limited key does not stall the team.
 * Every candidate carries a concurrency cap from the provider quota, which
 * the runner folds into the per-user cap.
 */

import type { StoredProvider } from '@/lib/providerStore';

const FREE_PROVIDER_TYPES = new Set(['groq', 'cerebras', 'gemini', 'mistral', 'ollama', 'lambo-local']);

export interface TeamRoute {
  provider: string;
  providerId: string;
  model: string;
  tier: 'free' | 'paid';
  maxConcurrency: number;
}

export function isFreeProvider(p: StoredProvider): boolean {
  if (!p.enabled) return false;
  if (FREE_PROVIDER_TYPES.has(String(p.type || '').toLowerCase())) return true;
  if (Number(p.quota?.dailyBudget) === 0) return true;
  return (p.models || []).some((m) => /:free$/i.test(m));
}

/** Enabled providers, free tier first, then by concurrency headroom. */
export function rankProviders(providers: StoredProvider[]): StoredProvider[] {
  return providers
    .filter((p) => p && p.enabled)
    .slice()
    .sort((a, b) => {
      const af = isFreeProvider(a) ? 0 : 1;
      const bf = isFreeProvider(b) ? 0 : 1;
      if (af !== bf) return af - bf;
      return (Number(b.quota?.maxConcurrency) || 2) - (Number(a.quota?.maxConcurrency) || 2);
    });
}

/** Sum of concurrency caps across eligible providers (never below 1). */
export function providerConcurrencyCap(providers: StoredProvider[]): number {
  const sum = rankProviders(providers).reduce(
    (n, p) => n + Math.max(1, Number(p.quota?.maxConcurrency) || 2),
    0,
  );
  return Math.max(1, sum || 1);
}

/**
 * Pick the next route. `cursor` advances on every call so consecutive lanes
 * land on different providers (and different keys within one provider).
 */
export function nextRoute(
  providers: StoredProvider[],
  cursor: number,
): { route: TeamRoute | null; cursor: number } {
  const ranked = rankProviders(providers);
  if (!ranked.length) return { route: null, cursor };
  const provider = ranked[cursor % ranked.length];
  const models = (provider.models || []).filter(Boolean);
  const model = models.length ? models[cursor % models.length] : 'default';
  return {
    route: {
      provider: provider.name || provider.type,
      providerId: provider.id,
      model,
      tier: isFreeProvider(provider) ? 'free' : 'paid',
      maxConcurrency: Math.max(1, Number(provider.quota?.maxConcurrency) || 2),
    },
    cursor: cursor + 1,
  };
}

/** Tokens → rough USD, using the provider's list rate when known. */
export function estimateCostUsd(provider: string, tokens: number): number {
  const rates: Record<string, [number, number]> = {
    groq: [0.5, 0.77],
    cerebras: [0.1, 0.1],
    gemini: [1.25, 5.0],
    openrouter: [0.27, 0.41],
    azure: [2.5, 10.0],
    anthropic: [3, 15],
    openai: [2.5, 10],
  };
  const [input, output] = rates[String(provider || '').toLowerCase()] || [0.5, 0.5];
  // Split roughly 3:1 input:output, which matches an agent turn.
  const inTok = tokens * 0.75;
  const outTok = tokens * 0.25;
  return (inTok / 1_000_000) * input + (outTok / 1_000_000) * output;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}