/**
 * Client-facing provider rows.
 *
 * These rows are the only shape the browser ever sees for a provider. They
 * carry a key *count* and last-4 *masks* — never a key value.
 */

import { apiStyleFor, authFor, baseUrlFor } from "./adapters";
import { catalogEntry } from "./catalog";
import { mergedModelCapabilities } from "./capabilities";
import { providerKeySlots, type ProviderKeySlot } from "./keys";
import type {
  ApiStyle,
  AuthScheme,
  ModelCapabilities,
  ProviderConfig,
} from "./types";

const TIER_NAMES = ["fast", "balanced", "deep"] as const;

export interface ProviderRow {
  id: string;
  label: string;
  model: string;
  enabled: boolean;
  models: string[];
  /** Wire format the gateway speaks to this provider. */
  apiStyle: ApiStyle;
  /** Effective base URL (catalog default when the user set none). */
  baseUrl: string;
  /** How the credential is placed on the wire. */
  authScheme: AuthScheme;
  /** Custom header name for the custom-header scheme only. */
  authHeaderName?: string;
  /** Names of extra static headers. Values are never sent to the browser. */
  headerNames: string[];
  /** True when this provider cannot work without a key. */
  needsKey: boolean;
  /** Models found by discovery (kept alongside the tier models). */
  availableModels: string[];
  /** Effective capabilities for the models this row advertises. */
  capabilities: Record<string, ModelCapabilities>;
  /** Models with an explicit manual override. */
  capabilityOverrides: string[];
  /** How many keys the provider has. Never the keys themselves. */
  keyCount: number;
  /** Lower ranks are tried first. */
  rank: number;
  /** True when the provider is backed by the providers config file. */
  saved: boolean;
  /** Free provider: estimated cost $0, preferred when "Prefer free providers" is on. */
  isFree: boolean;
  /** Input token price per 1M tokens (USD) used for cost estimation. */
  inputPricePer1mTokens?: number;
  /** Output token price per 1M tokens (USD) used for cost estimation. */
  outputPricePer1mTokens?: number;
  /**
   * Epoch ms until which the provider is skipped after a 402 (quota
   * exhausted); absent when it is not cooling down for quota.
   */
  quotaCoolingDownUntil?: number;
  /** One entry per managed key: its index and a last-4 mask. */
  keySlots: ProviderKeySlot[];
}

/** Flatten a provider's tier models into the list order the UI shows. */
export function configModels(config: ProviderConfig): string[] {
  if (!config.models) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tier of TIER_NAMES) {
    const model = config.models[tier];
    if (model && !seen.has(model)) {
      seen.add(model);
      out.push(model);
    }
  }
  return out;
}

/** Count a provider's keys without ever extracting their values. */
export function countProviderKeys(
  config: ProviderConfig,
  env: Record<string, string | undefined>
): number {
  if (config.keys) return config.keys.length;
  if (config.envKeys) return (env[config.envKeys] ?? "").split(",").filter(Boolean).length;
  const suffix = config.id === config.kind ? config.kind : config.id;
  const varName = `SWARM_KEYS_${suffix.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  return (env[varName] ?? "").split(",").filter(Boolean).length;
}

/**
 * Shape a provider config for the client. `saved` marks providers that live
 * in the providers config file — those are the ones whose keys can be
 * rotated or removed through the API.
 *
 * `quotaCooldowns` maps provider id -> epoch ms until the provider's 402
 * (quota) cooldown ends; the row exposes it as quotaCoolingDownUntil so the
 * UI can say "out of free usage until ~HH:MM". Never key material.
 */
export function providerRow(
  config: ProviderConfig,
  options: {
    saved?: boolean;
    env?: Record<string, string | undefined>;
    quotaCooldowns?: ReadonlyMap<string, number>;
  } = {}
): ProviderRow {
  const env = options.env ?? process.env;
  const entry = catalogEntry(config.id);
  const models = configModels(config);
  const quotaUntil = options.quotaCooldowns?.get(config.id);
  const available = config.availableModels ?? [];
  const modelIds = [...new Set([...models, ...available])].slice(0, 100);
  const capabilities: Record<string, ModelCapabilities> = {};
  for (const model of modelIds) {
    capabilities[model] = mergedModelCapabilities(config, model);
  }
  const auth = authFor(config);
  const scheme = auth.scheme;
  return {
    id: config.id,
    label: entry?.name ?? config.id,
    model: config.models?.balanced ?? entry?.models?.default ?? "",
    enabled: config.enabled !== false,
    models: models.length > 0 ? models : entry?.models?.popular ?? [],
    apiStyle: apiStyleFor(config),
    baseUrl: baseUrlFor(config),
    authScheme: scheme,
    ...(scheme === "custom-header" && auth.headerName
      ? { authHeaderName: auth.headerName }
      : {}),
    headerNames: Object.keys(config.headers ?? {}),
    needsKey: !(
      entry?.isLocal === true ||
      scheme === "none" ||
      apiStyleFor(config) === "ollama"
    ),
    availableModels: available.length > 0 ? available : models.length > 0 ? models : entry?.models?.popular ?? [],
    capabilities,
    capabilityOverrides: Object.keys(config.modelCapabilities ?? {}),
    keyCount: countProviderKeys(config, env),
    rank: config.rank ?? 0,
    saved: options.saved ?? false,
    isFree: config.isFree === true,
    ...(config.inputPricePer1mTokens !== undefined
      ? { inputPricePer1mTokens: config.inputPricePer1mTokens }
      : {}),
    ...(config.outputPricePer1mTokens !== undefined
      ? { outputPricePer1mTokens: config.outputPricePer1mTokens }
      : {}),
    ...(quotaUntil !== undefined ? { quotaCoolingDownUntil: quotaUntil } : {}),
    keySlots: providerKeySlots(config.keys),
  };
}
