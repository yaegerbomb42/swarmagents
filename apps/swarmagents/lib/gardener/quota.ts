import type { QuotaProvider } from "./types";

function isLoopback(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Surplus means a free provider or a loopback (local) runtime still has
 * budget and is not in a quota-exhausted cooldown. Paid providers never count.
 */
export function hasSurplusQuota(
  providers: QuotaProvider[],
  now = Date.now(),
): { ok: boolean; reason: string; providerId?: string } {
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    const eligible = provider.isFree === true || isLoopback(provider.baseUrl);
    if (!eligible) continue;
    if (typeof provider.quotaExhaustedUntil === "number" && provider.quotaExhaustedUntil > now) continue;
    if (typeof provider.dailyBudgetUsd === "number" && provider.dailyBudgetUsd > 0) {
      const spent = provider.spentTodayUsd ?? 0;
      if (spent >= provider.dailyBudgetUsd) continue;
    }
    return { ok: true, reason: "surplus free or local quota", providerId: provider.id };
  }
  return { ok: false, reason: "no free or local surplus" };
}
