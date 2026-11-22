/**
 * Load and validate a SWARM_PROVIDERS_FILE JSON configuration.
 *
 * The file declares providers without editing code. Each entry maps to a
 * ProviderConfig after validation and tier-name normalisation ("standard"
 * becomes "balanced").
 */

import { readFileSync } from "node:fs";
import type {
  ApiStyle,
  AuthScheme,
  ModelCapabilities,
  PerplexityEffort,
  ProviderConfig,
  ProviderKind,
} from "./types";
import { isApiStyle, isAuthScheme, isPerplexityEffort, PERPLEXITY_EFFORTS } from "./types";

const PROVIDER_KINDS = new Set<ProviderKind>(["anthropic", "openai", "gemini"]);
const VALID_TIER_NAMES = new Set<string>(["fast", "standard", "balanced", "deep"]);
const CAPABILITY_SOURCES = new Set(["preset", "discovery", "override"]);

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function assertArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(`${path} must be an array.`);
  }
  return value;
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigValidationError(`${path} is required and must be a non-empty string.`);
  }
  return value;
}

function assertOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConfigValidationError(`${path} must be a string.`);
  }
  return value;
}

function assertOptionalNumber(value: unknown, path: string, min = 0): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new ConfigValidationError(`${path} must be a number >= ${min}.`);
  }
  return value;
}

function assertOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ConfigValidationError(`${path} must be a boolean.`);
  }
  return value;
}

function assertOptionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(`${path} must be an array of strings.`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new ConfigValidationError(`${path}[${i}] must be a string.`);
    }
  }
  return value as string[];
}

function assertOptionalStringRecord(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new ConfigValidationError(`${path} must be an object with string values.`);
  }
  const record = value as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    if (typeof val !== "string") {
      throw new ConfigValidationError(`${path}.${key} must be a string.`);
    }
  }
  return record as Record<string, string>;
}

function assertProviderKind(value: unknown, path: string): ProviderKind {
  const str = assertString(value, path);
  if (!PROVIDER_KINDS.has(str as ProviderKind)) {
    throw new ConfigValidationError(
      `${path} must be one of ${Array.from(PROVIDER_KINDS).join(", ")}. Got "${str}".`
    );
  }
  return str as ProviderKind;
}

function parseApiStyle(value: unknown, path: string): ApiStyle | undefined {
  if (value === undefined) return undefined;
  if (!isApiStyle(value)) {
    throw new ConfigValidationError(`${path} is not a supported API style.`);
  }
  return value;
}

function parseAuth(value: unknown, path: string): ProviderConfig["auth"] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigValidationError(`${path} must be an object.`);
  }
  const obj = value as Record<string, unknown>;
  if (!isAuthScheme(obj.scheme)) {
    throw new ConfigValidationError(`${path}.scheme is not a supported auth scheme.`);
  }
  const headerName = assertOptionalString(obj.headerName, `${path}.headerName`);
  return {
    scheme: obj.scheme as AuthScheme,
    ...(headerName !== undefined ? { headerName } : {}),
  };
}

function parseEffort(value: unknown, path: string): PerplexityEffort | undefined {
  if (value === undefined) return undefined;
  if (!isPerplexityEffort(value)) {
    throw new ConfigValidationError(
      `${path} must be one of ${PERPLEXITY_EFFORTS.join(", ")}. Got ${JSON.stringify(value)}.`
    );
  }
  return value;
}

function parseAvailableModels(value: unknown, path: string): string[] | undefined {
  const models = assertOptionalStringArray(value, path);
  if (!models) return undefined;
  return [...new Set(models.map((m) => m.trim()).filter(Boolean))].slice(0, 500);
}

function parseModelCapabilities(
  value: unknown,
  path: string,
): Record<string, ModelCapabilities> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigValidationError(`${path} must be an object keyed by model id.`);
  }
  const out: Record<string, ModelCapabilities> = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!model.trim()) throw new ConfigValidationError(`${path} has an empty model id.`);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigValidationError(`${path}.${model} must be an object.`);
    }
    const caps = raw as Record<string, unknown>;
    const vision = assertOptionalBoolean(caps.vision, `${path}.${model}.vision`);
    const tools = assertOptionalBoolean(caps.tools, `${path}.${model}.tools`);
    const computerUse = assertOptionalBoolean(caps.computerUse, `${path}.${model}.computerUse`);
    if (vision === undefined || tools === undefined || computerUse === undefined) {
      throw new ConfigValidationError(
        `${path}.${model} needs booleans vision, tools and computerUse.`
      );
    }
    const contextWindow = assertOptionalNumber(
      caps.contextWindow,
      `${path}.${model}.contextWindow`,
      1
    );
    const source = caps.source;
    if (source !== undefined && (typeof source !== "string" || !CAPABILITY_SOURCES.has(source))) {
      throw new ConfigValidationError(`${path}.${model}.source is not valid.`);
    }
    out[model] = {
      vision,
      tools,
      computerUse,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(source !== undefined ? { source: source as ModelCapabilities["source"] } : {}),
    };
  }
  return out;
}

function parseModels(value: unknown, path: string): ProviderConfig["models"] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new ConfigValidationError(`${path} must be an object.`);
  }
  const result: ProviderConfig["models"] = {};
  const record = value as Record<string, unknown>;
  for (const [tier, model] of Object.entries(record)) {
    if (!VALID_TIER_NAMES.has(tier)) {
      throw new ConfigValidationError(
        `${path} has invalid tier "${tier}". Valid tiers: fast, standard, balanced, deep.`
      );
    }
    if (typeof model !== "string" || model.trim().length === 0) {
      throw new ConfigValidationError(`${path}.${tier} must be a non-empty string.`);
    }
    const canonicalTier = tier === "standard" ? "balanced" : (tier as "fast" | "balanced" | "deep");
    result[canonicalTier] = model;
  }
  return result;
}

function parseProvider(raw: unknown, index: number): ProviderConfig {
  const path = `providers[${index}]`;
  if (raw === null || typeof raw !== "object") {
    throw new ConfigValidationError(`${path} must be an object.`);
  }
  const obj = raw as Record<string, unknown>;

  const config: ProviderConfig = {
    id: assertString(obj.id, `${path}.id`),
    kind: assertProviderKind(obj.kind, `${path}.kind`),
    apiStyle: parseApiStyle(obj.apiStyle, `${path}.apiStyle`),
    auth: parseAuth(obj.auth, `${path}.auth`),
    baseUrl: assertOptionalString(obj.baseUrl, `${path}.baseUrl`),
    models: parseModels(obj.models, `${path}.models`),
    availableModels: parseAvailableModels(obj.availableModels, `${path}.availableModels`),
    modelCapabilities: parseModelCapabilities(
      obj.modelCapabilities,
      `${path}.modelCapabilities`
    ),
    envKeys: assertOptionalString(obj.envKeys, `${path}.envKeys`),
    dailyBudgetUsd: assertOptionalNumber(obj.dailyBudgetUsd, `${path}.dailyBudgetUsd`, 0),
    inputPricePer1mTokens: assertOptionalNumber(obj.inputPricePer1mTokens, `${path}.inputPricePer1mTokens`, 0),
    outputPricePer1mTokens: assertOptionalNumber(obj.outputPricePer1mTokens, `${path}.outputPricePer1mTokens`, 0),
    rank: assertOptionalNumber(obj.rank, `${path}.rank`, 0),
    enabled: assertOptionalBoolean(obj.enabled, `${path}.enabled`),
    isFree: assertOptionalBoolean(obj.isFree, `${path}.isFree`),
    keys: assertOptionalStringArray(obj.keys, `${path}.keys`),
    headers: assertOptionalStringRecord(obj.headers, `${path}.headers`),
    timeoutMs: assertOptionalNumber(obj.timeoutMs, `${path}.timeoutMs`, 0),
    effort: parseEffort(obj.effort, `${path}.effort`),
  };

  return config;
}

function parseRoot(data: unknown): ProviderConfig[] {
  if (data === null || typeof data !== "object") {
    throw new ConfigValidationError("Root must be an object.");
  }
  const root = data as Record<string, unknown>;
  const rawProviders = assertArray(root.providers, "providers");
  return rawProviders.map((p, i) => parseProvider(p, i));
}

/** Validate already-parsed `{ providers: [...] }` data (used by the per-user store). */
export function parseProvidersData(data: unknown): ProviderConfig[] {
  return parseRoot(data);
}

export function loadProvidersFile(path: string): ProviderConfig[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read SWARM_PROVIDERS_FILE at ${path}: ${message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`Invalid JSON in ${path}: ${message}`);
  }

  return parseRoot(json);
}

export function loadProvidersFromEnv(
  env: Record<string, string | undefined> = process.env
): ProviderConfig[] | null {
  const path = env.SWARM_PROVIDERS_FILE;
  if (!path) return null;
  return loadProvidersFile(path);
}
