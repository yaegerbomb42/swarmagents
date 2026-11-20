/**
 * SwarmRouter — free-first, quota-aware, health-scored LLM route selection.
 *
 * Originally written by "Hydrogen" (external model) from the SwarmAgents
 * router brief; reviewed, fixed and adapted for this repo. Pure core: no I/O
 * except through the injected RouterStore, time only through the injected
 * Clock. Never sees API key values — keys are referenced by opaque keyIds.
 *
 * Pipeline per request (see selectRoute):
 *   1. hard gates   capability, key lifecycle, concurrency, rolling quotas, paid budget
 *   2. free-first   any eligible free candidate discards all paid ones
 *   3. stickiness   keep the run's provider/model while healthy (prompt cache)
 *   4. scoring      priority + agent-loop fit + quota headroom + health − quality/cost penalties
 */
import {
  ApiKeyConfigSchema,
  ProviderConfigSchema,
  RouterSnapshotSchema,
  SystemClock,
  UserRoutingPolicySchema,
  type ApiKeyConfig,
  type ApiKeyConfigInput,
  type CandidateEvaluation,
  type ChosenTarget,
  type Clock,
  type ExecutionOutcome,
  type KeyModelQuotaState,
  type KeyState,
  type ModelConfig,
  type ModelHealthState,
  type ProviderConfig,
  type ProviderConfigInput,
  type RouteRequest,
  type RouterEvent,
  type RouterOptions,
  type RouterSnapshot,
  type RouterStore,
  type RoutingDecision,
  type UserRoutingPolicy,
  type UserRoutingPolicyInput,
  type UserUsageState,
} from "./types";
import {
  ONE_DAY_MS,
  ONE_MINUTE_MS,
  nextUtcMidnight,
  parseRateLimitHeaders,
  recordWindowUsage,
  sumWindow,
} from "./rolling-window";
import { inspectOutputQuality } from "./quality";
import { FairTenantQueue } from "./fair-queue";

export type RouterEventListener = (event: RouterEvent) => void;

export interface RouteLease {
  decision: RoutingDecision;
  /** Record the upstream result (updates quotas, cooldowns, health) and release the slot. */
  reportOutcome(outcome: ExecutionOutcome): Promise<ExecutionOutcome>;
  /** Release without recording anything (e.g. the client aborted, or a 400 that is not the provider's fault). */
  release(): void;
}

/** Healthy-endpoint priors that EWMAs start from and decay back to. */
const PRIOR_LATENCY_MS = 1_200;
const PRIOR_TTFT_MS = 400;

function defaultPolicy(userId: string): UserRoutingPolicy {
  return {
    userId,
    priorityOrder: [],
    allowPaidFallback: false,
    perRunBudgetUsd: 0,
    perDayBudgetUsd: 0,
    freeFirst: true,
    maxConcurrentRequests: 4,
  };
}

/** Exponential decay of `value` toward `target` over `elapsedMs` with the given half-life. */
function decayToward(value: number, target: number, elapsedMs: number, halfLifeMs: number): number {
  if (elapsedMs <= 0 || halfLifeMs <= 0) return value;
  const keep = Math.pow(0.5, elapsedMs / halfLifeMs);
  return target + (value - target) * keep;
}

export function candidateId(providerId: string, modelId: string, keyId: string): string {
  return `${providerId}:${modelId}:${keyId}`;
}

export function isFreeModel(model: Pick<ModelConfig, "isFree" | "inputCostPer1kUsd" | "outputCostPer1kUsd">): boolean {
  if (model.isFree !== undefined) return model.isFree;
  return model.inputCostPer1kUsd === 0 && model.outputCostPer1kUsd === 0;
}

export interface UserCatalog {
  providers: ProviderConfigInput[];
  keys: ApiKeyConfigInput[];
  policy: UserRoutingPolicyInput;
}

export class SwarmRouter {
  private readonly clock: Clock;
  private readonly store?: RouterStore;
  private readonly longPromptThresholdTokens: number;
  private readonly ewmaAlpha: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly stickyMinHealthScore: number;
  private readonly stickyMinLongQualityScore: number;
  private readonly slowTtftThresholdMs: number;
  private readonly minTokensPerSec: number;
  private readonly creditRetryMs: number;
  private readonly learnedLimitTtlMs: number;
  private readonly healthHalfLifeMs: number;
  private readonly qualityHalfLifeMs: number;
  private readonly maxTrackedRuns: number;

  /** Providers visible to every user (e.g. a shared catalog in tests). */
  private readonly providers = new Map<string, ProviderConfig>();
  /** Per-user provider catalogs; override global entries with the same id. */
  private readonly userProviders = new Map<string, Map<string, ProviderConfig>>();
  private readonly userPolicies = new Map<string, UserRoutingPolicy>();
  private readonly userKeys = new Map<string, ApiKeyConfig[]>();

  // Persisted state maps
  private readonly keyStates = new Map<string, KeyState>();
  private readonly keyModelStates = new Map<string, KeyModelQuotaState>();
  private readonly modelHealthStates = new Map<string, ModelHealthState>();
  private readonly userUsageStates = new Map<string, UserUsageState>();

  // Ephemeral runtime concurrency counters
  private readonly keyInFlight = new Map<string, number>();
  private readonly userInFlight = new Map<string, number>();
  private readonly fairQueue: FairTenantQueue;
  private readonly listeners = new Set<RouterEventListener>();

  constructor(options: RouterOptions = {}) {
    this.clock = options.clock ?? SystemClock;
    this.store = options.store;
    this.longPromptThresholdTokens = options.longPromptThresholdTokens ?? 16_000;
    this.ewmaAlpha = options.ewmaAlpha ?? 0.25;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 300_000;
    this.stickyMinHealthScore = options.stickyMinHealthScore ?? 0.55;
    this.stickyMinLongQualityScore = options.stickyMinLongQualityScore ?? 0.65;
    this.slowTtftThresholdMs = options.slowTtftThresholdMs ?? 5_000;
    this.minTokensPerSec = options.minTokensPerSec ?? 12;
    this.creditRetryMs = options.creditRetryMs ?? 15 * 60_000;
    this.learnedLimitTtlMs = options.learnedLimitTtlMs ?? 60 * 60_000;
    this.healthHalfLifeMs = options.healthHalfLifeMs ?? 10 * 60_000;
    this.qualityHalfLifeMs = options.qualityHalfLifeMs ?? 60 * 60_000;
    this.maxTrackedRuns = options.maxTrackedRuns ?? 500;
    this.fairQueue = new FairTenantQueue(options.globalMaxConcurrent);
  }

  on(listener: RouterEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RouterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A faulty listener must never break routing.
      }
    }
  }

  /** Register a provider for every user, or only for `userId` when given. */
  registerProvider(rawProvider: ProviderConfigInput, userId?: string): void {
    const provider = ProviderConfigSchema.parse(rawProvider);
    if (userId === undefined) {
      this.providers.set(provider.id, provider);
      return;
    }
    const map = this.userProviders.get(userId) ?? new Map<string, ProviderConfig>();
    map.set(provider.id, provider);
    this.userProviders.set(userId, map);
  }

  setUserPolicy(rawPolicy: UserRoutingPolicyInput): void {
    const policy = UserRoutingPolicySchema.parse(rawPolicy);
    this.userPolicies.set(policy.userId, policy);
    this.ensureUserUsageState(policy.userId);
  }

  registerUserKey(rawKey: ApiKeyConfigInput): void {
    const key = ApiKeyConfigSchema.parse(rawKey);
    const list = this.userKeys.get(key.userId) ?? [];
    const existingIdx = list.findIndex((k) => k.keyId === key.keyId && k.providerId === key.providerId);
    if (existingIdx >= 0) {
      list[existingIdx] = key;
    } else {
      list.push(key);
    }
    this.userKeys.set(key.userId, list);
    this.ensureKeyState(key);
  }

  /**
   * Replace one user's provider catalog, keys and policy in one step (the
   * gateway calls this whenever the user's saved providers change). State of
   * keys that no longer exist is dropped; health history is kept.
   */
  syncUser(userId: string, catalog: UserCatalog): void {
    const providers = new Map<string, ProviderConfig>();
    for (const raw of catalog.providers) {
      const provider = ProviderConfigSchema.parse(raw);
      providers.set(provider.id, provider);
    }
    this.userProviders.set(userId, providers);
    const keys = catalog.keys.map((raw) => ApiKeyConfigSchema.parse({ ...raw, userId }));
    this.userKeys.set(userId, keys);
    const live = new Set(keys.map((k) => this.keyStateId(userId, k.providerId, k.keyId)));
    for (const [id, state] of this.keyStates) {
      if (state.userId === userId && !live.has(id)) this.keyStates.delete(id);
    }
    for (const [id, state] of this.keyModelStates) {
      if (state.userId === userId && !live.has(this.keyStateId(userId, state.providerId, state.keyId))) {
        this.keyModelStates.delete(id);
      }
    }
    for (const key of keys) this.ensureKeyState(key);
    this.setUserPolicy({ ...catalog.policy, userId });
  }

  /** Re-enable a key after the user updates credentials or adds billing credit */
  resetKeyStatus(userId: string, providerId: string, keyId: string): void {
    const k = this.keyStates.get(this.keyStateId(userId, providerId, keyId));
    if (k) {
      k.status = "active";
      k.disabledReason = undefined;
      k.cooldownUntil = 0;
      k.creditResetAt = null;
      k.consecutiveFailures = 0;
    }
  }

  async restoreFromStore(): Promise<boolean> {
    if (!this.store) return false;
    const snapshot = await this.store.loadSnapshot();
    if (!snapshot) return false;
    const validated = RouterSnapshotSchema.parse(snapshot);

    this.keyStates.clear();
    this.keyModelStates.clear();
    this.modelHealthStates.clear();
    this.userUsageStates.clear();
    this.mergeSnapshot(validated);
    return true;
  }

  /**
   * Restore one user's persisted state (per-user stores). Replaces only that
   * user's entries. Returns false when nothing was stored.
   */
  async restoreUser(userId: string): Promise<boolean> {
    if (!this.store?.loadUserSnapshot) return false;
    const snapshot = await this.store.loadUserSnapshot(userId);
    if (!snapshot) return false;
    const validated = RouterSnapshotSchema.parse(snapshot);
    for (const map of [this.keyStates, this.keyModelStates, this.modelHealthStates, this.userUsageStates]) {
      for (const [id, state] of map as Map<string, { userId: string }>) {
        if (state.userId === userId) map.delete(id);
      }
    }
    this.mergeSnapshot(validated, userId);
    return true;
  }

  private mergeSnapshot(snapshot: RouterSnapshot, onlyUser?: string): void {
    const keep = (s: { userId: string }) => onlyUser === undefined || s.userId === onlyUser;
    for (const [id, state] of Object.entries(snapshot.keys)) if (keep(state)) this.keyStates.set(id, state);
    for (const [id, state] of Object.entries(snapshot.keyModels)) if (keep(state)) this.keyModelStates.set(id, state);
    for (const [id, state] of Object.entries(snapshot.modelHealth)) if (keep(state)) this.modelHealthStates.set(id, state);
    for (const [id, state] of Object.entries(snapshot.userUsage)) if (keep(state)) this.userUsageStates.set(id, state);
  }

  /** Snapshot of all state, or of one user's state when `userId` is given. */
  snapshot(userId?: string): RouterSnapshot {
    const pick = <T extends { userId: string }>(map: Map<string, T>): Record<string, T> => {
      const out: Record<string, T> = {};
      for (const [id, state] of map) if (userId === undefined || state.userId === userId) out[id] = state;
      return out;
    };
    return {
      version: 1,
      savedAt: this.clock.now(),
      keys: pick(this.keyStates),
      keyModels: pick(this.keyModelStates),
      modelHealth: pick(this.modelHealthStates),
      userUsage: pick(this.userUsageStates),
    };
  }

  async persistToStore(): Promise<void> {
    if (!this.store) return;
    await this.store.saveSnapshot(this.snapshot());
  }

  /** Persist one user's slice when the store supports it, else everything. */
  async persistUser(userId: string): Promise<void> {
    if (!this.store) return;
    if (this.store.saveUserSnapshot) {
      await this.store.saveUserSnapshot(userId, this.snapshot(userId));
      return;
    }
    await this.persistToStore();
  }

  /** Health state with idle-time decay applied (read-only view). */
  getModelHealth(userId: string, providerId: string, modelId: string): ModelHealthState {
    return this.decayedHealth(this.ensureModelHealthState(userId, providerId, modelId), this.clock.now());
  }

  getKeyState(userId: string, providerId: string, keyId: string): KeyState | undefined {
    const state = this.keyStates.get(this.keyStateId(userId, providerId, keyId));
    if (state) {
      this.refreshTimeBasedTransitions(state, this.clock.now());
    }
    return state;
  }

  getUserUsage(userId: string): UserUsageState {
    return this.ensureUserUsageState(userId);
  }

  /**
   * Lift the per-run budget cap for one run. Called when the owner answers
   * "continue" to a budget pause (see the LLM gateway): the router otherwise
   * keeps excluding paid providers for the rest of the run, which would make
   * the answer meaningless. The daily cap still applies.
   */
  async grantRunBudgetExemption(userId: string, runId: string): Promise<void> {
    const usage = this.ensureUserUsageState(userId);
    if (usage.runBudgetExempt[runId]) return;
    usage.runBudgetExempt[runId] = true;
    const ids = Object.keys(usage.runBudgetExempt);
    const excess = ids.length - this.maxTrackedRuns;
    // Insertion order: the oldest exempt runs come first.
    for (let i = 0; i < excess; i++) delete usage.runBudgetExempt[ids[i]!];
    await this.persistUser(userId);
  }

  /** Every key's state for one user (for status UIs). */
  listKeyStates(userId: string): KeyState[] {
    const now = this.clock.now();
    const out: KeyState[] = [];
    for (const state of this.keyStates.values()) {
      if (state.userId !== userId) continue;
      this.refreshTimeBasedTransitions(state, now);
      out.push(state);
    }
    return out;
  }

  private providersFor(userId: string): ProviderConfig[] {
    const merged = new Map(this.providers);
    for (const [id, provider] of this.userProviders.get(userId) ?? []) merged.set(id, provider);
    return [...merged.values()];
  }

  /**
   * Pure decision evaluation without acquiring concurrency slots.
   */
  selectRoute(request: RouteRequest): RoutingDecision {
    const now = this.clock.now();
    const policy = this.userPolicies.get(request.userId) ?? defaultPolicy(request.userId);
    const usage = this.ensureUserUsageState(request.userId);
    const userKeys = this.userKeys.get(request.userId) ?? [];
    const isLongPrompt = request.estimatedPromptTokens >= this.longPromptThresholdTokens;
    const excluded = new Set(request.excludeTargets ?? []);
    const allowed = request.allowedModels ? new Set(request.allowedModels) : null;

    const allEvaluations: CandidateEvaluation[] = [];
    const reasonsRejected: Record<string, string[]> = {};

    const keysByProvider = new Map<string, ApiKeyConfig[]>();
    for (const key of userKeys) {
      const list = keysByProvider.get(key.providerId) ?? [];
      list.push(key);
      keysByProvider.set(key.providerId, list);
    }

    for (const provider of this.providersFor(request.userId)) {
      const providerKeys = keysByProvider.get(provider.id) ?? [];

      for (const model of provider.models) {
        if (allowed && !allowed.has(`${provider.id}:${model.id}`)) continue;
        const estimatedCost = this.estimateCostUsd(model, request.estimatedPromptTokens, request.maxOutputTokens);
        const isPaid = !isFreeModel(model);

        if (providerKeys.length === 0) {
          const id = candidateId(provider.id, model.id, "no-key");
          const reasons = ["no_api_key_configured"];
          reasonsRejected[id] = reasons;
          allEvaluations.push({
            providerId: provider.id,
            modelId: model.id,
            keyId: "none",
            isPaid,
            eligible: false,
            score: -Infinity,
            estimatedCostUsd: estimatedCost,
            rejectionReasons: reasons,
          });
          continue;
        }

        for (const keyCfg of providerKeys) {
          const id = candidateId(provider.id, model.id, keyCfg.keyId);
          const evaluation = this.evaluateCandidate(
            request,
            policy,
            usage,
            provider,
            model,
            keyCfg,
            estimatedCost,
            isPaid,
            isLongPrompt,
            now,
          );
          if (excluded.has(id)) {
            evaluation.eligible = false;
            evaluation.score = -Infinity;
            evaluation.rejectionReasons.push("already_failed_this_request");
          }
          allEvaluations.push(evaluation);
          if (!evaluation.eligible) {
            reasonsRejected[id] = evaluation.rejectionReasons;
          }
        }
      }
    }

    const eligibleAll = allEvaluations.filter((e) => e.eligible);
    const eligibleFree = eligibleAll.filter((e) => !e.isPaid);
    const eligiblePaid = eligibleAll.filter((e) => e.isPaid);

    let activePool: CandidateEvaluation[];
    if (!policy.freeFirst) {
      activePool = eligibleAll;
    } else if (eligibleFree.length > 0) {
      activePool = eligibleFree;
      for (const paidCandidate of eligiblePaid) {
        paidCandidate.eligible = false;
        paidCandidate.rejectionReasons.push("free_tier_available");
        reasonsRejected[candidateId(paidCandidate.providerId, paidCandidate.modelId, paidCandidate.keyId)] =
          paidCandidate.rejectionReasons;
      }
    } else {
      activePool = eligiblePaid;
    }

    let chosenEval: CandidateEvaluation | null = null;
    let stickyPreserved = false;
    let failoverReason: string | undefined;

    if (request.stickyTarget) {
      const sticky = request.stickyTarget;
      const matchingSticky = activePool.filter(
        (c) => c.providerId === sticky.providerId && c.modelId === sticky.modelId,
      );

      if (matchingSticky.length > 0) {
        const health = this.decayedHealth(
          this.ensureModelHealthState(request.userId, sticky.providerId, sticky.modelId),
          now,
        );
        const healthFactor = this.computeHealthFactor(health);
        const qualityScore = isLongPrompt ? health.longPromptQualityScore : health.shortPromptQualityScore;
        const stickyHealthy =
          healthFactor >= this.stickyMinHealthScore && qualityScore >= this.stickyMinLongQualityScore;

        if (stickyHealthy) {
          // Prefer the exact sticky key if eligible, otherwise rotate to highest-scoring key on same provider
          matchingSticky.sort((a, b) => {
            if (sticky.keyId) {
              if (a.keyId === sticky.keyId && b.keyId !== sticky.keyId) return -1;
              if (b.keyId === sticky.keyId && a.keyId !== sticky.keyId) return 1;
            }
            return b.score - a.score;
          });
          chosenEval = matchingSticky[0]!;
          chosenEval.breakdown!.stickyApplied = true;
          stickyPreserved = true;
        } else {
          failoverReason =
            qualityScore < this.stickyMinLongQualityScore
              ? `Sticky model ${sticky.providerId}:${sticky.modelId} demoted for ${isLongPrompt ? "long" : "short"} prompts (quality=${qualityScore.toFixed(2)})`
              : `Sticky model ${sticky.providerId}:${sticky.modelId} degraded (health=${healthFactor.toFixed(2)})`;
        }
      } else {
        const stickyReasons = allEvaluations
          .filter((e) => e.providerId === sticky.providerId && e.modelId === sticky.modelId)
          .flatMap((e) => e.rejectionReasons);
        const uniqueReasons = Array.from(new Set(stickyReasons));
        failoverReason =
          uniqueReasons.length > 0
            ? `Sticky target ${sticky.providerId}:${sticky.modelId} unavailable: ${uniqueReasons.join(", ")}`
            : `Sticky target ${sticky.providerId}:${sticky.modelId} unavailable`;
      }
    }

    if (!chosenEval && activePool.length > 0) {
      activePool.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const cmpProv = a.providerId.localeCompare(b.providerId);
        if (cmpProv !== 0) return cmpProv;
        const cmpModel = a.modelId.localeCompare(b.modelId);
        if (cmpModel !== 0) return cmpModel;
        return a.keyId.localeCompare(b.keyId);
      });
      chosenEval = activePool[0]!;
    }

    const chosen: ChosenTarget | null = chosenEval
      ? {
          providerId: chosenEval.providerId,
          modelId: chosenEval.modelId,
          keyId: chosenEval.keyId,
          isPaid: chosenEval.isPaid,
          stickyPreserved,
        }
      : null;

    const decision: RoutingDecision = {
      requestId: request.requestId,
      userId: request.userId,
      runId: request.runId,
      timestamp: now,
      chosen,
      candidatesConsidered: allEvaluations,
      reasonsRejected,
      estimatedCost: chosenEval ? chosenEval.estimatedCostUsd : 0,
      failoverReason,
    };

    if (request.stickyTarget && failoverReason && chosen) {
      this.emit({
        type: "route:failover",
        timestamp: now,
        userId: request.userId,
        runId: request.runId,
        requestId: request.requestId,
        from: request.stickyTarget,
        to: chosen,
        reason: failoverReason,
      });
    }

    this.emit({
      type: "route:selected",
      timestamp: now,
      decision,
    });

    return decision;
  }

  /**
   * Enqueues the request in the multi-tenant fair scheduler, waits for user & key
   * concurrency slots, selects the optimal route at dispatch time, and returns a lease.
   * The global, per-user and per-key slots are held until the lease is settled.
   */
  async routeAndAcquire(request: RouteRequest): Promise<RouteLease> {
    const canDispatchForUser = (): boolean => {
      const policy = this.userPolicies.get(request.userId) ?? defaultPolicy(request.userId);
      const currentUserActive = this.userInFlight.get(request.userId) ?? 0;
      if (currentUserActive >= policy.maxConcurrentRequests) {
        return false;
      }
      // Dispatch when at least one usable key has a free slot. When no key is
      // usable at all (none configured, or all disabled/exhausted/cooling),
      // dispatch immediately so the caller gets an explanatory empty decision
      // instead of waiting forever.
      const keys = this.userKeys.get(request.userId) ?? [];
      if (keys.length === 0) return true;
      const now = this.clock.now();
      let anyActiveKeyExists = false;
      for (const k of keys) {
        const state = this.ensureKeyState(k);
        this.refreshTimeBasedTransitions(state, now);
        if (state.status !== "active") continue;
        anyActiveKeyExists = true;
        const active = this.keyInFlight.get(this.keyStateId(k.userId, k.providerId, k.keyId)) ?? 0;
        if (active < k.maxConcurrent) return true;
      }
      return !anyActiveKeyExists;
    };

    return this.fairQueue.enqueue<RouteLease>(
      request.userId,
      request.requestId,
      canDispatchForUser,
      (releaseGlobal) => {
        const decision = this.selectRoute(request);
        let released = false;
        let outcomeRecorded = false;
        const chosen = decision.chosen;
        const fullKeyId = chosen ? this.keyStateId(request.userId, chosen.providerId, chosen.keyId) : "";

        if (chosen) {
          this.userInFlight.set(request.userId, (this.userInFlight.get(request.userId) ?? 0) + 1);
          this.keyInFlight.set(fullKeyId, (this.keyInFlight.get(fullKeyId) ?? 0) + 1);
          // Count the request against rolling windows at dispatch time so
          // concurrent requests cannot overshoot an RPM/RPD limit.
          this.countRequest(request.userId, chosen.providerId, chosen.keyId, chosen.modelId);
        } else {
          releaseGlobal();
        }

        const release = () => {
          if (released) return;
          released = true;
          if (chosen) {
            this.userInFlight.set(request.userId, Math.max(0, (this.userInFlight.get(request.userId) ?? 0) - 1));
            this.keyInFlight.set(fullKeyId, Math.max(0, (this.keyInFlight.get(fullKeyId) ?? 0) - 1));
            releaseGlobal();
          }
          this.fairQueue.notifyCapacityAvailable();
        };

        const reportOutcome = async (outcome: ExecutionOutcome): Promise<ExecutionOutcome> => {
          if (!chosen || outcomeRecorded) {
            release();
            return outcome;
          }
          outcomeRecorded = true;
          try {
            return await this.recordOutcomeInternal(request, chosen, outcome, true);
          } finally {
            release();
          }
        };

        return { decision, reportOutcome, release };
      },
    );
  }

  /**
   * Updates rolling quotas, learned rate limits, exponential backoff cooldowns,
   * health EWMA, output-quality scores, and spend caps after an execution attempt.
   */
  async recordOutcome(
    request: RouteRequest,
    target: Pick<ChosenTarget, "providerId" | "modelId" | "keyId">,
    outcome: ExecutionOutcome,
  ): Promise<ExecutionOutcome> {
    return this.recordOutcomeInternal(request, target, outcome, false);
  }

  private countRequest(userId: string, providerId: string, keyId: string, modelId: string): void {
    const keyCfg = (this.userKeys.get(userId) ?? []).find((k) => k.keyId === keyId && k.providerId === providerId);
    if (!keyCfg) return;
    const now = this.clock.now();
    const keyState = this.ensureKeyState(keyCfg);
    const kmState = this.ensureKeyModelState(userId, providerId, keyId, modelId);
    keyState.rpmEntries = recordWindowUsage(keyState.rpmEntries, ONE_MINUTE_MS, now, 1);
    keyState.rpdEntries = recordWindowUsage(keyState.rpdEntries, ONE_DAY_MS, now, 1);
    kmState.rpmEntries = recordWindowUsage(kmState.rpmEntries, ONE_MINUTE_MS, now, 1);
    kmState.rpdEntries = recordWindowUsage(kmState.rpdEntries, ONE_DAY_MS, now, 1);
  }

  private async recordOutcomeInternal(
    request: RouteRequest,
    target: Pick<ChosenTarget, "providerId" | "modelId" | "keyId">,
    outcome: ExecutionOutcome,
    requestAlreadyCounted: boolean,
  ): Promise<ExecutionOutcome> {
    const now = this.clock.now();
    const provider = this.providersFor(request.userId).find((p) => p.id === target.providerId);
    const model = provider?.models.find((m) => m.id === target.modelId);
    const keyCfg = (this.userKeys.get(request.userId) ?? []).find(
      (k) => k.keyId === target.keyId && k.providerId === target.providerId,
    );

    if (!provider || !model || !keyCfg) {
      return outcome;
    }

    const keyState = this.ensureKeyState(keyCfg);
    const kmState = this.ensureKeyModelState(request.userId, target.providerId, target.keyId, target.modelId);
    const health = this.ensureModelHealthState(request.userId, target.providerId, target.modelId);
    // Bring idle-decayed health up to date before blending in the new sample.
    Object.assign(health, this.decayedHealth(health, now));
    const usage = this.ensureUserUsageState(request.userId);
    const isLongPrompt = request.estimatedPromptTokens >= this.longPromptThresholdTokens;

    const promptTokens = outcome.promptTokensActual ?? request.estimatedPromptTokens;
    const completionTokens = outcome.completionTokensActual ?? 0;
    const totalTokens = promptTokens + completionTokens;

    // 1. Count the attempt against rolling windows (providers count 429/5xx/200 toward RPM)
    if (!requestAlreadyCounted) {
      this.countRequest(request.userId, target.providerId, target.keyId, target.modelId);
    }
    if (totalTokens > 0) {
      keyState.tpmEntries = recordWindowUsage(keyState.tpmEntries, ONE_MINUTE_MS, now, totalTokens);
      kmState.tpmEntries = recordWindowUsage(kmState.tpmEntries, ONE_MINUTE_MS, now, totalTokens);
    }

    const parsedHeaders = parseRateLimitHeaders(outcome.headers, now);
    if (parsedHeaders.limitRequests !== undefined) {
      keyState.learnedRpmLimit = parsedHeaders.limitRequests;
      keyState.learnedLimitsAt = now;
    }
    if (parsedHeaders.limitTokens !== undefined) {
      keyState.learnedTpmLimit = parsedHeaders.limitTokens;
      keyState.learnedLimitsAt = now;
    }

    // 2. Inspect 200 OK output quality before declaring true success
    let effectiveOutcome: ExecutionOutcome = outcome;
    if (outcome.ok) {
      const qualityCheck = inspectOutputQuality({
        outputText: outcome.outputText,
        toolCalls: outcome.toolCalls,
        requiresTools: request.requiresTools,
        promptSample: request.promptSample,
      });

      if (qualityCheck.isGarbled) {
        effectiveOutcome = {
          ...outcome,
          ok: false,
          errorType: "garbled_output",
          errorMessage: `${qualityCheck.reason}: ${qualityCheck.details ?? "Garbled response"}`,
        };
      }
    }

    // 3. Handle success vs specific failure modes
    if (effectiveOutcome.ok) {
      keyState.consecutiveFailures = 0;
      if (keyState.status === "cooldown" && now >= keyState.cooldownUntil) {
        keyState.status = "active";
      }

      // Update spend if paid
      const actualCost = this.estimateCostUsd(model, promptTokens, completionTokens);
      if (actualCost > 0) {
        usage.dailySpendUsd += actualCost;
        usage.runSpendUsd[request.runId] = (usage.runSpendUsd[request.runId] ?? 0) + actualCost;
        this.pruneRunSpend(usage);
      }

      // Recover quality scores gradually on clean completions
      if (isLongPrompt) {
        health.longPromptQualityScore = Math.min(1, health.longPromptQualityScore + 0.05);
      } else {
        health.shortPromptQualityScore = Math.min(1, health.shortPromptQualityScore + 0.05);
      }

      this.updateHealthMetrics(health, effectiveOutcome, true, completionTokens, now);
    } else {
      const status = effectiveOutcome.httpStatus;
      const errType = effectiveOutcome.errorType;

      if (errType === "garbled_output") {
        // Output quality failure: demote model specifically for the prompt length class
        if (isLongPrompt) {
          health.longPromptGarbleCount += 1;
          health.longPromptQualityScore = Number(Math.max(0.05, health.longPromptQualityScore * 0.35).toFixed(4));
        } else {
          health.shortPromptQualityScore = Number(Math.max(0.05, health.shortPromptQualityScore * 0.4).toFixed(4));
        }
        this.emit({
          type: "model:demoted",
          timestamp: now,
          userId: request.userId,
          providerId: target.providerId,
          modelId: target.modelId,
          isLongPrompt,
          newQualityScore: isLongPrompt ? health.longPromptQualityScore : health.shortPromptQualityScore,
          reason: effectiveOutcome.errorMessage ?? `Garbled output on ${isLongPrompt ? "long" : "short"} prompt`,
        });
        // The endpoint answered, so latency still counts, but the garble is
        // already priced in via the quality score of this prompt-length
        // class; feeding the shared error rate too would also push the model
        // off the prompts it handles fine.
        this.updateHealthMetrics(health, effectiveOutcome, true, completionTokens, now);
      } else if (status === 401 || status === 403 || errType === "auth") {
        keyState.status = "disabled_auth";
        keyState.disabledReason = effectiveOutcome.errorMessage ?? `HTTP ${status ?? 401} auth failure`;
        this.emit({
          type: "key:disabled",
          timestamp: now,
          userId: request.userId,
          providerId: target.providerId,
          keyId: target.keyId,
          status: "disabled_auth",
          resetAt: null,
          reason: keyState.disabledReason,
        });
      } else if (status === 402 || errType === "billing") {
        keyState.status = "exhausted_credit";
        // Reset hint from headers, else next UTC midnight for daily free tiers,
        // else a bounded retry window — never a permanent lockout, since
        // nothing re-enables the key automatically once credit is topped up.
        const resetAt =
          parsedHeaders.resetAtMs ??
          (parsedHeaders.retryAfterMs !== undefined ? now + parsedHeaders.retryAfterMs : undefined) ??
          (provider.resetsDailyUtc ? nextUtcMidnight(now) : now + this.creditRetryMs);
        keyState.creditResetAt = resetAt;
        keyState.disabledReason = effectiveOutcome.errorMessage ?? "HTTP 402 out of credit";
        this.emit({
          type: "key:disabled",
          timestamp: now,
          userId: request.userId,
          providerId: target.providerId,
          keyId: target.keyId,
          status: "exhausted_credit",
          resetAt,
          reason: keyState.disabledReason,
        });
      } else if (status === 429 || errType === "rate_limit") {
        keyState.consecutiveFailures += 1;
        keyState.status = "cooldown";

        // Learn an effective RPM ceiling when headers don't state one. Only
        // with real evidence (2+ requests in the window): a 429 on the first
        // request is a TPM/concurrency/shared limit, not "RPM = 1".
        const currentRpm = sumWindow(keyState.rpmEntries, ONE_MINUTE_MS, now);
        if (parsedHeaders.limitRequests === undefined && currentRpm >= 2) {
          const inferredCeiling = currentRpm - 1;
          keyState.learnedRpmLimit =
            keyState.learnedRpmLimit !== undefined
              ? Math.min(keyState.learnedRpmLimit, inferredCeiling)
              : inferredCeiling;
          keyState.learnedLimitsAt = now;
        }

        const cooldownMs =
          parsedHeaders.retryAfterMs !== undefined
            ? Math.min(parsedHeaders.retryAfterMs, ONE_DAY_MS)
            : this.computeBackoffWithJitter(keyState.consecutiveFailures);

        keyState.cooldownUntil = now + cooldownMs;
        this.emit({
          type: "key:cooldown",
          timestamp: now,
          userId: request.userId,
          providerId: target.providerId,
          keyId: target.keyId,
          cooldownUntil: keyState.cooldownUntil,
          reason: effectiveOutcome.errorMessage ?? `HTTP 429 rate limited for ${cooldownMs}ms`,
        });
        // Rate limits on a key shouldn't ruin model quality; count the request only.
        health.totalRequests += 1;
        health.lastUpdatedAt = now;
      } else {
        // 5xx, timeout, or network error
        keyState.consecutiveFailures += 1;
        keyState.status = "cooldown";
        const cooldownMs = this.computeBackoffWithJitter(keyState.consecutiveFailures);
        keyState.cooldownUntil = now + cooldownMs;
        this.emit({
          type: "key:cooldown",
          timestamp: now,
          userId: request.userId,
          providerId: target.providerId,
          keyId: target.keyId,
          cooldownUntil: keyState.cooldownUntil,
          reason:
            effectiveOutcome.errorMessage ?? `Provider fault (${status ?? errType ?? "unknown"}), cooldown ${cooldownMs}ms`,
        });
        this.updateHealthMetrics(health, effectiveOutcome, false, completionTokens, now);
      }
    }

    await this.persistUser(request.userId);
    return effectiveOutcome;
  }

  private evaluateCandidate(
    request: RouteRequest,
    policy: UserRoutingPolicy,
    usage: UserUsageState,
    provider: ProviderConfig,
    model: ModelConfig,
    keyCfg: ApiKeyConfig,
    estimatedCostUsd: number,
    isPaid: boolean,
    isLongPrompt: boolean,
    now: number,
  ): CandidateEvaluation {
    const reasons: string[] = [];
    const totalTokensNeeded = request.estimatedPromptTokens + request.maxOutputTokens;

    // 1. Capability checks
    if (model.contextWindow < totalTokensNeeded) {
      reasons.push(`context_window_too_small:${model.contextWindow}<${totalTokensNeeded}`);
    }
    if (model.maxOutputTokens < request.maxOutputTokens) {
      reasons.push(`max_output_too_small:${model.maxOutputTokens}<${request.maxOutputTokens}`);
    }
    if (request.requiresTools && !model.supportsTools) {
      reasons.push("tools_not_supported");
    }

    // 2. Paid fallback & budget checks (null budget = uncapped)
    if (isPaid) {
      if (!policy.allowPaidFallback) {
        reasons.push("paid_fallback_disabled");
      } else {
        const currentRunSpend = usage.runSpendUsd[request.runId] ?? 0;
        const runExempt = usage.runBudgetExempt[request.runId] === true;
        if (!runExempt && policy.perRunBudgetUsd !== null && currentRunSpend + estimatedCostUsd > policy.perRunBudgetUsd) {
          reasons.push(
            `per_run_budget_exceeded:${(currentRunSpend + estimatedCostUsd).toFixed(4)}>${policy.perRunBudgetUsd.toFixed(4)}`,
          );
        }
        if (policy.perDayBudgetUsd !== null && usage.dailySpendUsd + estimatedCostUsd > policy.perDayBudgetUsd) {
          reasons.push(
            `per_day_budget_exceeded:${(usage.dailySpendUsd + estimatedCostUsd).toFixed(4)}>${policy.perDayBudgetUsd.toFixed(4)}`,
          );
        }
      }
    }

    // 3. Key lifecycle, concurrency & rolling quota checks
    const keyState = this.ensureKeyState(keyCfg);
    this.refreshTimeBasedTransitions(keyState, now);

    if (keyState.status === "disabled_auth") {
      reasons.push("key_disabled_auth");
    } else if (keyState.status === "exhausted_credit") {
      reasons.push("key_exhausted_credit_402");
    } else if (keyState.status === "cooldown" && now < keyState.cooldownUntil) {
      reasons.push(`key_in_cooldown_until_${keyState.cooldownUntil}`);
    }

    const activeOnKey = this.keyInFlight.get(this.keyStateId(keyCfg.userId, provider.id, keyCfg.keyId)) ?? 0;
    if (activeOnKey >= keyCfg.maxConcurrent) {
      reasons.push(`key_concurrency_saturated:${activeOnKey}/${keyCfg.maxConcurrent}`);
    }

    const effectiveRpmLimit = keyState.learnedRpmLimit ?? keyCfg.rpmLimit ?? provider.defaultKeyRpmLimit;
    const effectiveTpmLimit = keyState.learnedTpmLimit ?? keyCfg.tpmLimit ?? provider.defaultKeyTpmLimit;
    const effectiveRpdLimit = keyState.learnedRpdLimit ?? keyCfg.rpdLimit ?? provider.defaultKeyRpdLimit;

    const usedRpm = sumWindow(keyState.rpmEntries, ONE_MINUTE_MS, now);
    const usedTpm = sumWindow(keyState.tpmEntries, ONE_MINUTE_MS, now);
    const usedRpd = sumWindow(keyState.rpdEntries, ONE_DAY_MS, now);

    if (effectiveRpmLimit !== undefined && usedRpm + 1 > effectiveRpmLimit) {
      reasons.push(`rpm_quota_exhausted:${usedRpm}/${effectiveRpmLimit}`);
    }
    if (effectiveTpmLimit !== undefined && usedTpm + totalTokensNeeded > effectiveTpmLimit) {
      reasons.push(`tpm_quota_exhausted:${usedTpm}+${totalTokensNeeded}>${effectiveTpmLimit}`);
    }
    if (effectiveRpdLimit !== undefined && usedRpd + 1 > effectiveRpdLimit) {
      reasons.push(`rpd_quota_exhausted:${usedRpd}/${effectiveRpdLimit}`);
    }

    // Optional per-model quota on key
    const kmState = this.ensureKeyModelState(keyCfg.userId, provider.id, keyCfg.keyId, model.id);
    const modelRpmLimit = kmState.learnedRpmLimit ?? model.defaultRpmLimit;
    const modelRpdLimit = kmState.learnedRpdLimit ?? model.defaultRpdLimit;
    if (modelRpmLimit !== undefined) {
      const mUsedRpm = sumWindow(kmState.rpmEntries, ONE_MINUTE_MS, now);
      if (mUsedRpm + 1 > modelRpmLimit) {
        reasons.push(`model_rpm_quota_exhausted:${mUsedRpm}/${modelRpmLimit}`);
      }
    }
    if (modelRpdLimit !== undefined) {
      const mUsedRpd = sumWindow(kmState.rpdEntries, ONE_DAY_MS, now);
      if (mUsedRpd + 1 > modelRpdLimit) {
        reasons.push(`model_rpd_quota_exhausted:${mUsedRpd}/${modelRpdLimit}`);
      }
    }

    if (reasons.length > 0) {
      return {
        providerId: provider.id,
        modelId: model.id,
        keyId: keyCfg.keyId,
        isPaid,
        eligible: false,
        score: -Infinity,
        estimatedCostUsd,
        rejectionReasons: reasons,
      };
    }

    // 4. Composite scoring for eligible candidates
    const health = this.decayedHealth(this.ensureModelHealthState(keyCfg.userId, provider.id, model.id), now);
    const priorityScore = this.computePriorityScore(
      request.priorityOrder ?? policy.priorityOrder,
      provider.id,
      model.id,
    );
    const agentLoopBonus = request.isAgentLoop && model.goodAtLongAgentLoops ? 12 : 0;

    const headroomRatios: number[] = [1];
    if (effectiveRpmLimit !== undefined) {
      headroomRatios.push(Math.max(0, (effectiveRpmLimit - usedRpm) / effectiveRpmLimit));
    }
    if (effectiveTpmLimit !== undefined) {
      headroomRatios.push(Math.max(0, (effectiveTpmLimit - usedTpm) / effectiveTpmLimit));
    }
    if (effectiveRpdLimit !== undefined) {
      headroomRatios.push(Math.max(0, (effectiveRpdLimit - usedRpd) / effectiveRpdLimit));
    }
    const quotaHeadroomBonus = Number((8 * Math.min(...headroomRatios)).toFixed(3));

    const healthFactor = this.computeHealthFactor(health);
    const healthAdjustment = Number((50 * (healthFactor - 0.9)).toFixed(3));

    // Quality penalty for the request's prompt-length class: up to 80 for long
    // prompts (the design's main failure mode), up to 40 for short ones.
    const longPromptGarblePenalty = isLongPrompt
      ? Number((80 * (1 - health.longPromptQualityScore)).toFixed(3))
      : Number((40 * (1 - health.shortPromptQualityScore)).toFixed(3));

    const runBudget = policy.perRunBudgetUsd;
    const paidCostPenalty =
      isPaid && runBudget !== null && runBudget > 0
        ? Number(Math.min(15, (estimatedCostUsd / runBudget) * 15).toFixed(3))
        : 0;

    const score = Number(
      (
        priorityScore +
        agentLoopBonus +
        quotaHeadroomBonus +
        healthAdjustment -
        longPromptGarblePenalty -
        paidCostPenalty
      ).toFixed(4),
    );

    return {
      providerId: provider.id,
      modelId: model.id,
      keyId: keyCfg.keyId,
      isPaid,
      eligible: true,
      score,
      estimatedCostUsd,
      rejectionReasons: [],
      breakdown: {
        priorityScore,
        agentLoopBonus,
        quotaHeadroomBonus,
        healthAdjustment,
        longPromptGarblePenalty,
        paidCostPenalty,
        stickyApplied: false,
      },
    };
  }

  private computePriorityScore(priorityOrder: string[], providerId: string, modelId: string): number {
    const exactKey = `${providerId}:${modelId}`;
    let idx = priorityOrder.indexOf(exactKey);
    if (idx === -1) {
      idx = priorityOrder.indexOf(providerId);
    }
    if (idx === -1) return 10;
    return Math.max(10, 100 - idx * 5);
  }

  private computeHealthFactor(health: ModelHealthState): number {
    const errorComponent = Math.max(0, 1 - health.ewmaErrorRate);
    const ttftComponent = Math.max(0, Math.min(1, 1 - health.ewmaTtftMs / 8_000));
    const latencyComponent = Math.max(0, Math.min(1, 1 - health.ewmaLatencyMs / 45_000));
    return 0.5 * errorComponent + 0.3 * ttftComponent + 0.2 * latencyComponent;
  }

  /**
   * Health as of `now`: while a model sits unused its error rate and
   * latencies decay back to the healthy priors and demoted quality scores
   * recover toward 1, so one bad minute does not exile a provider forever
   * (it would otherwise never be picked again to prove it recovered).
   */
  private decayedHealth(health: ModelHealthState, now: number): ModelHealthState {
    const idle = now - health.lastUpdatedAt;
    if (idle <= 0) return health;
    return {
      ...health,
      ewmaErrorRate: decayToward(health.ewmaErrorRate, 0, idle, this.healthHalfLifeMs),
      ewmaLatencyMs: decayToward(health.ewmaLatencyMs, PRIOR_LATENCY_MS, idle, this.healthHalfLifeMs),
      ewmaTtftMs: decayToward(health.ewmaTtftMs, PRIOR_TTFT_MS, idle, this.healthHalfLifeMs),
      shortPromptQualityScore: decayToward(health.shortPromptQualityScore, 1, idle, this.qualityHalfLifeMs),
      longPromptQualityScore: decayToward(health.longPromptQualityScore, 1, idle, this.qualityHalfLifeMs),
      lastUpdatedAt: now,
    };
  }

  private updateHealthMetrics(
    health: ModelHealthState,
    outcome: ExecutionOutcome,
    succeeded: boolean,
    completionTokens: number,
    now: number,
  ): void {
    const alpha = this.ewmaAlpha;

    // Detect slow streams and treat them as elevated effective latency
    let effectiveLatency = outcome.latencyMs;
    if (
      succeeded &&
      completionTokens >= 50 &&
      outcome.latencyMs > 0 &&
      completionTokens / (outcome.latencyMs / 1000) < this.minTokensPerSec
    ) {
      effectiveLatency = Math.max(effectiveLatency, 25_000);
    }

    const effectiveTtft =
      outcome.ttftMs ?? (succeeded ? Math.min(outcome.latencyMs, 1_500) : this.slowTtftThresholdMs * 1.5);

    const errorSample = succeeded ? 0 : 1;

    // Always blend from the current value (which starts at the healthy prior):
    // replacing it with the first sample would make a single early failure
    // read as a 100% error rate.
    health.ewmaLatencyMs = alpha * effectiveLatency + (1 - alpha) * health.ewmaLatencyMs;
    health.ewmaTtftMs = alpha * effectiveTtft + (1 - alpha) * health.ewmaTtftMs;
    health.ewmaErrorRate = alpha * errorSample + (1 - alpha) * health.ewmaErrorRate;

    health.totalRequests += 1;
    health.lastUpdatedAt = now;
  }

  private computeBackoffWithJitter(consecutiveFailures: number): number {
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, Math.max(0, consecutiveFailures - 1)));
    const jitterMultiplier = 0.8 + 0.4 * this.clock.random();
    return Math.round(exp * jitterMultiplier);
  }

  private estimateCostUsd(model: ModelConfig, promptTokens: number, outputTokens: number): number {
    const cost = (promptTokens / 1000) * model.inputCostPer1kUsd + (outputTokens / 1000) * model.outputCostPer1kUsd;
    return Number(cost.toFixed(6));
  }

  private pruneRunSpend(usage: UserUsageState): void {
    const runIds = Object.keys(usage.runSpendUsd);
    const excess = runIds.length - this.maxTrackedRuns;
    // Insertion order: the oldest runs come first.
    for (let i = 0; i < excess; i++) {
      const runId = runIds[i]!;
      delete usage.runSpendUsd[runId];
      delete usage.runBudgetExempt[runId];
    }
  }

  private refreshTimeBasedTransitions(keyState: KeyState, now: number): void {
    if (keyState.status === "cooldown" && now >= keyState.cooldownUntil) {
      keyState.status = "active";
      keyState.cooldownUntil = 0;
    }
    if (keyState.status === "exhausted_credit" && keyState.creditResetAt !== null && now >= keyState.creditResetAt) {
      keyState.status = "active";
      keyState.creditResetAt = null;
      keyState.disabledReason = undefined;
      keyState.consecutiveFailures = 0;
    }
    // Learned limits are observations, not facts: let them expire so a
    // temporary squeeze (or a raised plan) is re-learned instead of sticking.
    if (keyState.learnedLimitsAt !== undefined && now - keyState.learnedLimitsAt >= this.learnedLimitTtlMs) {
      keyState.learnedRpmLimit = undefined;
      keyState.learnedTpmLimit = undefined;
      keyState.learnedRpdLimit = undefined;
      keyState.learnedLimitsAt = undefined;
    }
  }

  private ensureKeyState(keyCfg: ApiKeyConfig): KeyState {
    const id = this.keyStateId(keyCfg.userId, keyCfg.providerId, keyCfg.keyId);
    let state = this.keyStates.get(id);
    if (!state) {
      state = {
        keyId: keyCfg.keyId,
        userId: keyCfg.userId,
        providerId: keyCfg.providerId,
        status: "active",
        cooldownUntil: 0,
        creditResetAt: null,
        consecutiveFailures: 0,
        rpmEntries: [],
        tpmEntries: [],
        rpdEntries: [],
      };
      this.keyStates.set(id, state);
    }
    return state;
  }

  private ensureKeyModelState(userId: string, providerId: string, keyId: string, modelId: string): KeyModelQuotaState {
    const id = `${userId}:${providerId}:${keyId}:${modelId}`;
    let state = this.keyModelStates.get(id);
    if (!state) {
      state = {
        userId,
        providerId,
        keyId,
        modelId,
        rpmEntries: [],
        tpmEntries: [],
        rpdEntries: [],
      };
      this.keyModelStates.set(id, state);
    }
    return state;
  }

  private ensureModelHealthState(userId: string, providerId: string, modelId: string): ModelHealthState {
    const id = `${userId}:${providerId}:${modelId}`;
    let state = this.modelHealthStates.get(id);
    if (!state) {
      state = {
        userId,
        providerId,
        modelId,
        ewmaLatencyMs: PRIOR_LATENCY_MS,
        ewmaTtftMs: PRIOR_TTFT_MS,
        ewmaErrorRate: 0,
        shortPromptQualityScore: 1,
        longPromptQualityScore: 1,
        longPromptGarbleCount: 0,
        totalRequests: 0,
        lastUpdatedAt: this.clock.now(),
      };
      this.modelHealthStates.set(id, state);
    }
    return state;
  }

  private ensureUserUsageState(userId: string): UserUsageState {
    const now = this.clock.now();
    let state = this.userUsageStates.get(userId);
    if (!state) {
      state = {
        userId,
        dailySpendUsd: 0,
        dailyResetAt: nextUtcMidnight(now),
        runSpendUsd: {},
        runBudgetExempt: {},
      };
      this.userUsageStates.set(userId, state);
    } else if (now >= state.dailyResetAt) {
      state.dailySpendUsd = 0;
      state.dailyResetAt = nextUtcMidnight(now);
    }
    return state;
  }

  private keyStateId(userId: string, providerId: string, keyId: string): string {
    return `${userId}:${providerId}:${keyId}`;
  }
}
