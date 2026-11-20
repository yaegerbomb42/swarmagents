// Server-only entry point for the multi-provider LLM router.
// Do not import this module from a client component bundle.

export * from "./types";
export {
  AbortError,
  ProviderError,
  RouterError,
  classifyStatus,
  isCooldownKind,
  isRetryableKind,
  parseRetryAfter,
  redact,
} from "./errors";
export { KeyPool } from "./key-pool";
export type { KeyFailure, KeyLease, KeyPoolOptions } from "./key-pool";
export {
  CooldownStore,
  configureCooldownFile,
  hashProviderKey,
  parseCooldownFile,
  resolveCooldownDir,
  resolveCooldownFile,
  COOLDOWN_FILE_NAME,
  COOLDOWN_FILE_VERSION,
} from "./cooldown-store";
export type {
  CooldownFileContents,
  CooldownStoreOptions,
  PersistedCooldown,
} from "./cooldown-store";
export { HealthChecker } from "./health";
export type { HealthCheckerOptions, ProviderHealth } from "./health";
export {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  buildRequest,
  modelForTier,
  parseResponse,
  resolveModel,
  resolveTier,
} from "./adapters";
export { parseStreamFrame, readSseFrames } from "./stream";
export type { SseFrame, StreamPiece } from "./stream";
export type { ModelRequest } from "./adapters";
export {
  buildClaudeEnv,
  classifyClaudeRunError,
  isClaudeFailoverEligible,
} from "./claude-env";
export type { ClaudeSelection, ClaudeSelectionInput } from "./claude-env";
export {
  Router,
  createRouter,
  defaultProviderConfigs,
  aggregateFailureSummary,
} from "./router";
export type { RouterOptions } from "./router";

export { Router as default } from "./router";

export {
  loadProvidersFile,
  loadProvidersFromEnv,
  ConfigValidationError,
} from "./config-file";
export {
  PROVIDER_CATALOG,
  canonicalProviderId,
  catalogEntry,
  providerKindForCatalog,
  providerHue,
} from "./catalog";
export type {
  ProviderCatalogEntry,
  ProviderCatalogLinks,
  CatalogApiStyle,
  CatalogAuthHeader,
  CatalogProviderKind,
} from "./catalog";
export {
  countUserProviders,
  getLegacyProvidersFilePath,
  providerDataDir,
  providerQuotaCooldowns,
  userCooldownFilePath,
  userProvidersFilePath,
  userProvidersSignature,
  readConfiguredProviders,
  resolveDataDir,
  routerProviders,
  saveProvider,
  setProviderRank,
  setProviderBilling,
  moveProviderRank,
  savedProviderIds,
  tierModels,
  writeConfiguredProviders,
  addProviderKey,
  removeProviderKey,
  rotateProviderKey,
  removeProvider,
  ProviderMutationError,
} from "./store";
export type { SaveProviderInput, SaveProviderResult, ProviderKeyMutation, ProviderBillingPatch } from "./store";
export { maskProviderKey, providerKeySlots } from "./keys";
export { migrateLegacyProviders } from "./migrate";
export type { MigrationResult } from "./migrate";
export { providerOwner } from "./owner";
export type { ProviderKeySlot } from "./keys";
export { providerRow, configModels, countProviderKeys } from "./rows";
export type { ProviderRow } from "./rows";
export {
  applyKeyMutation,
  applyRankMutation,
  applyBillingMutation,
  parseKeyMutation,
  parseRankMutation,
  parseBillingMutation,
  isValidProviderKey,
  runKeyMutation,
  runProviderRankMutation,
  runProviderBillingMutation,
  runProviderRemoval,
} from "./mutations";
export type {
  KeyMutationRequest,
  KeyMutationResult,
  MutationResponse,
  ProviderKeyAction,
  ProviderRankAction,
  ProviderBillingAction,
  RankMutationRequest,
  RankMutationResult,
} from "./mutations";
export {
  DEFAULT_PRICE_TABLE,
  estimateCostUsd,
  isFreeProvider,
  priceForModel,
  configuredPrice,
} from "./pricing";
export type { ModelPrice } from "./pricing";
export {
  DEFAULT_USER_SETTINGS,
  parseUserSettings,
  readUserSettings,
  updateUserSettings,
  writeUserSettings,
  userSettingsFilePath,
  USER_SETTINGS_FILE,
} from "./settings";
export type { UserSettings } from "./settings";
