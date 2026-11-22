/**
 * Per-user provider registry.
 *
 * Every account owns its providers: they live in
 * `<data dir>/users/<hash(userId)>/providers.json` (dir mode 700, file mode
 * 600) and their API keys are sealed with AES-256-GCM (see secret-box.ts),
 * bound to the owner and the provider id. There is no server-wide provider
 * file any more: the legacy `providers.json` is only read by the one-off
 * migration (migrate.ts), which moves it into the owner's account.
 *
 * Every function takes the owner's user id first, so a caller cannot reach a
 * provider without naming whose it is. Read paths return configs with the
 * decrypted keys for server-side use only; callers must never echo the
 * `keys` field to a client (see rows.ts for the client shape).
 *
 * Host env keys (SWARM_KEYS_*) only ever serve the local single-user
 * operator identity: a provider without a saved key has no keys for any
 * account, in every mode. Local (single-user) mode keeps the env keys,
 * because the machine and its env belong to that one user.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOCAL_USER_ID } from "../auth";
import { apiStyleFor, authFor } from "./adapters";
import { resolveOllamaBaseUrl, userSettingsFilePath } from "./settings";
import {
  canonicalProviderId,
  catalogEntry,
  LEGACY_API_STYLE_REPAIRS,
  LEGACY_MODEL_ID_REPAIRS,
  LEGACY_REPAIR_HOSTS,
  normalizeCatalogApiStyle,
  providerKindForCatalog,
  repairedApiStyle,
  repairedModelId,
} from "./catalog";
import { ConfigValidationError, parseProvidersData } from "./config-file";
import { CooldownStore } from "./cooldown-store";
import { providerKeySlots, type ProviderKeySlot } from "./keys";
import { defaultProviderConfigs } from "./router";
import { isSealed, open, seal, SecretBoxError } from "./secret-box";
import type {
  ApiStyle,
  ModelCapabilities,
  ModelTier,
  PerplexityEffort,
  ProviderAuth,
  ProviderConfig,
} from "./types";
import { isApiStyle, isPerplexityEffort } from "./types";

/** Name of the legacy server-wide file (migration source only). */
export const DEFAULT_PROVIDERS_FILE = "providers.json";
/** Per-user file name inside the user's directory. */
export const USER_PROVIDERS_FILE = "providers.json";
/** Per-user cooldown state file name. */
export const USER_COOLDOWN_FILE = "provider_cooldowns.json";
const STORE_VERSION = 2;
const MAX_USER_ID_LEN = 256;

/** A rejected provider mutation (unknown provider, bad key index, ...). */
export class ProviderMutationError extends Error {
  /** HTTP status the API should answer with. */
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProviderMutationError";
    this.status = status;
  }
}

export interface DataDirOptions {
  env?: Record<string, string | undefined>;
}

/**
 * Writable-dir probe results, memoized per directory.
 *
 * The probe costs a mkdir + write + unlink, and resolveDataDir runs on every
 * store call, so the same directories were re-probed over and over (bug 19,
 * minor). The answer for a directory does not change while the process runs,
 * so it is cached; a cached directory that has since disappeared is probed
 * again (the probe recreates it).
 */
const WRITABLE_DIRS = new Map<string, boolean>();

function isDirWritable(dir: string): boolean {
  const cached = WRITABLE_DIRS.get(dir);
  if (cached !== undefined) {
    // The directory may have been removed since the probe; the probe itself
    // recreates it, so re-run it instead of trusting a stale answer.
    if (cached && fs.existsSync(dir)) return true;
    if (!cached) return false;
  }
  let writable = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.swarm_providers_write_probe_${process.pid}_${Date.now()}`);
    fs.writeFileSync(probe, "probe");
    fs.rmSync(probe, { force: true });
    writable = true;
  } catch {
    writable = false;
  }
  WRITABLE_DIRS.set(dir, writable);
  return writable;
}

/** Resolve the swarm data dir (mirrors lib/board store resolution). */
export function resolveDataDir(options: DataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const home = env.SWARM_HOME;
  if (home && isDirWritable(home)) return home;
  const legacy = path.join(os.homedir(), ".swarmagents");
  if (isDirWritable(legacy)) return legacy;
  if (isDirWritable("/data")) return "/data";
  return path.join(os.tmpdir(), "swarmagents");
}

let LEGACY_FILE_OVERRIDE: string | undefined;
let DATA_DIR_OVERRIDE: string | undefined;

/**
 * Test hook: point the store at a directory. `legacyFile` is the legacy
 * server-wide file the migration reads; its directory becomes the data dir
 * that holds `users/<hash>/providers.json`. Pass "" to reset.
 */
export function configureProviderStorePaths(legacyFile: string): void {
  LEGACY_FILE_OVERRIDE = legacyFile || undefined;
  DATA_DIR_OVERRIDE = legacyFile ? path.dirname(legacyFile) : undefined;
}

/** The data dir holding the per-user provider stores. */
export function providerDataDir(options: DataDirOptions = {}): string {
  return DATA_DIR_OVERRIDE ?? resolveDataDir(options);
}

/** The legacy server-wide providers file (read only by the migration). */
export function getLegacyProvidersFilePath(options: DataDirOptions = {}): string {
  const env = options.env ?? process.env;
  if (LEGACY_FILE_OVERRIDE) return LEGACY_FILE_OVERRIDE;
  return env.SWARM_PROVIDERS_FILE ?? path.join(providerDataDir({ env }), DEFAULT_PROVIDERS_FILE);
}

function requireUserId(userId: string): string {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > MAX_USER_ID_LEN) {
    throw new ProviderMutationError("A signed-in user is required.", 401);
  }
  return userId;
}

/** Directory name for a user: a hash, so ids (emails) never become paths. */
export function userDirName(userId: string): string {
  return createHash("sha256").update(`swarm-user:${requireUserId(userId)}`).digest("hex").slice(0, 32);
}

/** Directory holding one user's provider files. */
export function userProviderDir(userId: string, options: DataDirOptions = {}): string {
  return path.join(providerDataDir(options), "users", userDirName(userId));
}

/** One user's providers file. */
export function userProvidersFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(userProviderDir(userId, options), USER_PROVIDERS_FILE);
}

/** One user's router cooldown state (kept apart so users never clobber each other). */
export function userCooldownFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(userProviderDir(userId, options), USER_COOLDOWN_FILE);
}

/**
 * Per-provider 402 (quota) cooldown end times for one user, read from the
 * same cooldown file the router/gateway persist. Best effort: a missing or
 * malformed file yields {}. Only quota cooldowns (lastErrorKind
 * quota_exhausted) are reported — transient rate-limit backoffs are not.
 */
export function providerQuotaCooldowns(
  userId: string,
  options: DataDirOptions = {},
): Record<string, number> {
  try {
    const store = new CooldownStore({ file: userCooldownFilePath(userId, options) });
    const out: Record<string, number> = {};
    for (const record of store.load()) {
      if (record.lastErrorKind === "quota_exhausted") {
        out[record.provider] = Math.max(out[record.provider] ?? 0, record.cooldownUntil);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function secretOptions(options: DataDirOptions) {
  return { env: options.env ?? process.env, dataDir: providerDataDir(options) };
}

interface StoredProvider extends Omit<ProviderConfig, "keys"> {
  /** Sealed (AES-256-GCM) keys. Never plaintext on disk. */
  sealedKeys?: string[];
}

interface StoredFile {
  version: number;
  userId: string;
  providers: StoredProvider[];
}

let warnedPlaintext = false;

function openKeys(userId: string, raw: StoredProvider, options: DataDirOptions): string[] | undefined {
  const hasSealedKeys = Object.prototype.hasOwnProperty.call(raw, "sealedKeys");
  const hasPlaintextKeys = Object.prototype.hasOwnProperty.call(raw, "keys");
  // A rank-only entry has no key fields at all: keep `keys` undefined so it
  // does not shadow a built-in provider's environment keys.
  if (!hasSealedKeys && !hasPlaintextKeys) return undefined;
  const out: string[] = [];
  const legacyPlain = (raw as unknown as { keys?: unknown }).keys;
  const sealedKeys = Array.isArray(raw.sealedKeys) ? raw.sealedKeys : [];
  for (const value of sealedKeys) {
    if (typeof value !== "string") continue;
    try {
      out.push(open(value, userId, raw.id, secretOptions(options)));
    } catch (err) {
      const message = err instanceof SecretBoxError ? err.message : String(err);
      console.error(`[swarm-providers] skipping an unreadable key for provider "${raw.id}": ${message}`);
    }
  }
  // A hand-edited file may carry plaintext `keys`; accept them (they are
  // re-sealed on the next write) but say so.
  if (Array.isArray(legacyPlain)) {
    for (const value of legacyPlain) {
      if (typeof value !== "string" || !value) continue;
      if (isSealed(value)) continue;
      if (!warnedPlaintext) {
        warnedPlaintext = true;
        console.warn("[swarm-providers] a per-user providers file holds plaintext keys; they are re-encrypted on the next save.");
      }
      out.push(value);
    }
  }
  return out;
}

/**
 * Whether a provider's legacy repairs apply to this saved config. When
 * LEGACY_REPAIR_HOSTS names hosts for the provider, the config's
 * effective base URL must be on one of them — a config pointing the same
 * provider id at a gateway that still speaks the old wire format keeps
 * its saved style and model ids. An unparseable base URL never repairs.
 */
function legacyRepairsApplyToHost(providerId: string, config: ProviderConfig): boolean {
  const hosts = LEGACY_REPAIR_HOSTS[providerId];
  if (!hosts) return true;
  const baseUrl = config.baseUrl ?? catalogEntry(config.id)?.baseUrl;
  if (!baseUrl) return false;
  try {
    return hosts.includes(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Rewrite model ids and wire styles that shipped as wrong catalog
 * defaults (see LEGACY_MODEL_ID_REPAIRS / LEGACY_API_STYLE_REPAIRS in
 * ./catalog) in a saved config: tier models, the selectable list,
 * capability-override keys, and the effective wire style. Applied on
 * load so every resolution path sees the corrected values; the file on
 * disk catches up on the next write, like plaintext-key re-sealing.
 * Only exact legacy ids/styles for the named provider are rewritten —
 * a user's own model that happens to share the name on another provider
 * is untouched, and providers with a LEGACY_REPAIR_HOSTS entry are only
 * repaired against their own API host.
 */
function repairLegacyModelIds(config: ProviderConfig): ProviderConfig {
  const providerId = canonicalProviderId(config.id);
  if (!LEGACY_MODEL_ID_REPAIRS[providerId] && !LEGACY_API_STYLE_REPAIRS[providerId]) {
    return config;
  }
  if (!legacyRepairsApplyToHost(providerId, config)) return config;
  let changed = false;
  const fix = (modelId: string): string => {
    const next = repairedModelId(config.id, modelId);
    if (next !== modelId) changed = true;
    return next;
  };
  const models = config.models
    ? (Object.fromEntries(
        Object.entries(config.models).map(([tier, modelId]) => [tier, modelId ? fix(modelId) : modelId]),
      ) as Partial<Record<ModelTier, string>>)
    : config.models;
  const availableModels = config.availableModels?.map(fix);
  const modelCapabilities = config.modelCapabilities
    ? Object.fromEntries(
        Object.entries(config.modelCapabilities).map(([modelId, caps]) => [fix(modelId), caps]),
      )
    : config.modelCapabilities;
  // The effective style (explicit, or derived from kind) is what the
  // gateway would send; pin the corrected style explicitly when it moves.
  const repairedStyle = normalizeCatalogApiStyle(
    repairedApiStyle(config.id, apiStyleFor(config)),
  );
  const apiStyle =
    repairedStyle && repairedStyle !== config.apiStyle ? repairedStyle : undefined;
  if (apiStyle) changed = true;
  if (!changed) return config;
  return {
    ...config,
    ...(models ? { models } : {}),
    ...(availableModels ? { availableModels } : {}),
    ...(modelCapabilities ? { modelCapabilities } : {}),
    ...(apiStyle ? { apiStyle } : {}),
  };
}

/**
 * Read one user's saved providers (keys decrypted, server-side only).
 * A missing file returns []. A malformed file, or one that belongs to a
 * different user, returns [] and logs.
 */
export function readConfiguredProviders(userId: string, options: DataDirOptions = {}): ProviderConfig[] {
  const file = userProvidersFilePath(userId, options);
  if (!fs.existsSync(file)) return [];
  let data: StoredFile;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8")) as StoredFile;
  } catch (err) {
    console.error(`[swarm-providers] ignoring unreadable providers file ${file}: ${String(err)}`);
    return [];
  }
  if (!data || typeof data !== "object" || data.userId !== userId || !Array.isArray(data.providers)) {
    console.error(`[swarm-providers] ignoring providers file ${file}: owner mismatch or bad shape.`);
    return [];
  }
  try {
    const plain = data.providers.map((raw) => {
      const { sealedKeys: _sealed, ...rest } = raw;
      void _sealed;
      return { ...rest, keys: openKeys(userId, raw, options) };
    });
    return parseProvidersData({ providers: plain }).map(repairLegacyModelIds);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(`[swarm-providers] ignoring invalid providers file ${file}: ${err.message}`);
      return [];
    }
    throw err;
  }
}

/** Atomically replace one user's providers file, sealing every key. */
export function writeConfiguredProviders(
  userId: string,
  configs: ProviderConfig[],
  options: DataDirOptions = {}
): string {
  const file = userProvidersFilePath(userId, options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: a read-only or foreign-owned mount keeps its mode.
  }
  const sopts = secretOptions(options);
  const providers: StoredProvider[] = configs.map((config) => {
    const { keys, ...rest } = config;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) cleaned[k] = v;
    return {
      ...(cleaned as Omit<ProviderConfig, "keys">),
      ...(keys !== undefined
        ? { sealedKeys: keys.map((key) => seal(key, userId, config.id, sopts)) }
        : {}),
    };
  });
  const body: StoredFile = { version: STORE_VERSION, userId, providers };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
  return file;
}

/** Map a model id list onto the fast/balanced/deep tiers. */
export function tierModels(models: readonly string[]): Partial<Record<ModelTier, string>> {
  const m = models.map((x) => x?.trim()).filter(Boolean);
  if (m.length === 0) return {};
  const fast = m[0];
  const deep = m[m.length - 1];
  const balanced = m[Math.floor((m.length - 1) / 2)] ?? fast;
  return { fast, balanced, deep };
}

export interface SaveProviderInput {
  id: string;
  /** Optional display name; defaults to the catalog entry's name. */
  name?: string;
  apiStyle?: ApiStyle;
  /** How the credential is placed on the wire; defaults from the catalog. */
  auth?: ProviderAuth;
  baseUrl?: string;
  models?: string[];
  /** Models returned by discovery, kept alongside the tier models. */
  availableModels?: string[];
  /** Manual per-model capability overrides. */
  modelCapabilities?: Record<string, ModelCapabilities>;
  /** Extra static headers (names are exposed; values never leave the server). */
  headers?: Record<string, string>;
  /** Omit on edit to keep the existing keys; supply to replace them. */
  apiKey?: string;
  enabled?: boolean;
  /** Lower ranks are tried first. Must be >= 0. Preserved when omitted on edit. */
  rank?: number;
  /** Free provider: estimated cost $0 and preferred when "Prefer free providers" is on. */
  isFree?: boolean;
  /** Input token price per 1M tokens (USD), for cost estimation. */
  inputPricePer1mTokens?: number;
  /** Output token price per 1M tokens (USD), for cost estimation. */
  outputPricePer1mTokens?: number;
  /**
   * Perplexity Agent API effort level. Omit on edit to keep the saved value;
   * null clears it back to the server default. Perplexity only.
   */
  effort?: PerplexityEffort | null;
}

/** Fields an endpoint/model edit may change without touching keys or rank. */
export interface ProviderSettingsPatch {
  apiStyle?: ApiStyle;
  auth?: ProviderAuth;
  baseUrl?: string;
  /** Tier model ids (fast...deep), mapped in order. */
  models?: string[];
  availableModels?: string[];
  modelCapabilities?: Record<string, ModelCapabilities>;
  headers?: Record<string, string>;
  /** Perplexity Agent API effort level; null clears it. Perplexity only. */
  effort?: PerplexityEffort | null;
}

/**
 * Validate an effort value from a save/patch input. Effort is a
 * Perplexity-only Agent API field, so a value on any other provider is a
 * client error rather than dead config. Returns the value to persist
 * (undefined = unset/cleared).
 */
function cleanEffort(
  providerId: string,
  effort: PerplexityEffort | null | undefined,
): PerplexityEffort | undefined {
  if (effort === undefined || effort === null) return undefined;
  if (!isPerplexityEffort(effort)) {
    throw new ProviderMutationError(
      "effort must be one of fast, low, medium, high, xhigh.",
      400,
    );
  }
  if (providerId !== "perplexity") {
    throw new ProviderMutationError(
      "effort is only supported for the Perplexity provider.",
      400,
    );
  }
  return effort;
}

function cleanHeaders(input: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.trim();
    if (!key || !/^[A-Za-z0-9-]+$/.test(key)) {
      throw new ProviderMutationError(`Invalid header name "${key}".`, 400);
    }
    if (typeof value !== "string" || value.length > 4_096) {
      throw new ProviderMutationError(`Invalid value for header "${key}".`, 400);
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cleanModelCapabilities(
  input: Record<string, ModelCapabilities> | undefined,
): Record<string, ModelCapabilities> | undefined {
  if (!input) return undefined;
  const out: Record<string, ModelCapabilities> = {};
  const entries = Object.entries(input);
  if (entries.length > 500) {
    throw new ProviderMutationError("Too many model capability overrides (max 500).", 400);
  }
  for (const [model, caps] of entries) {
    const id = model.trim();
    if (!id) throw new ProviderMutationError("Model id must not be empty.", 400);
    out[id] = {
      vision: caps.vision === true,
      tools: caps.tools === true,
      computerUse: caps.vision === true && caps.tools === true && caps.computerUse === true,
      ...(typeof caps.contextWindow === "number" && Number.isFinite(caps.contextWindow) && caps.contextWindow > 0
        ? { contextWindow: Math.floor(caps.contextWindow) }
        : {}),
      source: caps.source === "discovery" ? "discovery" : "override",
    };
  }
  return out;
}

function cleanModelList(models: string[] | undefined, label: string): string[] | undefined {
  if (!models) return undefined;
  const cleaned = [...new Set(models.map((m) => (typeof m === "string" ? m.trim() : "")).filter(Boolean))];
  if (cleaned.length > 500) {
    throw new ProviderMutationError(`Too many ${label} (max 500).`, 400);
  }
  return cleaned;
}

/** A provider can be saved without a key when it needs none (local/Ollama/auth none). */
function providerNeedsKey(config: Pick<ProviderConfig, "id" | "kind" | "auth" | "apiStyle">): boolean {
  if (config.apiStyle === "ollama") return false;
  if (catalogEntry(config.id)?.isLocal === true) return false;
  return authFor(config).scheme !== "none";
}

export interface SaveProviderResult {
  config: ProviderConfig;
  file: string;
}

/** Validate + normalize an id into a safe provider slug. */
export function normalizeProviderId(id: string): string | null {
  const slug = canonicalProviderId(id);
  if (!slug || slug.length > 64) return null;
  return slug;
}

/**
 * Merge a catalog (or custom) provider with defaults and persist it to the
 * providers file. Existing provider entries with the same id are replaced;
 * built-in defaults stay untouched unless the user saved an override.
 */
export function saveProvider(userId: string, input: SaveProviderInput): SaveProviderResult {
  requireUserId(userId);
  const id = normalizeProviderId(input.id);
  if (!id) {
    throw new Error("Provider id must be a non-empty slug (a-z0-9, dashes).");
  }
  if (
    input.rank !== undefined &&
    (typeof input.rank !== "number" || !Number.isFinite(input.rank) || input.rank < 0)
  ) {
    throw new Error("Rank must be a number greater than or equal to 0.");
  }

  const catalog = catalogEntry(id);
  const existing = readConfiguredProviders(userId);
  const previous = existing.find((c) => c.id === id);
  const apiKey = input.apiKey?.trim();
  const hasKeyInput = typeof input.apiKey === "string";

  const requestedStyle = input.apiStyle;
  if (requestedStyle !== undefined && !isApiStyle(requestedStyle)) {
    throw new ProviderMutationError("Unsupported API style.", 400);
  }
  const apiStyle: ApiStyle =
    requestedStyle ??
    previous?.apiStyle ??
    normalizeCatalogApiStyle(catalog?.apiStyle) ??
    "openai-chat";
  const kind = providerKindForCatalog({ apiStyle });
  const baseUrl = input.baseUrl?.trim() || catalog?.baseUrl || previous?.baseUrl;
  const modelList =
    cleanModelList(input.models, "models") ??
    (previous?.models ? Object.values(previous.models).filter((m): m is string => Boolean(m)) : undefined) ??
    catalog?.models?.popular ??
    [];
  const models = tierModels(modelList);
  const availableModels =
    cleanModelList(input.availableModels, "available models") ?? previous?.availableModels;
  const headers = cleanHeaders(input.headers) ?? previous?.headers;
  const modelCapabilities =
    cleanModelCapabilities(input.modelCapabilities) ?? previous?.modelCapabilities;
  const auth = input.auth ? { ...input.auth } : previous?.auth ?? catalog?.auth;
  const name = input.name?.trim() || catalog?.name || id;
  // Billing flag: an explicit input wins, then the previously saved value,
  // then the catalog's verified free-tier mark. (An edit that omitted
  // isFree used to drop the flag silently, unlike every other field here.)
  const isFree = input.isFree ?? previous?.isFree ?? catalog?.isFree;
  // Effort: an explicit value wins, null clears back to the server default,
  // and an omitted field keeps the saved value (same preserve-on-edit rule
  // as isFree). Validated against the documented enum; Perplexity only.
  const effort =
    input.effort === undefined ? previous?.effort : cleanEffort(id, input.effort);

  const draft = { id, kind, apiStyle, auth } as Pick<ProviderConfig, "id" | "kind" | "auth" | "apiStyle">;
  if (providerNeedsKey(draft)) {
    const hasExistingKey = (previous?.keys?.length ?? 0) > 0;
    if (!hasKeyInput && !hasExistingKey) {
      throw new ProviderMutationError("An API key is required for this provider.", 400);
    }
    if (hasKeyInput && !apiKey && !hasExistingKey) {
      throw new ProviderMutationError("An API key is required for this provider.", 400);
    }
  }

  // Re-saving a provider from the UI must not drop its ordering: keep the
  // existing rank unless the caller explicitly supplies a new one. A brand-new
  // provider goes after everything already configured.
  const configured = routerProviders(userId);
  const known = configured.find((c) => c.id === id);
  const nextRank =
    known === undefined
      ? Math.max(-1, ...configured.map((c) => c.rank ?? 0)) + 1
      : undefined;
  const rank = input.rank ?? previous?.rank ?? nextRank;

  // Config file schema: `keys` is a string array. Supplying a key replaces the
  // key list; omitting it on edit preserves the existing keys.
  const keys = hasKeyInput
    ? apiKey
      ? [apiKey]
      : []
    : previous?.keys;

  const config: ProviderConfig = {
    id,
    kind,
    apiStyle,
    ...(auth ? { auth } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(Object.keys(models).length ? { models } : {}),
    ...(availableModels && availableModels.length > 0 ? { availableModels } : {}),
    ...(modelCapabilities && Object.keys(modelCapabilities).length > 0
      ? { modelCapabilities }
      : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(rank !== undefined ? { rank } : {}),
    ...(isFree !== undefined ? { isFree } : {}),
    ...(input.inputPricePer1mTokens !== undefined
      ? { inputPricePer1mTokens: input.inputPricePer1mTokens }
      : {}),
    ...(input.outputPricePer1mTokens !== undefined
      ? { outputPricePer1mTokens: input.outputPricePer1mTokens }
      : {}),
    ...(effort ? { effort } : {}),
    ...(keys !== undefined ? { keys } : {}),
    enabled: input.enabled ?? previous?.enabled ?? true,
  };

  const rest = existing.filter((c) => c.id !== id);
  const next = [...rest, config];
  const file = writeConfiguredProviders(userId, next);
  return { config, file };
}

/**
 * Update endpoint, auth, model list or capability overrides for a provider
 * without touching its keys. Built-in providers that were never saved get a
 * file entry so the edit sticks; their environment keys keep working in local
 * mode because the entry omits `keys`.
 */
export function updateProviderSettings(
  userId: string,
  id: string,
  patch: ProviderSettingsPatch,
): { config: ProviderConfig; file: string } {
  requireUserId(userId);
  const normalized = normalizeProviderId(id);
  if (!normalized) {
    throw new ProviderMutationError("Provider id must be a slug (a-z, 0-9, dashes).", 400);
  }
  const known = routerProviders(userId).find((c) => c.id === normalized);
  if (!known) throw new ProviderMutationError("Provider not found.", 404);
  const existing = readConfiguredProviders(userId);
  const index = existing.findIndex((c) => c.id === normalized);
  const current = index >= 0 ? existing[index] : undefined;

  if (patch.apiStyle !== undefined && !isApiStyle(patch.apiStyle)) {
    throw new ProviderMutationError("Unsupported API style.", 400);
  }
  const apiStyle = patch.apiStyle ?? current?.apiStyle ?? known.apiStyle;
  const kind =
    apiStyle !== undefined
      ? providerKindForCatalog({ apiStyle })
      : current?.kind ?? known.kind;

  const baseUrl = patch.baseUrl !== undefined ? patch.baseUrl.trim() : current?.baseUrl ?? known.baseUrl;
  const auth = patch.auth ?? current?.auth ?? known.auth;
  const headers = cleanHeaders(patch.headers) ?? current?.headers ?? known.headers;
  const availableModels =
    cleanModelList(patch.availableModels, "available models") ?? current?.availableModels;
  const modelCapabilities =
    cleanModelCapabilities(patch.modelCapabilities) ?? current?.modelCapabilities;
  const models =
    patch.models !== undefined
      ? tierModels(cleanModelList(patch.models, "models") ?? [])
      : current?.models ?? known.models;
  // Effort: omitted keeps the saved value, null clears it. Validated
  // against the documented enum; Perplexity only.
  const effort =
    patch.effort === undefined ? current?.effort : cleanEffort(normalized, patch.effort);

  const updated: ProviderConfig = {
    ...(current ?? { id: normalized, kind, keys: known.keys, envKeys: known.envKeys }),
    id: normalized,
    kind,
    ...(apiStyle ? { apiStyle } : {}),
    ...(auth ? { auth } : {}),
    ...(baseUrl ? { baseUrl } : { baseUrl: undefined }),
    ...(models && Object.keys(models).length > 0 ? { models } : {}),
    ...(availableModels && availableModels.length > 0 ? { availableModels } : {}),
    ...(modelCapabilities && Object.keys(modelCapabilities).length > 0
      ? { modelCapabilities }
      : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(effort ? { effort } : { effort: undefined }),
  };
  // Drop undefined so merge-on-read cannot clobber built-in defaults.
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updated)) {
    if (value !== undefined) cleaned[key] = value;
  }
  const next = [...existing];
  if (index >= 0) next[index] = cleaned as unknown as ProviderConfig;
  else next.push(cleaned as unknown as ProviderConfig);
  const file = writeConfiguredProviders(userId, next);
  return { config: cleaned as unknown as ProviderConfig, file };
}

/**
 * Set one provider's rank (lower runs first) without touching its keys.
 * Unknown providers are rejected; built-ins not yet in the file get a
 * rank-only entry that keeps their environment keys.
 */
export function setProviderRank(userId: string, id: string, rank: number): ProviderConfig {
  requireUserId(userId);
  const normalized = normalizeProviderId(id);
  if (!normalized) {
    throw new ProviderMutationError("Provider id must be a slug (a-z, 0-9, dashes).", 400);
  }
  if (typeof rank !== "number" || !Number.isFinite(rank) || rank < 0) {
    throw new ProviderMutationError("Rank must be a number greater than or equal to 0.", 400);
  }
  const known = routerProviders(userId).find((c) => c.id === normalized);
  if (!known) throw new ProviderMutationError("Provider not found.", 404);

  const existing = readConfiguredProviders(userId);
  const index = existing.findIndex((c) => c.id === normalized);
  if (index >= 0) {
    const next = existing.map((c) => (c.id === normalized ? { ...c, rank } : c));
    writeConfiguredProviders(userId, next);
    return next[index];
  }
  const entry: ProviderConfig = { id: normalized, kind: known.kind, rank };
  writeConfiguredProviders(userId, [...existing, entry]);
  return entry;
}

/** Billing/free-flag fields a provider mutation may update. */
export interface ProviderBillingPatch {
  isFree?: boolean;
  inputPricePer1mTokens?: number;
  outputPricePer1mTokens?: number;
}

/**
 * Update a provider's free flag / price fields without touching its keys or
 * rank. Unknown providers are rejected; built-ins not yet in the file get an
 * entry that keeps their environment keys.
 */
export function setProviderBilling(
  userId: string,
  id: string,
  patch: ProviderBillingPatch,
): ProviderConfig {
  requireUserId(userId);
  const normalized = normalizeProviderId(id);
  if (!normalized) {
    throw new ProviderMutationError("Provider id must be a slug (a-z, 0-9, dashes).", 400);
  }
  const known = routerProviders(userId).find((c) => c.id === normalized);
  if (!known) throw new ProviderMutationError("Provider not found.", 404);

  const existing = readConfiguredProviders(userId);
  const index = existing.findIndex((c) => c.id === normalized);
  if (index >= 0) {
    const next = existing.map((c) =>
      c.id === normalized ? { ...c, ...patch } : c,
    );
    writeConfiguredProviders(userId, next);
    return next[index];
  }
  const entry: ProviderConfig = { id: normalized, kind: known.kind, ...patch };
  writeConfiguredProviders(userId, [...existing, entry]);
  return entry;
}

/**
 * Set or clear a provider's Perplexity Agent API effort level without
 * touching its keys or rank. Null clears back to the server default.
 * Unknown providers are rejected; built-ins not yet in the file get an
 * entry that keeps their environment keys.
 */
export function setProviderEffort(
  userId: string,
  id: string,
  effort: PerplexityEffort | null,
): ProviderConfig {
  requireUserId(userId);
  const normalized = normalizeProviderId(id);
  if (!normalized) {
    throw new ProviderMutationError("Provider id must be a slug (a-z, 0-9, dashes).", 400);
  }
  const cleaned = cleanEffort(normalized, effort);
  const known = routerProviders(userId).find((c) => c.id === normalized);
  if (!known) throw new ProviderMutationError("Provider not found.", 404);

  const existing = readConfiguredProviders(userId);
  const index = existing.findIndex((c) => c.id === normalized);
  if (index >= 0) {
    const next = existing.map((c) =>
      c.id === normalized ? { ...c, ...(cleaned ? { effort: cleaned } : { effort: undefined }) } : c,
    );
    writeConfiguredProviders(userId, next);
    return next[index];
  }
  const entry: ProviderConfig = {
    id: normalized,
    kind: known.kind,
    ...(cleaned ? { effort: cleaned } : {}),
  };
  writeConfiguredProviders(userId, [...existing, entry]);
  return entry;
}

/** Move a provider one position up or down in rank order. */
export function moveProviderRank(
  userId: string,
  id: string,
  direction: "up" | "down",
): ProviderConfig {
  requireUserId(userId);
  const normalized = normalizeProviderId(id);
  if (!normalized) {
    throw new ProviderMutationError("Provider id must be a slug (a-z, 0-9, dashes).", 400);
  }
  const ordered = [...routerProviders(userId)].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const index = ordered.findIndex((c) => c.id === normalized);
  if (index < 0) throw new ProviderMutationError("Provider not found.", 404);
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= ordered.length) {
    throw new ProviderMutationError(
      direction === "up" ? "Provider is already first." : "Provider is already last.",
      400,
    );
  }

  const desired = ordered.map((c) => c.id);
  [desired[index], desired[target]] = [desired[target], desired[index]];
  const existing = readConfiguredProviders(userId);
  const existingById = new Map(existing.map((c) => [c.id, c]));
  const knownById = new Map(ordered.map((c) => [c.id, c]));
  // Normalize ranks to the displayed order so ties (e.g. a new provider and a
  // built-in both at 0) cannot make a move a no-op.
  const next = desired.map((providerId, rank) => {
    const current = existingById.get(providerId);
    if (current) return { ...current, rank };
    return { id: providerId, kind: knownById.get(providerId)!.kind, rank };
  });
  writeConfiguredProviders(userId, next);
  return next.find((c) => c.id === normalized)!;
}

/** Ids of the providers backed by the providers config file. */
export function savedProviderIds(userId: string, options: DataDirOptions = {}): string[] {
  return readConfiguredProviders(userId, options).map((c) => c.id);
}

/** Result of a key mutation: the new provider state, without key material. */
export interface ProviderKeyMutation {
  provider: ProviderConfig;
  file: string;
  /** One slot per key: index plus last-4 mask. */
  slots: ProviderKeySlot[];
}

/** Locate a saved (file-backed) provider entry by id. */
function savedProviderEntry(userId: string, id: string): {
  id: string;
  config: ProviderConfig;
  existing: ProviderConfig[];
} {
  const normalized = normalizeProviderId(id);
  if (!normalized) {
    throw new ProviderMutationError("Provider id must be a slug (a-z, 0-9, dashes).", 400);
  }
  const existing = readConfiguredProviders(userId);
  const config = existing.find((c) => c.id === normalized);
  if (!config) {
    throw new ProviderMutationError("Provider not found.", 404);
  }
  return { id: normalized, config, existing };
}

/** Write a new key list for a saved provider, keeping the file order stable. */
function writeProviderKeys(
  userId: string,
  existing: ProviderConfig[],
  id: string,
  keys: string[]
): { config: ProviderConfig; file: string } {
  const next = existing.map((c) => (c.id === id ? { ...c, keys } : c));
  const file = writeConfiguredProviders(userId, next);
  const config = next.find((c) => c.id === id);
  if (!config) throw new ProviderMutationError("Provider not found.", 404);
  return { config, file };
}

/** Reject a key index that is outside the provider's key list. */
function requireKeyIndex(index: number, keys: string[]): void {
  if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
    throw new ProviderMutationError(`No key at index ${index}.`, 400);
  }
}

/**
 * Append a key to a saved provider. The key is written straight to the
 * providers file; it is never echoed back to the client.
 */
export function addProviderKey(userId: string, id: string, apiKey: string): ProviderKeyMutation {
  const key = apiKey.trim();
  if (!key) throw new ProviderMutationError("An API key is required.", 400);
  const { id: normalized, config, existing } = savedProviderEntry(userId, id);
  const keys = [...(config.keys ?? []), key];
  const written = writeProviderKeys(userId, existing, normalized, keys);
  return { provider: written.config, file: written.file, slots: providerKeySlots(written.config.keys) };
}

/** Remove a single key from a saved provider, addressed by its index. */
export function removeProviderKey(userId: string, id: string, index: number): ProviderKeyMutation {
  const { id: normalized, config, existing } = savedProviderEntry(userId, id);
  const keys = config.keys ?? [];
  requireKeyIndex(index, keys);
  const next = keys.filter((_, i) => i !== index);
  const written = writeProviderKeys(userId, existing, normalized, next);
  return { provider: written.config, file: written.file, slots: providerKeySlots(written.config.keys) };
}

/** Replace a single key of a saved provider, addressed by its index. */
export function rotateProviderKey(userId: string, id: string, index: number, apiKey: string): ProviderKeyMutation {
  const key = apiKey.trim();
  if (!key) throw new ProviderMutationError("An API key is required.", 400);
  const { id: normalized, config, existing } = savedProviderEntry(userId, id);
  const keys = config.keys ?? [];
  requireKeyIndex(index, keys);
  const next = keys.map((k, i) => (i === index ? key : k));
  const written = writeProviderKeys(userId, existing, normalized, next);
  return { provider: written.config, file: written.file, slots: providerKeySlots(written.config.keys) };
}

/**
 * Remove a saved provider from the providers file. Built-in defaults that
 * were never saved are not affected — they are part of the router itself.
 */
export function removeProvider(userId: string, id: string): { id: string; file: string } {
  const normalized = normalizeProviderId(id);
  if (!normalized) {
    throw new ProviderMutationError("Provider id must be a slug (a-z, 0-9, dashes).", 400);
  }
  const existing = readConfiguredProviders(userId);
  const rest = existing.filter((c) => c.id !== normalized);
  if (rest.length === existing.length) {
    throw new ProviderMutationError("Provider not found.", 404);
  }
  const file = writeConfiguredProviders(userId, rest);
  return { id: normalized, file };
}

export interface RouterProvidersOptions extends DataDirOptions {
  /**
   * Let providers without saved keys read host env keys (SWARM_KEYS_*).
   * Only ever honored for the local single-user operator identity
   * (LOCAL_USER_ID): an account's providers never fall back to host keys,
   * in any mode, whatever a caller passes. Defaults to true for the local
   * operator, false for every account.
   */
  hostEnvKeys?: boolean;
}

/**
 * One user's provider set for the router and health probe: built-in
 * defaults, overridden in place by any provider the user saved with the same
 * id, plus the user's other saved providers. File entries win, so a saved
 * provider routes immediately after it is written.
 */
export function routerProviders(userId: string, options: RouterProvidersOptions = {}): ProviderConfig[] {
  const configured = readConfiguredProviders(userId, options);
  // Per-user BYOK is unconditional for accounts: host env keys serve only
  // the local operator identity, never a signed-in user's run. Keying this
  // off the user id (not SWARM_SERVER_MODE) means a deploy that forgets
  // the env var still cannot spend host keys on accounts, and no call
  // site can opt an account back in.
  const hostEnvKeys = userId === LOCAL_USER_ID && (options.hostEnvKeys ?? true);
  const fileById = new Map(configured.map((c) => [c.id, c]));
  // File entries are layered over the built-in defaults, so a saved provider
  // keeps the default rank/budget metadata unless the file overrides it.
  const merged = defaultProviderConfigs().map((def) => {
    const fileEntry = fileById.get(def.id);
    if (!fileEntry) return def;
    // parseProvider emits explicit `undefined` for absent optional fields;
    // those must not clobber the built-in defaults (rank, budgets, ...).
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fileEntry)) {
      if (value !== undefined) cleaned[key] = value;
    }
    return { ...def, ...cleaned } as ProviderConfig;
  });
  for (const entry of configured) {
    if (!merged.some((c) => c.id === entry.id)) merged.push(entry);
  }
  // The Ollama endpoint is a user setting, not only a catalog default, so a
  // custom local/LAN port chosen in the settings drawer reaches the router.
  const overlaid = merged.map((config) => {
    let next =
      config.apiStyle === "ollama"
        ? { ...config, baseUrl: resolveOllamaBaseUrl(userId, config.baseUrl, options) }
        : config;
    // Seed the free-tier flag from the catalog when the user has not set
    // their own billing flag, so built-in defaults (gemini) and providers
    // saved before the catalog carried the mark still route and price as
    // free. An explicit user value always wins.
    if (next.isFree === undefined) {
      const catalogFree = catalogEntry(next.id)?.isFree;
      if (catalogFree !== undefined) next = { ...next, isFree: catalogFree };
    }
    return next;
  });
  if (hostEnvKeys) return overlaid;
  // Account: an explicit key list (possibly empty) stops the router from
  // reading SWARM_KEYS_* — host keys are never shared across accounts.
  return overlaid.map((c) => {
    const { envKeys: _envKeys, ...rest } = c;
    void _envKeys;
    return { ...rest, keys: c.keys ?? [] };
  });
}

/** How many usable providers a user has saved (enabled, with a credential or keyless). */
export function countUserProviders(userId: string, options: DataDirOptions = {}): number {
  return readConfiguredProviders(userId, options).filter(
    (c) =>
      c.enabled !== false &&
      ((c.keys?.length ?? 0) > 0 ||
        catalogEntry(c.id)?.isLocal === true ||
        !providerNeedsKey(c))
  ).length;
}

/**
 * A cheap fingerprint of a user's saved providers (file mtime + size), so a
 * long-lived router can tell when to rebuild.
 */
export function userProvidersSignature(userId: string, options: DataDirOptions = {}): string {
  try {
    const st = fs.statSync(userProvidersFilePath(userId, options));
    // Settings feed the router too (free-vs-paid ordering, Ollama endpoint), so
    // a settings-only change must bust the caller's cache as well. A missing
    // settings file is normal and must not collapse the whole signature.
    let settingsKey = "none";
    try {
      const settings = fs.statSync(userSettingsFilePath(userId, options));
      settingsKey = `${settings.mtimeMs}:${settings.size}`;
    } catch {
      // No settings file yet: defaults apply.
    }
    return `${st.mtimeMs}:${st.size}:${st.ino}:${settingsKey}`;
  } catch {
    return "none";
  }
}
