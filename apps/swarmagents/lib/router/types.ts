import { z } from "zod";

export interface Clock {
  now(): number;
  random(): number;
}

export const SystemClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
};

export const ModelConfigSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  supportsTools: z.boolean(),
  goodAtLongAgentLoops: z.boolean().default(false),
  inputCostPer1kUsd: z.number().nonnegative().default(0),
  outputCostPer1kUsd: z.number().nonnegative().default(0),
  /**
   * Explicit free/paid classification. When omitted, a model is free iff both
   * per-1k prices are 0. Set it when the price is unknown (0) but the model is
   * not actually free, so it still counts as paid for free-first and budgets.
   */
  isFree: z.boolean().optional(),
  /** Optional model-level default limits if provider enforces per-model quotas */
  defaultRpmLimit: z.number().int().positive().optional(),
  defaultTpmLimit: z.number().int().positive().optional(),
  defaultRpdLimit: z.number().int().positive().optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
/** Input shape accepted by the router (schema defaults may be omitted). */
export type ModelConfigInput = z.input<typeof ModelConfigSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Whether 402 exhausted credits automatically reset at next UTC midnight (e.g., free daily tiers) */
  resetsDailyUtc: z.boolean().default(true),
  defaultKeyRpmLimit: z.number().int().positive().optional(),
  defaultKeyTpmLimit: z.number().int().positive().optional(),
  defaultKeyRpdLimit: z.number().int().positive().optional(),
  models: z.array(ModelConfigSchema).min(1),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
/** Input shape accepted by the router (schema defaults may be omitted). */
export type ProviderConfigInput = z.input<typeof ProviderConfigSchema>;

export const ApiKeyConfigSchema = z.object({
  keyId: z.string().min(1),
  userId: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  maxConcurrent: z.number().int().positive().default(2),
  rpmLimit: z.number().int().positive().optional(),
  tpmLimit: z.number().int().positive().optional(),
  rpdLimit: z.number().int().positive().optional(),
});

export type ApiKeyConfig = z.infer<typeof ApiKeyConfigSchema>;
/** Input shape accepted by the router (schema defaults may be omitted). */
export type ApiKeyConfigInput = z.input<typeof ApiKeyConfigSchema>;

export const UserRoutingPolicySchema = z.object({
  userId: z.string().min(1),
  /** Ordered list of "providerId" or "providerId:modelId" preferences */
  priorityOrder: z.array(z.string()).default([]),
  allowPaidFallback: z.boolean().default(false),
  /** USD cap per run for paid models. null = uncapped. */
  perRunBudgetUsd: z.number().nonnegative().nullable().default(0),
  /** USD cap per UTC day for paid models. null = uncapped. */
  perDayBudgetUsd: z.number().nonnegative().nullable().default(0),
  /**
   * Free-first partitioning: when any free candidate is eligible, paid ones
   * are discarded. Turn off to rank free and paid together by score.
   */
  freeFirst: z.boolean().default(true),
  maxConcurrentRequests: z.number().int().positive().default(4),
});

export type UserRoutingPolicy = z.infer<typeof UserRoutingPolicySchema>;
/** Input shape accepted by the router (schema defaults may be omitted). */
export type UserRoutingPolicyInput = z.input<typeof UserRoutingPolicySchema>;

export interface StickyTarget {
  providerId: string;
  modelId: string;
  keyId?: string;
}

export interface RouteRequest {
  requestId: string;
  userId: string;
  runId: string;
  turnIndex: number;
  estimatedPromptTokens: number;
  maxOutputTokens: number;
  requiresTools: boolean;
  isAgentLoop?: boolean;
  /** Original prompt excerpt used for script/language consistency checks */
  promptSample?: string;
  stickyTarget?: StickyTarget;
  /**
   * Candidates ("providerId:modelId:keyId") already tried for this request.
   * They are rejected so a retry loop always makes progress.
   */
  excludeTargets?: string[];
  /** Only these "providerId:modelId" pairs are considered (others are skipped silently). */
  allowedModels?: string[];
  /** Per-request priority list; overrides the user policy's priorityOrder. */
  priorityOrder?: string[];
}

export interface ToolCallPayload {
  id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface ExecutionOutcome {
  ok: boolean;
  httpStatus?: number;
  errorType?: "auth" | "billing" | "rate_limit" | "server_error" | "timeout" | "network" | "garbled_output";
  errorMessage?: string;
  headers?: Record<string, string | undefined>;
  latencyMs: number;
  ttftMs?: number;
  promptTokensActual?: number;
  completionTokensActual?: number;
  /** Raw assistant text output for quality inspection on 200 OK */
  outputText?: string;
  /** Raw tool calls for JSON integrity inspection on 200 OK */
  toolCalls?: ToolCallPayload[];
}

export interface CandidateEvaluation {
  providerId: string;
  modelId: string;
  keyId: string;
  isPaid: boolean;
  eligible: boolean;
  score: number;
  estimatedCostUsd: number;
  rejectionReasons: string[];
  breakdown?: {
    priorityScore: number;
    agentLoopBonus: number;
    quotaHeadroomBonus: number;
    healthAdjustment: number;
    longPromptGarblePenalty: number;
    paidCostPenalty: number;
    stickyApplied: boolean;
  };
}

export interface ChosenTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  isPaid: boolean;
  stickyPreserved: boolean;
}

export interface RoutingDecision {
  requestId: string;
  userId: string;
  runId: string;
  timestamp: number;
  chosen: ChosenTarget | null;
  candidatesConsidered: CandidateEvaluation[];
  reasonsRejected: Record<string, string[]>;
  estimatedCost: number;
  failoverReason?: string;
}

export type RouterEvent =
  | {
      type: "route:selected";
      timestamp: number;
      decision: RoutingDecision;
    }
  | {
      type: "route:failover";
      timestamp: number;
      userId: string;
      runId: string;
      requestId: string;
      from: StickyTarget;
      to: ChosenTarget;
      reason: string;
    }
  | {
      type: "key:cooldown";
      timestamp: number;
      userId: string;
      providerId: string;
      keyId: string;
      cooldownUntil: number;
      reason: string;
    }
  | {
      type: "key:disabled";
      timestamp: number;
      userId: string;
      providerId: string;
      keyId: string;
      status: "disabled_auth" | "exhausted_credit";
      resetAt: number | null;
      reason: string;
    }
  | {
      type: "model:demoted";
      timestamp: number;
      userId: string;
      providerId: string;
      modelId: string;
      isLongPrompt: boolean;
      newQualityScore: number;
      reason: string;
    };

export const WindowEntrySchema = z.object({
  ts: z.number(),
  amount: z.number(),
});

export type WindowEntry = z.infer<typeof WindowEntrySchema>;

export const KeyStateSchema = z.object({
  keyId: z.string(),
  userId: z.string(),
  providerId: z.string(),
  status: z.enum(["active", "cooldown", "exhausted_credit", "disabled_auth"]),
  disabledReason: z.string().optional(),
  cooldownUntil: z.number(),
  creditResetAt: z.number().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  rpmEntries: z.array(WindowEntrySchema),
  tpmEntries: z.array(WindowEntrySchema),
  rpdEntries: z.array(WindowEntrySchema),
  learnedRpmLimit: z.number().positive().optional(),
  learnedTpmLimit: z.number().positive().optional(),
  learnedRpdLimit: z.number().positive().optional(),
  /** When the learned limits were last observed; they expire after learnedLimitTtlMs. */
  learnedLimitsAt: z.number().optional(),
});

export type KeyState = z.infer<typeof KeyStateSchema>;

export const KeyModelQuotaStateSchema = z.object({
  userId: z.string(),
  providerId: z.string(),
  keyId: z.string(),
  modelId: z.string(),
  rpmEntries: z.array(WindowEntrySchema),
  tpmEntries: z.array(WindowEntrySchema),
  rpdEntries: z.array(WindowEntrySchema),
  learnedRpmLimit: z.number().positive().optional(),
  learnedTpmLimit: z.number().positive().optional(),
  learnedRpdLimit: z.number().positive().optional(),
});

export type KeyModelQuotaState = z.infer<typeof KeyModelQuotaStateSchema>;

export const ModelHealthStateSchema = z.object({
  userId: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  ewmaLatencyMs: z.number().nonnegative(),
  ewmaTtftMs: z.number().nonnegative(),
  ewmaErrorRate: z.number().min(0).max(1),
  shortPromptQualityScore: z.number().min(0).max(1),
  longPromptQualityScore: z.number().min(0).max(1),
  longPromptGarbleCount: z.number().int().nonnegative(),
  totalRequests: z.number().int().nonnegative(),
  lastUpdatedAt: z.number(),
});

export type ModelHealthState = z.infer<typeof ModelHealthStateSchema>;

export const UserUsageStateSchema = z.object({
  userId: z.string(),
  dailySpendUsd: z.number().nonnegative(),
  dailyResetAt: z.number(),
  runSpendUsd: z.record(z.string(), z.number().nonnegative()),
  /**
   * Runs whose per-run budget cap the user lifted (they answered "continue" at
   * 100% of it). The router then ignores the per-run cap for that run only;
   * the daily cap still applies.
   * Absent in snapshots written before this field existed: read as empty.
   */
  runBudgetExempt: z.record(z.string(), z.literal(true)).default({}),
});

export type UserUsageState = z.infer<typeof UserUsageStateSchema>;

export const RouterSnapshotSchema = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  keys: z.record(z.string(), KeyStateSchema),
  keyModels: z.record(z.string(), KeyModelQuotaStateSchema),
  modelHealth: z.record(z.string(), ModelHealthStateSchema),
  userUsage: z.record(z.string(), UserUsageStateSchema),
});

export type RouterSnapshot = z.infer<typeof RouterSnapshotSchema>;

export interface RouterStore {
  loadSnapshot(): Promise<RouterSnapshot | null>;
  saveSnapshot(snapshot: RouterSnapshot): Promise<void>;
  /**
   * Optional per-user persistence. When both are implemented the router saves
   * and restores one user's slice at a time (restoreUser / persistUser), so a
   * multi-tenant deployment never rewrites every user's state on each call.
   */
  loadUserSnapshot?(userId: string): Promise<RouterSnapshot | null>;
  saveUserSnapshot?(userId: string, snapshot: RouterSnapshot): Promise<void>;
}

export class InMemoryRouterStore implements RouterStore {
  private serialized: string | null = null;

  async loadSnapshot(): Promise<RouterSnapshot | null> {
    if (!this.serialized) return null;
    const raw = JSON.parse(this.serialized);
    return RouterSnapshotSchema.parse(raw);
  }

  async saveSnapshot(snapshot: RouterSnapshot): Promise<void> {
    const validated = RouterSnapshotSchema.parse(snapshot);
    this.serialized = JSON.stringify(validated);
  }

  /** Helper for inspecting raw persisted JSON in tests */
  getRawJson(): string | null {
    return this.serialized;
  }
}

export interface RouterOptions {
  clock?: Clock;
  store?: RouterStore;
  longPromptThresholdTokens?: number;
  ewmaAlpha?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  stickyMinHealthScore?: number;
  stickyMinLongQualityScore?: number;
  slowTtftThresholdMs?: number;
  minTokensPerSec?: number;
  globalMaxConcurrent?: number;
  /**
   * How long a 402'd key stays excluded when the provider sent no reset hint
   * and does not reset daily at UTC midnight. Defaults to 15 minutes (never
   * permanent: the user may have topped up credit meanwhile).
   */
  creditRetryMs?: number;
  /** Learned (header or 429-inferred) quota limits expire after this. Default 1h. */
  learnedLimitTtlMs?: number;
  /** Half-life for error-rate/latency EWMAs decaying back to healthy when idle. Default 10 min. */
  healthHalfLifeMs?: number;
  /** Half-life for demoted quality scores recovering toward 1 when idle. Default 1h. */
  qualityHalfLifeMs?: number;
  /** Max per-run spend entries kept per user (oldest pruned). Default 500. */
  maxTrackedRuns?: number;
}
