/**
 * Glue between the LLM gateway (lib/runtime/llm-gateway.ts) and the
 * SwarmRouter core (lib/router). Server-only.
 *
 *   - One process-wide SwarmRouter (fair scheduling across users), with each
 *     user's provider catalog synced from their saved providers and settings.
 *   - Router state (key cooldowns, 402 exhaustion, learned limits, health,
 *     paid spend) persists per user in <user dir>/router_state.json, next to
 *     the user's providers and legacy cooldown files.
 *   - API key values never enter the router: keys are referenced by an opaque
 *     slot id ("key-2#1a2b3c4d", slot + 8 hex chars of a one-way hash) and the
 *     value is looked up here at call time only.
 *   - Per-run stickiness: the provider/model/key that served a run's last
 *     successful call is preferred for its next call (prompt-cache reuse).
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { apiStyleFor, authFor } from "../providers/adapters";
import { mergedModelCapabilities } from "../providers/capabilities";
import { hashProviderKey } from "../providers/cooldown-store";
import { configuredPrice, priceForModel } from "../providers/pricing";
import { userProviderDir, type DataDirOptions } from "../providers/store";
import type { UserSettings } from "../providers/settings";
import type { ProviderConfig } from "../providers/types";
import {
  RouterSnapshotSchema,
  SwarmRouter,
  candidateId,
  type ApiKeyConfigInput,
  type ProviderConfigInput,
  type RouterSnapshot,
  type RouterStore,
  type RoutingDecision,
  type StickyTarget,
} from "../router";

export const ROUTER_STATE_FILE = "router_state.json";

/** Effectively "unknown": the gateway has no per-model limits, so capability gates never fire on size. */
const UNKNOWN_CONTEXT_WINDOW = 10_000_000;

function envInt(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function routerStateFilePath(userId: string, options: DataDirOptions = {}): string {
  return path.join(userProviderDir(userId, options), ROUTER_STATE_FILE);
}

/**
 * Per-user file store for router state. Atomic writes (temp file + rename),
 * 0600 files. A missing or malformed file reads as "no state" — a broken
 * state file must never block LLM traffic.
 */
export class FileRouterStore implements RouterStore {
  constructor(private readonly options: DataDirOptions = {}) {}

  async loadSnapshot(): Promise<RouterSnapshot | null> {
    return null; // State is loaded per user (loadUserSnapshot).
  }

  async saveSnapshot(snapshot: RouterSnapshot): Promise<void> {
    const users = new Set<string>();
    for (const map of [snapshot.keys, snapshot.keyModels, snapshot.modelHealth, snapshot.userUsage]) {
      for (const state of Object.values(map)) users.add(state.userId);
    }
    for (const userId of users) {
      const only = <T extends { userId: string }>(m: Record<string, T>) =>
        Object.fromEntries(Object.entries(m).filter(([, s]) => s.userId === userId));
      await this.saveUserSnapshot(userId, {
        ...snapshot,
        keys: only(snapshot.keys),
        keyModels: only(snapshot.keyModels),
        modelHealth: only(snapshot.modelHealth),
        userUsage: only(snapshot.userUsage),
      });
    }
  }

  async loadUserSnapshot(userId: string): Promise<RouterSnapshot | null> {
    return this.loadUserSnapshotSync(userId);
  }

  loadUserSnapshotSync(userId: string): RouterSnapshot | null {
    try {
      const file = routerStateFilePath(userId, this.options);
      if (!fs.existsSync(file)) return null;
      const parsed = RouterSnapshotSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf-8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async saveUserSnapshot(userId: string, snapshot: RouterSnapshot): Promise<void> {
    try {
      const file = routerStateFilePath(userId, this.options);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // randomUUID (not just pid+ms): two concurrent saves in the same
      // millisecond must not collide on the temp name and lose a rename.
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot) + "\n", { encoding: "utf-8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // Best effort: losing router persistence must not break a request.
    }
  }
}

/**
 * Per-provider 402 exhaustion end times from the router state: a provider is
 * reported only when every one of its keys is out of credit (the earliest
 * reset wins). Used by the providers list next to the legacy cooldown file.
 */
export function routerQuotaCooldowns(
  userId: string,
  options: DataDirOptions = {},
  now: number = Date.now(),
): Record<string, number> {
  const snapshot = new FileRouterStore(options).loadUserSnapshotSync(userId);
  if (!snapshot) return {};
  const byProvider = new Map<string, number[]>();
  const usable = new Set<string>();
  for (const key of Object.values(snapshot.keys)) {
    const until = key.status === "exhausted_credit" ? key.creditResetAt : null;
    if (until === null || until <= now) {
      usable.add(key.providerId);
      continue;
    }
    byProvider.set(key.providerId, [...(byProvider.get(key.providerId) ?? []), until]);
  }
  const out: Record<string, number> = {};
  for (const [provider, untils] of byProvider) {
    if (!usable.has(provider)) out[provider] = Math.min(...untils);
  }
  return out;
}

export interface RoutingCandidate {
  config: ProviderConfig;
  model: string;
}

interface UserEntry {
  signature: string;
  restored: boolean;
}

interface RoutingGlobals {
  router: SwarmRouter;
  users: Map<string, UserEntry>;
  sticky: Map<string, StickyTarget>;
}

const GLOBAL_KEY = Symbol.for("swarm.llmRouting");
const MAX_STICKY_RUNS = 2_000;

/** The process-wide router (survives Next.js dev module reloads). */
function globals(): RoutingGlobals {
  const g = globalThis as unknown as Record<symbol, RoutingGlobals | undefined>;
  let state = g[GLOBAL_KEY];
  if (!state) {
    state = {
      router: new SwarmRouter({
        store: new FileRouterStore(),
        globalMaxConcurrent: envInt("SWARM_ROUTER_MAX_CONCURRENT", 64),
        creditRetryMs: envInt("SWARM_QUOTA_COOLDOWN_MS", 15 * 60_000),
      }),
      users: new Map(),
      sticky: new Map(),
    };
    g[GLOBAL_KEY] = state;
  }
  return state;
}

/** Test hook: drop the process-wide router and all cached user state. */
export function resetLlmRoutingForTests(router?: SwarmRouter): void {
  const g = globalThis as unknown as Record<symbol, RoutingGlobals | undefined>;
  g[GLOBAL_KEY] = router ? { router, users: new Map(), sticky: new Map() } : undefined;
}

/** The process-wide router, for callers outside this module (e.g. the LLM gateway). */
export function sharedRouter(): SwarmRouter {
  return globals().router;
}

export function stickyTargetFor(runId: string | undefined): StickyTarget | undefined {
  return runId ? globals().sticky.get(runId) : undefined;
}

export function rememberStickyTarget(runId: string | undefined, target: StickyTarget): void {
  if (!runId) return;
  const sticky = globals().sticky;
  sticky.delete(runId); // re-insert: Map order is LRU order
  sticky.set(runId, target);
  while (sticky.size > MAX_STICKY_RUNS) {
    const oldest = sticky.keys().next().value;
    if (oldest === undefined) break;
    sticky.delete(oldest);
  }
}

function keySlotId(index: number, value: string): string {
  return `key-${index + 1}#${hashProviderKey(value).slice(0, 8)}`;
}

/** Synthetic key for providers that need no credential (Ollama, auth:none). */
export const KEYLESS_KEY = "no-key-required";

function usableKeys(config: ProviderConfig): string[] {
  const unique = Array.from(new Set((config.keys ?? []).map((k) => k.trim()).filter(Boolean)));
  if (unique.length > 0) return unique;
  const keyless = apiStyleFor(config) === "ollama" || authFor(config).scheme === "none";
  return keyless ? [KEYLESS_KEY] : [];
}

/** Router catalog for one provider config: one model entry per known model. */
function routerProvider(config: ProviderConfig, models: string[]): ProviderConfigInput {
  const price = configuredPrice(config);
  return {
    id: config.id,
    name: config.id,
    // Daily-reset semantics are unknown per provider; a 402 without a reset
    // hint is retried after SWARM_QUOTA_COOLDOWN_MS (creditRetryMs).
    resetsDailyUtc: false,
    models: models.map((model) => {
      const p = price ?? priceForModel(config.id, model);
      const caps = mergedModelCapabilities(config, model);
      return {
        id: model,
        providerId: config.id,
        displayName: model,
        contextWindow: caps.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
        maxOutputTokens: UNKNOWN_CONTEXT_WINDOW,
        // Tool use is gated in the gateway, so keep this permissive: a model
        // with tools disabled can still be routed and receives a tool-free
        // request instead of being excluded here.
        supportsTools: true,
        goodAtLongAgentLoops: false,
        inputCostPer1kUsd: config.isFree === true || !p ? 0 : p.inputPer1m / 1000,
        outputCostPer1kUsd: config.isFree === true || !p ? 0 : p.outputPer1m / 1000,
        // Unknown price is not "free": only providers marked free are.
        isFree: config.isFree === true,
      };
    }),
  };
}

/** What the gateway needs to execute a routed attempt. Holds key values: never log it. */
export interface UserRouting {
  router: SwarmRouter;
  /** Look up the provider config and key value for a router choice. */
  resolve(providerId: string, keyId: string): { config: ProviderConfig; apiKey: string } | undefined;
  /** "providerId:modelId" entries this request may use, in priority order. */
  allowedModels: string[];
  priorityOrder: string[];
  /** Total (provider, key) pairs: an upper bound on useful attempts. */
  keySlots: number;
}

/**
 * Sync one user's catalog into the shared router (only when their providers,
 * keys or settings changed) and restore their persisted state on first use.
 * `candidates` is the request's candidate list in priority order (one model
 * per provider, see orderLlmCandidates).
 */
export async function prepareUserRouting(
  owner: string,
  candidates: RoutingCandidate[],
  settings: UserSettings,
): Promise<UserRouting> {
  const { router, users } = globals();
  const keyValues = new Map<string, string>();
  const configs = new Map<string, ProviderConfig>();
  const keys: ApiKeyConfigInput[] = [];
  const providers: ProviderConfigInput[] = [];
  const maxPerKey = envInt("SWARM_ROUTER_KEY_CONCURRENCY", 8);

  for (const { config } of candidates) {
    if (configs.has(config.id)) continue;
    configs.set(config.id, config);
    // Every model this provider may be asked for, so the catalog (and the
    // health history per model) stays stable across requests.
    const models = new Set<string>();
    for (const m of Object.values(config.models ?? {})) if (typeof m === "string" && m) models.add(m);
    for (const m of config.availableModels ?? []) if (m) models.add(m);
    for (const c of candidates) if (c.config.id === config.id) models.add(c.model);
    providers.push(routerProvider(config, [...models]));
    const unique = usableKeys(config);
    unique.forEach((value, index) => {
      const keyId = keySlotId(index, value);
      keyValues.set(`${config.id}\u0000${keyId}`, value);
      keys.push({ keyId, userId: owner, providerId: config.id, label: `${config.id} ${keyId}`, maxConcurrent: maxPerKey });
    });
  }

  const priorityOrder = candidates.map((c) => `${c.config.id}:${c.model}`);
  const policy = {
    userId: owner,
    priorityOrder: [...configs.keys()],
    allowPaidFallback: settings.allowPaidProviders !== false,
    perRunBudgetUsd: settings.perRunBudgetUsd ?? null,
    perDayBudgetUsd: settings.perDayBudgetUsd ?? null,
    freeFirst: settings.preferFreeProviders,
    maxConcurrentRequests: envInt("SWARM_ROUTER_USER_CONCURRENCY", 8),
  };
  // Key ids carry only a hash prefix, so the signature holds no secrets.
  const signature = JSON.stringify({ providers, keys, policy });

  let entry = users.get(owner);
  if (!entry) {
    entry = { signature: "", restored: false };
    users.set(owner, entry);
  }
  if (!entry.restored) {
    entry.restored = true;
    await router.restoreUser(owner);
  }
  if (entry.signature !== signature) {
    router.syncUser(owner, { providers, keys, policy });
    entry.signature = signature;
  }

  return {
    router,
    resolve(providerId, keyId) {
      const config = configs.get(providerId);
      const apiKey = keyValues.get(`${providerId}\u0000${keyId}`);
      return config && apiKey !== undefined ? { config, apiKey } : undefined;
    },
    allowedModels: priorityOrder,
    priorityOrder,
    keySlots: keys.length,
  };
}

/** Telemetry-safe summary of a routing decision (no keys, prompts or bodies). */
export interface RouteDecisionEventData {
  requestId: string;
  attempt: number;
  chosen: { provider: string; model: string; key: string; isPaid: boolean; sticky: boolean } | null;
  estimatedCostUsd: number;
  failoverReason?: string;
  candidates: Array<{
    provider: string;
    model: string;
    key: string;
    eligible: boolean;
    isPaid: boolean;
    score: number | null;
    reasons: string[];
  }>;
}

const MAX_EVENT_CANDIDATES = 24;

export function decisionEventData(decision: RoutingDecision, attempt: number): RouteDecisionEventData {
  const candidates = decision.candidatesConsidered
    .map((c) => ({
      provider: c.providerId,
      model: c.modelId,
      key: c.keyId,
      eligible: c.eligible,
      isPaid: c.isPaid,
      score: Number.isFinite(c.score) ? c.score : null,
      reasons: c.rejectionReasons.slice(0, 6),
    }))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.score ?? -1e9) - (a.score ?? -1e9))
    .slice(0, MAX_EVENT_CANDIDATES);
  const chosen = decision.chosen;
  return {
    requestId: decision.requestId,
    attempt,
    chosen: chosen
      ? {
          provider: chosen.providerId,
          model: chosen.modelId,
          key: chosen.keyId,
          isPaid: chosen.isPaid,
          sticky: chosen.stickyPreserved,
        }
      : null,
    estimatedCostUsd: decision.estimatedCost,
    ...(decision.failoverReason ? { failoverReason: decision.failoverReason } : {}),
    candidates,
  };
}

export { candidateId };
