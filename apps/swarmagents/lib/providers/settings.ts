/**
 * Per-user LLM routing settings (lib/providers/settings.ts).
 *
 * Lives in the user's own directory next to their providers file
 * (userProviderDir), so each account controls its own routing preferences.
 * Malformed or missing files fall back to defaults — a broken settings file
 * must never block LLM traffic.
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { userProviderDir, type DataDirOptions } from "./store";

/** Name of the settings file inside the user's directory. */
export const USER_SETTINGS_FILE = "settings.json";
const SETTINGS_VERSION = 1;

export interface UserSettings {
  /**
   * Order providers marked free (isFree) before paid ones, keeping the user's
   * rank inside each group. Defaults to true.
   */
  preferFreeProviders: boolean;
  /**
   * Auto-prepend the codebase context pack to the system prompt of every run
   * on the picked repository. Absent means on: the pack is injected unless
   * the user turns it off.
   */
  injectCodebaseContext?: boolean;
  /**
   * Allow providers not marked free when no free one is usable. Absent =
   * allowed (a provider the user saved is a provider they want used).
   */
  allowPaidProviders?: boolean;
  /** USD cap per run on paid providers (estimated from list prices). Absent/null = uncapped. */
  perRunBudgetUsd?: number | null;
  /** USD cap per UTC day on paid providers. Absent/null = uncapped. */
  perDayBudgetUsd?: number | null;
  /**
   * Ollama endpoint the settings drawer probes for auto-detection. Defaults to
   * http://127.0.0.1:11434 when absent (the user's own local/BYOC runtime).
   */
  ollamaBaseUrl?: string;
  /**
   * Token-efficiency controls for the appended system prompt (see
   * lib/harness/context/system-packer.ts). Every field is opt-in: absent
   * means off, and off means the prompt is byte-identical to before.
   */
  tokenEfficiency?: TokenEfficiencySettings;
}

/** Per-user token-efficiency controls; all opt-in, all default off. */
export interface TokenEfficiencySettings {
  /**
   * Pack the appended system prompt (agent card, codebase pack, role
   * prompt, memory) to `systemBudgetTokens`, truncating the lowest-value
   * sections first. The agent card core and role instructions are never
   * truncated. Default false.
   */
  packSystemPrompt?: boolean;
  /**
   * Estimated-token cap for the appended system prompt when packing.
   * Default 16,000 (see DEFAULT_SYSTEM_BUDGET_TOKENS in system-packer.ts;
   * duplicated as a literal here so settings stays dependency-light).
   */
  systemBudgetTokens?: number;
  /**
   * Emit system-prompt sections stable-first (role → agent card →
   * codebase pack → memory) so provider prompt caches hit. Changes the
   * prompt the model sees, so it is opt-in. Default false.
   */
  cacheFriendlyOrder?: boolean;
}

/** Default estimated-token cap for the appended system prompt when packing. */
export const DEFAULT_SYSTEM_BUDGET_TOKENS = 16_000;
/** Bounds for a user-configured system-prompt budget. */
export const MIN_SYSTEM_BUDGET_TOKENS = 1_000;
export const MAX_SYSTEM_BUDGET_TOKENS = 200_000;

/** Token-efficiency settings with every default resolved. */
export interface ResolvedTokenEfficiency {
  packSystemPrompt: boolean;
  systemBudgetTokens: number;
  cacheFriendlyOrder: boolean;
}

/** Resolve a user's token-efficiency settings (absent fields = off/default). */
export function tokenEfficiencyFor(settings: UserSettings): ResolvedTokenEfficiency {
  const te = settings.tokenEfficiency;
  return {
    packSystemPrompt: te?.packSystemPrompt === true,
    systemBudgetTokens:
      typeof te?.systemBudgetTokens === "number" &&
      Number.isFinite(te.systemBudgetTokens) &&
      te.systemBudgetTokens > 0
        ? Math.min(
            MAX_SYSTEM_BUDGET_TOKENS,
            Math.max(MIN_SYSTEM_BUDGET_TOKENS, Math.floor(te.systemBudgetTokens)),
          )
        : DEFAULT_SYSTEM_BUDGET_TOKENS,
    cacheFriendlyOrder: te?.cacheFriendlyOrder === true,
  };
}

/**
 * The harness run-request shape for these settings (RunRequest.systemPacker
 * in lib/harness/types.ts). Kept as a plain object so this module does not
 * import the harness layer.
 */
export function systemPackerOptionsFor(settings: UserSettings): {
  pack: boolean;
  budgetTokens: number;
  cacheFriendlyOrder: boolean;
} {
  const resolved = tokenEfficiencyFor(settings);
  return {
    pack: resolved.packSystemPrompt,
    budgetTokens: resolved.systemBudgetTokens,
    cacheFriendlyOrder: resolved.cacheFriendlyOrder,
  };
}

/** Default local Ollama endpoint. */
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

function parseOllamaUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return trimmed.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function parseBudget(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return undefined;
}

export const DEFAULT_USER_SETTINGS: UserSettings = { preferFreeProviders: true };

/** Is the codebase context pack injected into this account's runs? */
export function codebaseContextInjectionEnabled(settings: UserSettings): boolean {
  return settings.injectCodebaseContext !== false;
}

/** One user's settings file path. */
export function userSettingsFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(userProviderDir(userId, options), USER_SETTINGS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the nested tokenEfficiency object; invalid fields are dropped. */
function parseTokenEfficiency(value: unknown): TokenEfficiencySettings | undefined {
  if (!isRecord(value)) return undefined;
  const out: TokenEfficiencySettings = {};
  if (typeof value.packSystemPrompt === "boolean") out.packSystemPrompt = value.packSystemPrompt;
  if (typeof value.cacheFriendlyOrder === "boolean") out.cacheFriendlyOrder = value.cacheFriendlyOrder;
  const budget = value.systemBudgetTokens;
  if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
    out.systemBudgetTokens = Math.min(
      MAX_SYSTEM_BUDGET_TOKENS,
      Math.max(MIN_SYSTEM_BUDGET_TOKENS, Math.floor(budget)),
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse a settings file body; invalid shapes fall back to defaults. */
export function parseUserSettings(raw: unknown): UserSettings {
  if (!isRecord(raw)) return { ...DEFAULT_USER_SETTINGS };
  const preferFreeProviders = raw.preferFreeProviders;
  const out: UserSettings = {
    preferFreeProviders:
      typeof preferFreeProviders === "boolean" ? preferFreeProviders : DEFAULT_USER_SETTINGS.preferFreeProviders,
  };
  // Optional routing caps: only present when set to a valid value.
  if (typeof raw.injectCodebaseContext === "boolean") out.injectCodebaseContext = raw.injectCodebaseContext;
  if (typeof raw.allowPaidProviders === "boolean") out.allowPaidProviders = raw.allowPaidProviders;
  const perRun = parseBudget(raw.perRunBudgetUsd);
  if (perRun !== undefined) out.perRunBudgetUsd = perRun;
  const perDay = parseBudget(raw.perDayBudgetUsd);
  if (perDay !== undefined) out.perDayBudgetUsd = perDay;
  const ollamaBaseUrl = parseOllamaUrl(raw.ollamaBaseUrl);
  if (ollamaBaseUrl !== undefined) out.ollamaBaseUrl = ollamaBaseUrl;
  const tokenEfficiency = parseTokenEfficiency(raw.tokenEfficiency);
  if (tokenEfficiency !== undefined) out.tokenEfficiency = tokenEfficiency;
  return out;
}

/**
 * Read one user's settings. Missing or unreadable files yield the defaults.
 */
export function readUserSettings(userId: string, options: DataDirOptions = {}): UserSettings {
  const file = userSettingsFilePath(userId, options);
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_USER_SETTINGS };
    return parseUserSettings(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    return { ...DEFAULT_USER_SETTINGS };
  }
}

/**
 * The Ollama endpoint to talk to for one user: their saved setting, else the
 * local default. Every Ollama call site (discover, test, the router) goes
 * through this so a custom local/LAN port configured in the settings drawer
 * actually takes effect instead of being overridden by a hardcoded default.
 */
export function ollamaBaseUrlFor(userId: string, options: DataDirOptions = {}): string {
  return readUserSettings(userId, options).ollamaBaseUrl ?? DEFAULT_OLLAMA_URL;
}

/**
 * Which Ollama endpoint an Ollama provider should actually be called on.
 *
 * `savedBaseUrl` is the provider's own baseUrl, but saving an Ollama provider
 * persists the catalog default into the file — so a stored
 * http://127.0.0.1:11434 means "nothing was chosen", not "pin the default".
 * Only a genuinely different saved value overrides the user's setting.
 */
export function resolveOllamaBaseUrl(
  userId: string,
  savedBaseUrl: string | undefined,
  options: DataDirOptions = {},
): string {
  const pinned = savedBaseUrl?.trim();
  if (pinned && pinned !== DEFAULT_OLLAMA_URL) return pinned;
  return ollamaBaseUrlFor(userId, options);
}

/**
 * Atomically write one user's settings. Rejects unknown keys so a typo never
 * silently creates a setting that is later read back as the default.
 */
export function writeUserSettings(userId: string, settings: UserSettings, options: DataDirOptions = {}): string {
  const file = userSettingsFilePath(userId, options);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: a read-only or foreign-owned mount keeps its mode.
  }
  const body = { version: SETTINGS_VERSION, ...settings };
  // randomUUID (not just pid+ms): two concurrent saves in the same
  // millisecond must not collide on the temp name and lose a rename.
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }
  return file;
}

/** Apply a partial update on top of the current settings and persist it. */
export function updateUserSettings(
  userId: string,
  patch: Partial<UserSettings>,
  options: DataDirOptions = {},
): UserSettings {
  const next = { ...readUserSettings(userId, options), ...patch };
  writeUserSettings(userId, next, options);
  return next;
}
