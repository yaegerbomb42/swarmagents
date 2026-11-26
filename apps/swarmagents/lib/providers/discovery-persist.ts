/**
 * Persist a live model discovery result against a saved provider: the
 * availableModels id list plus any per-model capability overrides discovered
 * upstream (e.g. Ollama /api/show). Shared by the discovery endpoints so both
 * persist exactly the same way.
 *
 * Only a live fetch may overwrite the saved list; callers must not pass a
 * stale or fallback result, so real data is never replaced with older or
 * static ids.
 */

import { updateProviderSettings } from "./store";
import type { DiscoveryResult } from "./discovery";
import type { ProviderConfig } from "./types";

export async function persistDiscoveredModels(
  owner: string,
  saved: ProviderConfig,
  result: DiscoveryResult,
): Promise<boolean> {
  if (result.models.length === 0) return false;
  const capabilities: Record<string, NonNullable<(typeof result.models)[number]["capabilities"]>> = {};
  for (const model of result.models) {
    if (model.capabilities) capabilities[model.id] = model.capabilities;
  }
  const currentModels = saved.models ? Object.values(saved.models).filter(Boolean) : [];
  const ids = result.models.map((m) => m.id);
  const tier =
    currentModels.length > 0
      ? undefined
      : [ids[0], ids[Math.floor((ids.length - 1) / 2)] ?? ids[0], ids[ids.length - 1]];
  await updateProviderSettings(owner, saved.id, {
    availableModels: ids,
    ...(Object.keys(capabilities).length > 0 ? { modelCapabilities: capabilities } : {}),
    ...(tier ? { models: tier.filter((m): m is string => Boolean(m)) } : {}),
  });
  return true;
}
