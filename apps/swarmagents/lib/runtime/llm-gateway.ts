/**
 * Server-side LLM gateway for Claude Code inside a user's VM.
 *
 * The VM's Claude Code speaks only the Anthropic Messages API and talks to
 * this app at /api/runtime/llm/<runToken>/v1/messages. This module forwards
 * those requests to the run owner's providers:
 *
 *   - anthropic-format providers: raw pass-through (same wire format).
 *   - openai-format providers: translated to /v1/chat/completions
 *     (lib/providers/anthropic-bridge.ts).
 *
 * Routing: each attempt's (provider, model, key) comes from the SwarmRouter
 * (lib/router, wired in lib/runtime/llm-routing.ts): free-first, the user's
 * rank as tiebreaker, per-key quotas/cooldowns (429 Retry-After, 402 credit
 * exhaustion, 401 disabled keys), live health, per-run stickiness for prompt
 * caching, and paid-provider budget caps. Every outcome — including latency,
 * time to first byte and an output-quality check (empty/garbled responses) —
 * is reported back to the router. If the router throws, or
 * SWARM_LLM_ROUTER=off, the plain rank-order key-pool path is used instead
 * (lib/providers/key-pool.ts + cooldown-store.ts). The provider's real key
 * never reaches the VM — the VM only ever holds a per-run HMAC token
 * (lib/runtime/run-token.ts) — and never enters the router or telemetry.
 *
 * Telemetry on the run's bus (no keys, prompts or bodies):
 *   - llm.call        every attempt: provider, model, attempt number, outcome,
 *                     latency, tokens and estimated cost (0 for free
 *                     providers, unknown when no price is known). Carries
 *                     queuedMs (time waiting to be served) and ttftMs (time to
 *                     the first token) for the latency waterfall.
 *   - route.decision  every routing decision: chosen target, score breakdown
 *                     inputs and why each other candidate was rejected.
 *   - route.failover  when a run's sticky provider is left, and why.
 *   - route.demoted   when a response failed the output-quality check.
 *   - run.budget.warning  once per run when its projected cost crosses 80% of
 *                     the per-run budget (perRunBudgetUsd).
 *   - run.budget.paused   when a paid call would push the run over 100% of its
 *                     per-run budget: the request holds until the user answers
 *                     (POST /api/runtime/budget) and the run then either
 *                     continues (cap lifted for the rest of the run) or stops.
 */

import { randomUUID } from "node:crypto";
import { classifyStatus, errorMessage, parseRetryAfter, redact } from "../providers/errors";
import { KeyPool, resolveQuotaCooldownMs } from "../providers/key-pool";
import type { KeyLease } from "../providers/key-pool";
import {
  apiStyleFor,
  authFor,
  authHeadersFor,
  modelForTier,
  perplexityEffortFor,
  reasoningContentFor,
  requestUrl,
} from "../providers/adapters";
import { mergedModelCapabilities } from "../providers/capabilities";
import { isModelTier, type ApiStyle, type ModelTier, type ProviderConfig, type ProviderErrorKind, type TokenUsage } from "../providers/types";
import { CooldownStore, type PersistedCooldown } from "../providers/cooldown-store";
import { routerProviders, userCooldownFilePath } from "../providers/store";
import { readUserSettings, type UserSettings } from "../providers/settings";
import {
  extractRacePrompt,
  raceCompletion,
  raceConfigFromSettings,
  raceMaxTokens,
} from "../providers/race-dispatch";
import { costWasReported, estimateCostUsd } from "../providers/pricing";
import { guardStreamTimeouts, readSseFrames, StreamTimeoutError } from "../providers/stream";
import { telemetryBus, type TelemetryBus } from "../telemetry";
import { getBudgetGate } from "./budget-gate";
import { getRunsDir } from "../telemetry/paths";
import { readRunEvents } from "../telemetry/run-log";
import { aggregateRunCostLatency, BUDGET_WARN_FRACTION } from "../telemetry/cost-latency";
import {
  anthropicErrorBody,
  anthropicToOpenAI,
  BridgeValidationError,
  estimateInputTokens,
  openAIToAnthropicResponse,
  OpenAIStreamTranslator,
  stripAnthropicImages,
  stripUnsignedThinking,
  type AnthropicSseEvent,
  type BridgeOptions,
} from "../providers/anthropic-bridge";
import { compactAnthropicMessages, toolResultTokens, turnCompactionOptionsFor } from "../harness/context/turn-compaction";
import {
  anthropicToGemini,
  anthropicToOllama,
  anthropicToResponses,
  chatChunkWithReportedCost,
  gateAnthropicRequestBody,
  geminiChunkToChunks,
  geminiFinalChunk,
  geminiToOpenAIResponse,
  newGeminiStreamState,
  newOllamaStreamState,
  newResponsesStreamState,
  ollamaLineToChunks,
  ollamaToOpenAIResponse,
  parseReportedCostUsd,
  responsesEventToChunks,
  responsesToOpenAIResponse,
  type OpenAIChunk,
} from "../providers/wire-shims";
import type { ExecutionOutcome, StickyTarget, ToolCallPayload } from "../router";
import {
  candidateId,
  decisionEventData,
  prepareUserRouting,
  rememberStickyTarget,
  sharedRouter,
  stickyTargetFor,
} from "./llm-routing";

export const MAX_LLM_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Read a positive timeout (ms) from the environment, falling back when unset/invalid. */
function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Default per-attempt upstream deadline (FIX-06): a non-streaming attempt's
 * whole fetch + body read, and a streaming attempt's time-to-first-byte.
 * A provider's own `timeoutMs` config wins over this; a caller option wins
 * over both.
 */
export const DEFAULT_LLM_TIMEOUT_MS = envTimeoutMs("SWARM_LLM_TIMEOUT_MS", 120_000);
/** Default max gap between streamed chunks before the attempt is declared stalled. */
export const DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS = envTimeoutMs("SWARM_LLM_STREAM_IDLE_TIMEOUT_MS", 60_000);

/** Statuses/error kinds that mean "try the next provider by rank". */
const FAILOVER_STATUSES = new Set([401, 402, 404, 408, 429]);

function failoverEligible(status: number | undefined, kind?: ProviderErrorKind): boolean {
  if (kind === "network" || kind === "timeout") return true;
  if (status !== undefined) {
    return FAILOVER_STATUSES.has(status) || status >= 500;
  }
  return false;
}

/** Synthetic key id/value for providers that need no credential (Ollama, auth:none). */
export const KEYLESS_API_KEY = "no-key-required";

/** True when a provider can serve requests without a stored key. */
export function providerIsKeyless(
  config: Pick<ProviderConfig, "id" | "kind" | "auth" | "apiStyle">,
): boolean {
  return apiStyleFor(config) === "ollama" || authFor(config).scheme === "none";
}

function providerHeaders(
  config: ProviderConfig,
  apiKey: string,
  stream: boolean,
): Record<string, string> {
  const headers = authHeadersFor(config, apiKey);
  if (stream) {
    headers.accept =
      apiStyleFor(config) === "ollama" ? "application/x-ndjson" : "text/event-stream";
  }
  return headers;
}

function modelsOf(config: ProviderConfig): string[] {
  const models = config.models ?? {};
  return [
    ...[models.fast, models.balanced, models.deep].filter(
      (m): m is string => typeof m === "string" && m.length > 0,
    ),
    ...(config.availableModels ?? []),
  ];
}

export interface LlmCandidate {
  config: ProviderConfig;
  /** The model name this provider should be called with. */
  model: string;
}

/** Options controlling llm candidate ordering. */
export interface LlmOrderOptions {
  /**
   * Put providers marked free (isFree) before paid ones, keeping the user's
   * rank inside each group. Defaults to false (plain rank order).
   */
  preferFree?: boolean;
  /** Optional routing tier intent ("fast" | "balanced" | "deep"). */
  tier?: ModelTier;
}

/**
 * Rank the owner's providers for a request. A provider whose configured model
 * matches the model Claude asked for (the model the env pointed it at) is
 * preferred; otherwise plain rank order applies. Enabled providers only.
 * With `preferFree`, providers marked free are ordered before paid ones while
 * rank stays the ordering key inside each group.
 *
 * When `requestedModel` is a tier alias ("fast" | "balanced" | "deep") or
 * `options.tier` is set, each provider selects `modelForTier(config, tier)`.
 */
export function orderLlmCandidates(
  providers: ProviderConfig[],
  requestedModel?: string,
  options: LlmOrderOptions = {},
): LlmCandidate[] {
  const tier: ModelTier =
    options.tier ?? (requestedModel && isModelTier(requestedModel) ? requestedModel : "balanced");
  const explicitModel =
    requestedModel !== undefined && !isModelTier(requestedModel) ? requestedModel : undefined;
  const enabled = providers.filter((config) => config.enabled !== false);
  const byRank = [...enabled].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  let ordered = byRank;
  if (options.preferFree === true) {
    const free = byRank.filter((config) => config.isFree === true);
    const paid = byRank.filter((config) => config.isFree !== true);
    ordered = [...free, ...paid];
  }
  const preferred = ordered.filter(
    (config) => explicitModel !== undefined && modelsOf(config).includes(explicitModel),
  );
  const rest = ordered.filter((config) => !preferred.includes(config));
  const finalOrder = [...preferred, ...rest];
  return finalOrder.map((config) => {
    const model =
      explicitModel !== undefined && modelsOf(config).includes(explicitModel)
        ? explicitModel
        : modelForTier(config, tier);
    return { config, model };
  });
}

/** One recorded attempt at a provider, for callers and error summaries. */
export interface LlmAttempt {
  provider: string;
  model: string;
  ok: boolean;
  status?: number;
  kind?: ProviderErrorKind;
  error?: string;
  latencyMs: number;
}

export interface LlmFailure {
  status: number;
  body: string;
  attempts: LlmAttempt[];
}

/** Success result of a non-streaming forward. */
export interface LlmCompletion {
  body: unknown;
  usage: TokenUsage;
  attempts: LlmAttempt[];
}

/**
 * The `llm.call` telemetry event emitted per provider attempt on the run's
 * bus. Contains no secrets, prompts or bodies.
 */
export interface LlmCallEvent {
  type: "llm.call";
  data: {
    provider: string;
    model: string;
    /** 1-based attempt index within this proxied request. */
    attempt: number;
    /** "ok" or the failover reason (401/402/404/408/429/5xx/timeout/...). */
    outcome: string;
    status?: number;
    errorKind?: string;
    latencyMs: number;
    /** Present when the response reported usage. */
    inputTokens?: number;
    outputTokens?: number;
    /** 0 for free providers; a number when a price is known; null = unknown. */
    costUsd: number | null;
    /** True when costUsd is the provider-reported amount (usage.cost), not an estimate. */
    costReported?: boolean;
    /**
     * Milliseconds the attempt waited before the provider served it (the
     * queue segment of the waterfall).
     */
    queuedMs?: number;
    /** Milliseconds to the first token; absent when it was not observed. */
    ttftMs?: number;
  };
}

/**
 * Human-readable failover reason for an attempt: the HTTP status string for
 * known statuses, "5xx" for any server error, "timeout" for network/408, and
 * the error kind otherwise.
 */
export function outcomeOf(status: number | undefined, kind?: ProviderErrorKind): string {
  if (status !== undefined) {
    if (status >= 500) return "5xx";
    if (status === 401 || status === 402 || status === 404 || status === 408 || status === 429) {
      return String(status);
    }
    return String(status);
  }
  if (kind === "network" || kind === "timeout") return "timeout";
  return kind ?? "unknown";
}

interface PoolEntry {
  pool: KeyPool;
  config: ProviderConfig;
  /** The provider's model for this request. */
  model: string;
}

/**
 * Fresh key pools for one user's provider set, with persisted cooldown state
 * restored from the user's cooldown file (the same file the router uses, so
 * the two share backoff state). 402 cooldowns use the configured quota
 * window (SWARM_QUOTA_COOLDOWN_MS).
 */
function poolsFor(providers: LlmCandidate[]): PoolEntry[] {
  const entries: PoolEntry[] = [];
  const quotaCooldownMs = resolveQuotaCooldownMs();
  for (const { config, model } of providers) {
    const keys = config.keys ?? [];
    const keyless = providerIsKeyless(config);
    if (keys.length === 0 && !keyless) continue;
    const pool = new KeyPool(config.id, keys.length > 0 ? keys : [KEYLESS_API_KEY], {
      quotaCooldownMs,
    });
    entries.push({ pool, config, model });
  }
  return entries;
}

function restoreCooldowns(owner: string, entries: PoolEntry[]): void {
  try {
    const store = new CooldownStore({ file: userCooldownFilePath(owner) });
    const records = store.load();
    for (const entry of entries) {
      entry.pool.restore(records.filter((r) => r.provider === entry.config.id));
    }
  } catch {
    // A broken cooldown file must never block LLM requests.
  }
}

/** Merge this request's pool state into the user's cooldown file. */
function persistCooldowns(owner: string, entries: PoolEntry[]): void {
  const changed = entries.flatMap((entry) => entry.pool.cooldownStates());
  if (changed.length === 0) return; // nothing to persist: skip the disk write
  try {
    const store = new CooldownStore({ file: userCooldownFilePath(owner) });
    const existing = store.load();
    const merged = new Map<string, PersistedCooldown>();
    for (const record of existing) {
      merged.set(`${record.provider}|${record.keyHash}`, record);
    }
    for (const record of changed) {
      merged.set(`${record.provider}|${record.keyHash}`, record);
    }
    store.save([...merged.values()]);
  } catch {
    // Best effort: losing cooldown persistence must not break a request.
  }
}

class UpstreamError extends Error {
  readonly status: number;
  readonly kind: ProviderErrorKind;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, kind: ProviderErrorKind, retryAfterMs?: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

function settleFailure(lease: KeyLease, err: UpstreamError): void {
  lease.failure({
    status: err.status,
    kind: err.kind,
    retryAfterMs: err.retryAfterMs,
  });
}

/** True for deliberate, already-formatted LlmFailure throws (not upstream errors). */
function isLlmFailure(value: unknown): value is LlmFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LlmFailure).status === "number" &&
    typeof (value as LlmFailure).body === "string" &&
    Array.isArray((value as LlmFailure).attempts)
  );
}

/**
 * Publish one `llm.call` event to the run's bus. `runId`/`bus` are optional
 * so tests and callers without a run keep working; without a runId nothing is
 * emitted. Never logs keys, prompts or bodies.
 */
export function emitLlmCall(
  runId: string | undefined,
  bus: TelemetryBus | undefined,
  data: LlmCallEvent["data"],
): void {
  if (!runId) return;
  const b = bus ?? telemetryBus;
  b.publish(runId, { type: "llm.call", data } satisfies LlmCallEvent);
}

interface LlmRequestContext {
  runId?: string;
  bus?: TelemetryBus;
  owner: string;
  providers?: ProviderConfig[];
  body: unknown;
  requestedModel?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Per-attempt upstream deadline override (see LlmForwardOptions.timeoutMs). */
  timeoutMs?: number;
  /** Streaming idle-gap override (see LlmForwardOptions.streamIdleTimeoutMs). */
  streamIdleTimeoutMs?: number;
}

/** Shared per-request state for both forwarding paths. */
interface LlmRequest {
  owner: string;
  runId?: string;
  bus?: TelemetryBus;
  body: unknown;
  requestedModel?: string;
  now: () => number;
  /** Epoch ms when the request was accepted; the first attempt queues from here. */
  startedAt: number;
  /** Epoch ms when the previous attempt ended; the next attempt queues from here. */
  lastAttemptEnd?: number;
  secrets: string[];
  attempts: LlmAttempt[];
  entries: PoolEntry[];
  settings: UserSettings;
  /** Resolved per-attempt deadline default (provider config timeoutMs wins per attempt). */
  timeoutMs: number;
  /** Resolved streaming idle-gap deadline. */
  streamIdleTimeoutMs: number;
}

function prepareRequest(options: LlmRequestContext): LlmRequest | { error: LlmFailure } {
  const { owner, body, requestedModel } = options;
  const now = options.now ?? Date.now;
  const settings = readUserSettings(owner);
  const candidates = orderLlmCandidates(
    options.providers ?? providerConfigsFor(owner),
    requestedModel,
    { preferFree: settings.preferFreeProviders },
  );
  const entries = poolsFor(candidates);
  if (entries.length === 0) {
    return {
      error: {
        status: 503,
        body: anthropicErrorBody(503, "No LLM providers are configured for this account."),
        attempts: [],
      },
    };
  }
  return {
    owner,
    runId: options.runId,
    bus: options.bus,
    body,
    requestedModel,
    now,
    startedAt: now(),
    secrets: entries.flatMap((entry) => entry.pool.secretValues()),
    attempts: [],
    entries,
    settings,
    timeoutMs:
      options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_LLM_TIMEOUT_MS,
    streamIdleTimeoutMs:
      options.streamIdleTimeoutMs && options.streamIdleTimeoutMs > 0
        ? options.streamIdleTimeoutMs
        : DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS,
  };
}

/** How long the attempt queued and how long to its first token, when known. */
interface AttemptTiming {
  queuedMs?: number;
  ttftMs?: number;
}

function attemptTiming(req: LlmRequest, startedAt: number, ttftMs?: number): AttemptTiming {
  const queuedMs = Math.max(0, startedAt - (req.lastAttemptEnd ?? req.startedAt));
  return { queuedMs, ...(ttftMs !== undefined ? { ttftMs } : {}) };
}

/** Emit the llm.call event for one attempt and record it in the attempts list. */
function recordAttempt(
  req: LlmRequest,
  target: { config: ProviderConfig; model: string },
  attemptIndex: number,
  outcome: "ok" | string,
  latencyMs: number,
  usage?: TokenUsage,
  timing?: AttemptTiming,
): void {
  const { config, model } = target;
  const ok = outcome === "ok";
  const status = !ok && typeof outcome === "string" && /^\d+$/.test(outcome)
    ? Number(outcome)
    : undefined;
  const kind = status !== undefined ? classifyStatus(status) : undefined;
  const attempt: LlmAttempt = {
    provider: config.id,
    model,
    ok,
    ...(status !== undefined ? { status } : {}),
    ...(kind !== undefined ? { kind } : {}),
    latencyMs,
  };
  req.attempts.push(attempt);
  req.lastAttemptEnd = req.now();
  // Costs only attach when the response reported usage; otherwise the event
  // carries an unknown (null) cost.
  const cost = ok && usage !== undefined ? estimateCostUsd(config, model, usage) ?? null : null;
  if (ok && cost !== null && req.runId) getBudgetGate().noteSpend(req.runId, cost);
  emitLlmCall(req.runId, req.bus, {
    provider: config.id,
    model,
    attempt: attemptIndex,
    outcome,
    ...(status !== undefined ? { status } : {}),
    ...(ok && usage !== undefined ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
    latencyMs,
    ...(timing?.queuedMs !== undefined ? { queuedMs: timing.queuedMs } : {}),
    ...(timing?.ttftMs !== undefined ? { ttftMs: timing.ttftMs } : {}),
    costUsd: cost,
    ...(cost !== null && usage !== undefined && costWasReported(config, usage) ? { costReported: true } : {}),
  });
}

/** Record and emit one failed attempt. */
function recordFailure(
  req: LlmRequest,
  handle: AttemptHandle,
  failure: AttemptFailure,
  error?: string,
  timing?: AttemptTiming,
): void {
  req.attempts.push({
    provider: handle.config.id,
    model: handle.model,
    ok: false,
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    kind: failure.kind,
    ...(error !== undefined ? { error } : {}),
    latencyMs: failure.latencyMs,
  });
  req.lastAttemptEnd = req.now();
  emitLlmCall(req.runId, req.bus, {
    provider: handle.config.id,
    model: handle.model,
    attempt: handle.attemptIndex,
    outcome: failure.kind === "invalid_response" && failure.status === undefined
      ? "invalid_response"
      : outcomeOf(failure.status, failure.kind),
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    errorKind: failure.kind,
    latencyMs: failure.latencyMs,
    ...(timing?.queuedMs !== undefined ? { queuedMs: timing.queuedMs } : {}),
    costUsd: null,
  });
}

// ---------------------------------------------------------------------------
// Run budget: warn at 80% of the per-run cap, hold the run at 100% until the
// user answers. The cap comes from the user's settings (perRunBudgetUsd,
// absent/null = uncapped) and only ever applies to paid providers.
// ---------------------------------------------------------------------------

/** The per-run budget cap from the user's settings; null means uncapped. */
function runBudgetCap(settings: UserSettings): number | null {
  const raw = settings.perRunBudgetUsd;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/** Rough cost of the call about to be made, from the request body's token counts. */
function estimatedCallCostUsd(req: LlmRequest): number {
  const target = req.entries[0];
  const inputTokens = estimateInputTokens(req.body);
  const root = isRecordValue(req.body) ? req.body : {};
  const maxTokens =
    typeof root.max_tokens === "number" && Number.isFinite(root.max_tokens) && root.max_tokens > 0
      ? Math.min(Math.floor(root.max_tokens), 128_000)
      : 4_096;
  if (!target) return 0;
  return estimateCostUsd(target.config, target.model, { inputTokens, outputTokens: maxTokens }) ?? 0;
}

/**
 * Seed the gate's ledger from the run's durable log so a server restart does
 * not forget what the run already spent. Once per run per process.
 */
function seedBudgetSpend(req: LlmRequest): void {
  const runId = req.runId;
  if (!runId) return;
  const gate = getBudgetGate();
  if (gate.known(runId)) return;
  try {
    const dir = getRunsDir();
    if (!dir) return;
    const report = aggregateRunCostLatency(runId, readRunEvents(runId, dir));
    const priced = report.calls.filter((c) => c.outcome === "ok" && c.costUsd !== null).length;
    if (report.costUsd > 0) gate.seedSpend(runId, report.costUsd, Math.max(1, priced));
  } catch {
    // Budget accounting must never block a run.
  }
}

/**
 * What the run's budget does to the next call:
 *   - projected spend below the cap: proceed;
 *   - projected spend at or above 80% of the cap: proceed, warn once per run;
 *   - projected spend at or above the cap: hold the request until the owner
 *     answers (POST /api/runtime/budget) — "continue" lifts the cap for the
 *     rest of the run, "stop" ends it with a 402 and a clear message.
 *
 * The check asks the same question the router applies to its paid candidates
 * (spend so far + the cost of this call against the cap), but it happens
 * *before* the router picks a provider. That is what lets the owner decide
 * instead of the run silently losing its last usable paid provider.
 */
async function budgetCheck(
  req: LlmRequest,
): Promise<{ proceed: true } | { proceed: false; failure: LlmFailure }> {
  const cap = runBudgetCap(req.settings);
  if (cap === null || !req.runId) return { proceed: true };
  // Nothing paid configured: the cap cannot be broken, so never hold.
  const hasPaid = req.entries.some((entry) => entry.config.isFree !== true);
  if (!hasPaid) return { proceed: true };
  const runId = req.runId;
  const gate = getBudgetGate();
  seedBudgetSpend(req);
  // The user lifted the cap for this run.
  if (gate.isExempt(runId)) return { proceed: true };

  const spentUsd = gate.spendFor(runId);
  const expectedNextCallUsd = gate.expectedNextCallUsd(runId);
  const projectedUsd =
    spentUsd + Math.max(expectedNextCallUsd, estimatedCallCostUsd(req));

  const fraction = cap > 0 ? projectedUsd / cap : projectedUsd > 0 ? 1 : 0;
  if (fraction >= BUDGET_WARN_FRACTION && !gate.hasWarned(runId)) {
    gate.markWarned(runId);
    publish(req, "run.budget.warning", {
      spentUsd,
      limitUsd: cap,
      projectedUsd,
      expectedNextCallUsd,
      fraction: Number(fraction.toFixed(4)),
    });
  }
  if (projectedUsd < cap) return { proceed: true };

  publish(req, "run.budget.paused", {
    spentUsd,
    limitUsd: cap,
    projectedUsd,
    expectedNextCallUsd,
  });
  const verdict = await gate.hold(runId, req.owner, {
    spentUsd,
    limitUsd: cap,
    projectedUsd,
    expectedNextCallUsd,
  });
  if (verdict === "continue") {
    // Lift the router's per-run cap for this run too, otherwise the router
    // would quietly push the run onto free providers and the user's
    // "continue" would buy nothing.
    try {
      sharedRouter().grantRunBudgetExemption(req.owner, runId);
    } catch {
      // The gateway exemption alone still lets this call through.
    }
    publish(req, "run.budget.resumed", { decision: "continue" });
    return { proceed: true };
  }
  publish(req, "run.budget.resumed", { decision: "stop" });
  return {
    proceed: false,
    failure: {
      status: 402,
      body: anthropicErrorBody(
        402,
        `This run spent $${spentUsd.toFixed(4)} of its $${cap.toFixed(4)} per-run budget (perRunBudgetUsd) and was paused. ` +
          `The owner can raise the budget in Providers → Router, or answer "continue" to keep the run going.`,
      ),
      attempts: req.attempts,
    },
  };
}

// ---------------------------------------------------------------------------
// Attempt sources: who picks the next (provider, model, key) to try.
//
//   routerSource  — the SwarmRouter (lib/router): free-first, quotas,
//                   cooldowns, health, stickiness; emits route.* telemetry.
//   legacySource  — plain rank order over KeyPools (the pre-router path).
//                   Used when SWARM_LLM_ROUTER=off, and as the fallback when
//                   the router throws, so a router bug never blocks a run.
// ---------------------------------------------------------------------------

interface AttemptSuccess {
  latencyMs: number;
  ttftMs?: number;
  usage?: TokenUsage;
  outputText?: string;
  toolCalls?: ToolCallPayload[];
  headers?: Headers;
}

interface AttemptFailure {
  status?: number;
  kind: ProviderErrorKind;
  retryAfterMs?: number;
  headers?: Headers;
  latencyMs: number;
  message?: string;
}

interface AttemptHandle {
  config: ProviderConfig;
  model: string;
  /** Secret. Only used for the upstream request headers. */
  apiKey: string;
  attemptIndex: number;
  /** Provider answered usefully: record it (quotas, health, stickiness). */
  succeed(result: AttemptSuccess): Promise<void>;
  /** Provider fault (401/402/404/408/429/5xx/network/invalid response). */
  fail(failure: AttemptFailure): Promise<void>;
  /** Not the provider's fault (400, client abort, invalid request): settle without a penalty. */
  release(): void;
  /**
   * First token of a streaming attempt reached the client: pin the run's
   * sticky target now, before the stream completes, so a mid-stream death
   * still keeps the run on this provider for prompt-cache reuse.
   */
  confirmFirstToken?(): void;
}

interface AttemptSource {
  next(): Promise<AttemptHandle | null>;
}

/** Make a handle's settle calls idempotent: the first settle wins. */
function settleOnce(handle: AttemptHandle): AttemptHandle {
  let settled = false;
  const guard = <A extends unknown[]>(fn: (...args: A) => unknown) => async (...args: A) => {
    if (settled) return;
    settled = true;
    await fn(...args);
  };
  return {
    ...handle,
    succeed: guard(handle.succeed),
    fail: guard(handle.fail),
    release: () => {
      if (settled) return;
      settled = true;
      handle.release();
    },
  };
}

function legacySource(req: LlmRequest, skipProviders: ReadonlySet<string> = new Set()): AttemptSource {
  restoreCooldowns(req.owner, req.entries);
  let index = 0;
  return {
    async next() {
      while (index < req.entries.length) {
        const entry = req.entries[index++];
        if (skipProviders.has(entry.config.id)) continue;
        const { config, pool } = entry;
        const attemptIndex = req.attempts.length + 1;
        const lease = pool.acquire();
        if (!lease) {
          req.attempts.push({ provider: config.id, model: entry.model, ok: false, kind: "rate_limit", latencyMs: 0 });
          emitLlmCall(req.runId, req.bus, {
            provider: config.id,
            model: entry.model,
            attempt: attemptIndex,
            outcome: "429",
            status: 429,
            errorKind: "rate_limit",
            latencyMs: 0,
            costUsd: null,
          });
          continue;
        }
        return {
          config,
          model: entry.model,
          apiKey: lease.value,
          attemptIndex,
          async succeed(result) {
            lease.success(result.latencyMs);
            persistCooldowns(req.owner, req.entries);
          },
          async fail(failure) {
            settleFailure(lease, new UpstreamError(failure.message ?? "", failure.status ?? 0, failure.kind, failure.retryAfterMs));
            // A 402 means the whole provider is out of quota: cool every key
            // down for the configured window, not just the key that got it.
            if (failure.kind === "quota_exhausted") pool.cooldownAllKeys(resolveQuotaCooldownMs());
            persistCooldowns(req.owner, req.entries);
          },
          release() {
            lease.cancel();
          },
        };
      }
      return null;
    },
  };
}

/** The router is on unless SWARM_LLM_ROUTER is "off"/"0"/"false". */
export function llmRouterEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.SWARM_LLM_ROUTER ?? "").trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false");
}

const RATE_LIMIT_HEADER = /^(retry-after|x-ratelimit-)/i;

/** Only rate-limit headers go to the router (never auth or other headers). */
function rateLimitHeaders(headers: Headers | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (RATE_LIMIT_HEADER.test(name)) out[name.toLowerCase()] = value;
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

function routerErrorType(failure: AttemptFailure): ExecutionOutcome["errorType"] {
  const status = failure.status;
  if (status === 401 || status === 403 || failure.kind === "auth") return "auth";
  if (status === 402 || failure.kind === "quota_exhausted") return "billing";
  if (status === 429 || failure.kind === "rate_limit") return "rate_limit";
  if (status === 408 || failure.kind === "timeout") return "timeout";
  if (failure.kind === "network") return "network";
  return "server_error";
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Request features the router scores on. The prompt excerpt stays in memory only. */
function routeFeatures(body: unknown): {
  estimatedPromptTokens: number;
  maxOutputTokens: number;
  requiresTools: boolean;
  promptSample?: string;
} {
  const root = isRecordValue(body) ? body : {};
  const maxTokens = typeof root.max_tokens === "number" && root.max_tokens > 0 ? Math.floor(root.max_tokens) : 4_096;
  const requiresTools = Array.isArray(root.tools) && root.tools.length > 0;
  let promptSample: string | undefined;
  const messages = Array.isArray(root.messages) ? root.messages : [];
  for (let i = messages.length - 1; i >= 0 && promptSample === undefined; i--) {
    const m = isRecordValue(messages[i]) ? messages[i] as Record<string, unknown> : {};
    if (m.role !== "user") continue;
    if (typeof m.content === "string") promptSample = m.content;
    else if (Array.isArray(m.content)) {
      const text = m.content
        .filter((b): b is Record<string, unknown> => isRecordValue(b) && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      if (text) promptSample = text;
    }
  }
  return {
    estimatedPromptTokens: compactablePromptTokens(body, messages),
    maxOutputTokens: maxTokens,
    requiresTools,
    ...(promptSample !== undefined ? { promptSample: promptSample.slice(0, 2_000) } : {}),
  };
}

function publish(req: LlmRequest, type: string, data: unknown): void {
  if (!req.runId) return;
  (req.bus ?? telemetryBus).publish(req.runId, { type, data });
}

async function routerSource(req: LlmRequest): Promise<AttemptSource> {
  const routing = await prepareUserRouting(
    req.owner,
    req.entries.map(({ config, model }) => ({ config, model })),
    req.settings,
  );
  const requestId = randomUUID();
  const stickyKey = req.runId ? `${req.runId}|${req.requestedModel ?? ""}` : undefined;
  const base = {
    requestId,
    userId: req.owner,
    runId: req.runId ?? `adhoc-${requestId}`,
    turnIndex: 0,
    isAgentLoop: false,
    allowedModels: routing.allowedModels,
    priorityOrder: routing.priorityOrder,
    ...routeFeatures(req.body),
  };
  base.isAgentLoop = base.requiresTools;
  const tried: string[] = [];
  const triedProviders = new Set<string>();
  let lastFailed: StickyTarget | undefined;
  let fallback: AttemptSource | null = null;
  let decisions = 0;

  return {
    async next() {
      if (fallback) return fallback.next();
      try {
        if (decisions > routing.keySlots) return null;
        decisions++;
        const stickyTarget = lastFailed ?? stickyTargetFor(stickyKey);
        const lease = await routing.router.routeAndAcquire({
          ...base,
          ...(stickyTarget ? { stickyTarget } : {}),
          excludeTargets: [...tried],
        });
        const decision = lease.decision;
        const attemptIndex = req.attempts.length + 1;
        publish(req, "route.decision", decisionEventData(decision, attemptIndex));
        const chosen = decision.chosen;
        if (chosen && stickyTarget && decision.failoverReason) {
          publish(req, "route.failover", {
            requestId,
            from: { provider: stickyTarget.providerId, model: stickyTarget.modelId },
            to: { provider: chosen.providerId, model: chosen.modelId },
            reason: decision.failoverReason,
          });
        }
        if (!chosen) return null;
        const resolved = routing.resolve(chosen.providerId, chosen.keyId);
        if (!resolved) {
          lease.release();
          throw new Error(`router chose an unknown target ${chosen.providerId}`);
        }
        const target: StickyTarget = { providerId: chosen.providerId, modelId: chosen.modelId, keyId: chosen.keyId };
        tried.push(candidateId(chosen.providerId, chosen.modelId, chosen.keyId));
        triedProviders.add(chosen.providerId);
        const report = async (outcome: ExecutionOutcome): Promise<ExecutionOutcome> => {
          try {
            return await lease.reportOutcome(outcome);
          } catch {
            lease.release();
            return outcome;
          }
        };
        return {
          config: resolved.config,
          model: chosen.modelId,
          apiKey: resolved.apiKey,
          attemptIndex,
          async succeed(result) {
            const effective = await report({
              ok: true,
              httpStatus: 200,
              latencyMs: result.latencyMs,
              ...(result.ttftMs !== undefined ? { ttftMs: result.ttftMs } : {}),
              ...(result.usage && result.usage.inputTokens > 0 ? { promptTokensActual: result.usage.inputTokens } : {}),
              ...(result.usage ? { completionTokensActual: result.usage.outputTokens } : {}),
              outputText: result.outputText ?? "",
              ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
              ...(rateLimitHeaders(result.headers) ? { headers: rateLimitHeaders(result.headers) } : {}),
            });
            rememberStickyTarget(stickyKey, target);
            if (effective.errorType === "garbled_output") {
              // The response already went to the agent; the demotion steers
              // the run's next calls away from this model.
              publish(req, "route.demoted", {
                requestId,
                provider: chosen.providerId,
                model: chosen.modelId,
                isLongPrompt: base.estimatedPromptTokens >= 16_000,
                reason: (effective.errorMessage ?? "garbled output").slice(0, 200),
              });
            }
          },
          async fail(failure) {
            await report({
              ok: false,
              ...(failure.status !== undefined ? { httpStatus: failure.status } : {}),
              errorType: routerErrorType(failure),
              ...(failure.message ? { errorMessage: redact(failure.message, req.secrets).slice(0, 200) } : {}),
              ...(rateLimitHeaders(failure.headers) ? { headers: rateLimitHeaders(failure.headers) } : {}),
              latencyMs: failure.latencyMs,
            });
            lastFailed = target;
          },
          confirmFirstToken() {
            // The provider is speaking to the client: pin it for the run even
            // though the attempt has not settled yet. Only reached pre-commit
            // failures leave the sticky target untouched.
            rememberStickyTarget(stickyKey, target);
          },
          release() {
            lease.release();
          },
        };
      } catch (err) {
        console.warn(`[llm-gateway] router error, falling back to rank order: ${redact(errorMessage(err), req.secrets)}`);
        fallback = legacySource(req, triedProviders);
        return fallback.next();
      }
    },
  };
}

async function attemptSource(req: LlmRequest): Promise<AttemptSource> {
  if (!llmRouterEnabled()) return legacySource(req);
  try {
    return await routerSource(req);
  } catch (err) {
    console.warn(`[llm-gateway] router unavailable, using rank order: ${redact(errorMessage(err), req.secrets)}`);
    return legacySource(req);
  }
}

/** Text and tool calls of an Anthropic-shaped message, for the router's output-quality check. */
function contentOf(body: unknown): { text: string; toolCalls: ToolCallPayload[] } {
  const root = isRecordValue(body) ? body : {};
  const blocks = Array.isArray(root.content) ? root.content : [];
  let text = "";
  const toolCalls: ToolCallPayload[] = [];
  for (const raw of blocks) {
    if (!isRecordValue(raw)) continue;
    if (raw.type === "text" && typeof raw.text === "string") text += raw.text;
    else if (raw.type === "thinking" && typeof raw.thinking === "string" && text === "") text += raw.thinking;
    else if (raw.type === "tool_use") {
      toolCalls.push({
        name: typeof raw.name === "string" ? raw.name : "",
        arguments: isRecordValue(raw.input) ? raw.input : JSON.stringify(raw.input ?? null),
      });
    }
  }
  return { text, toolCalls };
}

/** OpenAI tool-call argument strings before translation (the bridge maps invalid JSON to {}). */
function openAiToolCalls(json: unknown): ToolCallPayload[] | undefined {
  const root = isRecordValue(json) ? json : {};
  const choice = Array.isArray(root.choices) && isRecordValue(root.choices[0]) ? root.choices[0] : {};
  const message = isRecordValue(choice.message) ? choice.message : {};
  if (!Array.isArray(message.tool_calls)) return undefined;
  return message.tool_calls.map((raw) => {
    const call = isRecordValue(raw) ? raw : {};
    const fn = isRecordValue(call.function) ? call.function : {};
    return {
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
    };
  });
}

const MAX_OBSERVED_TEXT = 64 * 1024;

/**
 * Watches an Anthropic SSE stream on its way to the client (without changing
 * it) and collects what the router needs: time to first byte, usage, the
 * text and tool calls for the output-quality check.
 */
class AnthropicStreamObserver {
  ttftMs?: number;
  inputTokens = 0;
  outputTokens = 0;
  private text = "";
  private thinking = "";
  private readonly tools = new Map<number, { name: string; json: string }>();
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(private readonly startedAt: number, private readonly now: () => number) {}

  markFirstByte(): void {
    if (this.ttftMs === undefined) this.ttftMs = this.now() - this.startedAt;
  }

  pushBytes(bytes: Uint8Array): void {
    this.markFirstByte();
    this.buffer += this.decoder.decode(bytes, { stream: true });
    let cut: number;
    while ((cut = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
      const frame = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) this.pushData(data);
    }
    // A pathological stream without frame breaks must not grow unbounded.
    if (this.buffer.length > 1024 * 1024) this.buffer = "";
  }

  pushData(data: string): void {
    this.markFirstByte();
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecordValue(event)) return;
    if (event.type === "message_start" && isRecordValue(event.message) && isRecordValue(event.message.usage)) {
      const usage = event.message.usage;
      if (typeof usage.input_tokens === "number") this.inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === "number") this.outputTokens = usage.output_tokens;
    } else if (event.type === "message_delta" && isRecordValue(event.usage)) {
      if (typeof event.usage.output_tokens === "number") this.outputTokens = event.usage.output_tokens;
      if (typeof event.usage.input_tokens === "number" && event.usage.input_tokens > 0) {
        this.inputTokens = event.usage.input_tokens;
      }
    } else if (event.type === "content_block_start" && isRecordValue(event.content_block)) {
      const block = event.content_block;
      if (block.type === "tool_use" && typeof event.index === "number") {
        this.tools.set(event.index, { name: typeof block.name === "string" ? block.name : "", json: "" });
      }
    } else if (event.type === "content_block_delta" && isRecordValue(event.delta)) {
      const delta = event.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (this.text.length < MAX_OBSERVED_TEXT) this.text += delta.text;
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        if (this.thinking.length < MAX_OBSERVED_TEXT) this.thinking += delta.thinking;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && typeof event.index === "number") {
        const tool = this.tools.get(event.index);
        if (tool && tool.json.length < MAX_OBSERVED_TEXT) tool.json += delta.partial_json;
      }
    }
  }

  result(): Pick<AttemptSuccess, "ttftMs" | "usage" | "outputText" | "toolCalls"> {
    return {
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
      ...(this.inputTokens > 0 || this.outputTokens > 0
        ? { usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens } }
        : {}),
      outputText: this.text || this.thinking,
      // A tool call with no arguments streams no JSON at all: that is "{}".
      toolCalls: [...this.tools.values()].map((t) => ({ name: t.name, arguments: t.json === "" ? "{}" : t.json })),
    };
  }
}

/** Read an error response body and turn it into an UpstreamError. */
async function upstreamFailure(req: LlmRequest, config: ProviderConfig, upstream: Response): Promise<{ err: UpstreamError; raw: string }> {
  let raw = "";
  try {
    raw = (await upstream.text()).slice(0, MAX_ERROR_BODY_BYTES);
  } catch {
    // The status alone is enough to classify.
  }
  const kind = classifyStatus(upstream.status);
  const retryAfterMs = parseRetryAfter(upstream.headers.get("retry-after"), req.now());
  const err = new UpstreamError(
    `HTTP ${upstream.status} from ${config.id}: ${redact(raw, req.secrets)}`,
    upstream.status,
    kind,
    retryAfterMs,
  );
  return { err, raw };
}

/**
 * Turn compaction (core-07), per attempt: the VM's agent replays its whole
 * session every turn, so oversized tool_result payloads (DOM snapshots, huge
 * logs) eventually overflow smaller BYOK/local models. Compaction is sized
 * to the routed model's context window, only runs once the tool results
 * exceed that budget (requests under it are forwarded byte-identical, so a
 * provider's prompt cache is never broken), and is switched off with
 * SWARM_TURN_COMPACTION=off. Only tool_result text is ever rewritten.
 */
/**
 * Prompt size the router should plan for. Turn compaction will shrink the
 * tool results for whichever model is picked (to 40% of its window), so a
 * long history must not disqualify every candidate on its raw size: count
 * the tool results at most at the smallest (default) compaction budget.
 */
function compactablePromptTokens(body: unknown, messages: unknown[]): number {
  const raw = estimateInputTokens(body);
  const options = turnCompactionOptionsFor(undefined);
  if (!options) return raw;
  const tools = Math.min(raw, toolResultTokens(messages));
  return raw - tools + Math.min(tools, options.maxToolResultTokens ?? tools);
}

function compactForModel(body: Record<string, unknown>, contextWindow: number | undefined): Record<string, unknown> {
  const options = turnCompactionOptionsFor(contextWindow);
  if (!options || !Array.isArray(body.messages)) return body;
  const compacted = compactAnthropicMessages(body.messages, options);
  if (compacted.stats.resultsCompacted === 0) return body;
  console.warn(
    `[llm-gateway] turn compaction: ${compacted.stats.resultsCompacted} tool result(s) compacted, ` +
      `${compacted.stats.tokensBefore} -> ${compacted.stats.tokensAfter} tool-result tokens ` +
      `(budget ${options.maxToolResultTokens})`,
  );
  return { ...body, messages: compacted.messages };
}

/** Translate an Anthropic Messages body into the provider's request shape. */
function providerPayload(
  config: ProviderConfig,
  model: string,
  body: unknown,
): unknown {
  const style: ApiStyle = apiStyleFor(config);
  switch (style) {
    case "anthropic": {
      // Unsigned thinking blocks were synthesized by the bridge from another
      // provider's reasoning; the real Anthropic API rejects them (400).
      const signedOnly = stripUnsignedThinking(body);
      return mergedModelCapabilities(config, model).vision ? signedOnly : stripAnthropicImages(signedOnly);
    }
    case "openai-responses":
      return anthropicToResponses(body, model, bridgeOptionsFor(config, model), perplexityEffortFor(config));
    case "ollama":
      return anthropicToOllama(body, model, bridgeOptionsFor(config, model));
    case "gemini":
      return anthropicToGemini(body, model, bridgeOptionsFor(config, model));
    default:
      return anthropicToOpenAI(body, model, bridgeOptionsFor(config, model));
  }
}

/**
 * Bridge translation limits for a (provider, model): clamp Anthropic
 * max_tokens to the model's known output cap and pass vision capability
 * so non-vision models get text placeholders instead of raw image blocks.
 * `reasoningContent` is set for providers whose wire format preserves
 * reasoning (see reasoningContentFor), so thinking blocks survive multi-turn
 * tool loops there and are stripped everywhere else.
 */
function bridgeOptionsFor(config: ProviderConfig, model: string): BridgeOptions {
  const caps = mergedModelCapabilities(config, model);
  return {
    maxOutputTokens: caps.maxOutputTokens,
    vision: caps.vision,
    reasoningContent: reasoningContentFor(config),
  };
}

/**
 * Tool names the client declared in the Anthropic request body. Used to
 * repair case-mismatched tool calls returned by OpenAI-compatible upstreams
 * (e.g. Ollama lowercases `Read` to `read`), which Claude Code would
 * otherwise fail to match. Returns undefined when the request declares none.
 */
function declaredToolNames(body: unknown): ReadonlySet<string> | undefined {
  const tools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return undefined;
  const names = new Set<string>();
  for (const raw of tools) {
    const name = (raw as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return names.size > 0 ? names : undefined;
}

/** Translate a provider's non-streaming body back to Anthropic Messages. */
function anthropicResponse(
  config: ProviderConfig,
  json: unknown,
  model: string,
  declared?: ReadonlySet<string>,
): unknown {
  switch (apiStyleFor(config)) {
    case "anthropic":
      return json;
    case "openai-responses":
      return openAIToAnthropicResponse(responsesToOpenAIResponse(json, model), model, declared);
    case "ollama":
      return openAIToAnthropicResponse(ollamaToOpenAIResponse(json, model), model, declared);
    case "gemini":
      return openAIToAnthropicResponse(geminiToOpenAIResponse(json, model), model, declared);
    default:
      return openAIToAnthropicResponse(json, model, declared);
  }
}

/** OpenAI chat-shaped tool calls are only available on the openai-chat wire. */
function upstreamOpenAiJson(config: ProviderConfig, json: unknown, model: string): unknown {
  switch (apiStyleFor(config)) {
    case "anthropic":
      return undefined;
    case "openai-responses":
      return responsesToOpenAIResponse(json, model);
    case "ollama":
      return ollamaToOpenAIResponse(json, model);
    case "gemini":
      return geminiToOpenAIResponse(json, model);
    default:
      return json;
  }
}

/** Read newline-delimited JSON (Ollama's native streaming format). */
async function* readJsonLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // Ignore a malformed line rather than killing the stream.
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        // Ignore a truncated final line.
      }
    }
  } finally {
    reader.releaseLock();
  }
}


export interface LlmForwardOptions {
  /** Run owner (for cooldown persistence paths). */
  owner: string;
  /** Ranked provider configs (server-side, include keys). Defaults to the
   *  owner's configured providers via the per-user store. */
  providers?: ProviderConfig[];
  body: unknown;
  requestedModel?: string;
  /** Non-streaming only: put the router-selected model into the request body,
   * even for Anthropic providers whose requests are normally passed through. */
  useRoutedModel?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Per-attempt upstream deadline (FIX-06): the whole fetch + body read for
   * non-streaming; time-to-first-byte for streaming. A provider config's
   * own `timeoutMs` overrides this per attempt. Defaults to
   * SWARM_LLM_TIMEOUT_MS (120s). A timed-out attempt is a failover-eligible
   * provider failure (kind "timeout"), never a hung turn.
   */
  timeoutMs?: number;
  /**
   * Streaming only: max gap between upstream chunks before the attempt is
   * declared stalled. Total stream duration is not capped. Defaults to
   * SWARM_LLM_STREAM_IDLE_TIMEOUT_MS (60s).
   */
  streamIdleTimeoutMs?: number;
  /** Run to which llm.call telemetry events are emitted. */
  runId?: string;
  /** Telemetry bus override (defaults to the global bus). */
  bus?: TelemetryBus;
}

/**
 * One attempt's deadline: an AbortController linked to the caller's signal
 * plus a timer. `timedOut()` distinguishes our deadline from a caller abort,
 * so a timeout surfaces as a failover-eligible provider failure (kind
 * "timeout") while a caller abort stays an abort.
 */
interface AttemptDeadline {
  signal: AbortSignal;
  /** The effective deadline for this attempt, ms. */
  timeoutMs: number;
  timedOut: () => boolean;
  /** Stop the deadline timer (streaming: headers arrived; the stream guard takes over). */
  clearTimer: () => void;
  /** Clear the timer and unlink the caller signal. Idempotent. */
  dispose: () => void;
}

function attemptDeadline(
  req: LlmRequest,
  config: ProviderConfig,
  callerSignal: AbortSignal | undefined,
): AttemptDeadline {
  const timeoutMs =
    config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : req.timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  let disposed = false;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    signal: controller.signal,
    timeoutMs,
    timedOut: () => timedOut,
    clearTimer,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimer();
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function attemptTimeoutError(config: ProviderConfig, timeoutMs: number): UpstreamError {
  return new UpstreamError(
    `Request to ${config.id} timed out after ${timeoutMs}ms.`,
    408,
    "timeout",
  );
}

export async function forwardLlmNonStreaming(options: LlmForwardOptions): Promise<LlmCompletion> {
  const { signal } = options;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (!fetchImpl) {
    throw new UpstreamError("No fetch implementation available.", 503, "server");
  }
  const prepared = prepareRequest(options);
  if ("error" in prepared) throw prepared.error;
  const req = prepared;
  // The prepared body is the one to forward: prepareRequest applies turn
  // compaction (core-07), so the raw options.body must not leak past it.
  const body = req.body;

  // Provider racing (opt-in per user, default off): when the user enabled
  // it and the request is a simple text completion, race the top providers
  // concurrently and take the first valid response. The budget gate runs
  // first (racing multiplies spend, so the same per-run cap applies), and
  // every settled attempt is telemetered and counted. Any racing failure
  // falls through to the sequential path below (fail-open); when racing is
  // off or the request is ineligible (tools/streaming), this block is
  // skipped and behavior is byte-identical to the sequential path.
  const raceCfg = raceConfigFromSettings(req.settings);
  const racePrompt = raceCfg ? extractRacePrompt(body) : null;
  if (raceCfg && racePrompt !== null) {
    const budget = await budgetCheck(req);
    if (!budget.proceed) throw budget.failure;
    try {
      const maxTokens = raceMaxTokens(body);
      const raced = await raceCompletion({
        owner: req.owner,
        prompt: racePrompt,
        candidates: req.entries.map(({ config, model }) => ({ config, model })),
        config: raceCfg,
        allowPaid: req.settings.allowPaidProviders !== false,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        inputTokens: estimateInputTokens(body),
        attemptBase: req.attempts.length + 1,
        signal,
        fetch: fetchImpl,
        now: req.now,
        emit: (data) => emitLlmCall(req.runId, req.bus, data),
        noteSpend: (usd) => {
          if (req.runId) getBudgetGate().noteSpend(req.runId, usd);
        },
      });
      req.attempts.push(...raced.attempts);
      req.lastAttemptEnd = req.now();
      return { body: raced.body, usage: raced.usage, attempts: req.attempts };
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(
        `[llm-gateway] provider race failed, falling back to sequential: ${redact(errorMessage(err), req.secrets)}`,
      );
    }
  }

  const streaming = (body as { stream?: unknown }).stream === true;
  const source = await attemptSource(req);

  for (;;) {
    // Budget gate first: a paid call that would cross the run's per-run cap
    // holds here, before the router picks the provider. The owner answers
    // "continue" (lift the cap for this run) or "stop" (the run ends with a
    // 402 and a clear message).
    const budget = await budgetCheck(req);
    if (!budget.proceed) throw budget.failure;
    const next = await source.next();
    if (!next) break;
    const handle = settleOnce(next);
    const { config } = handle;
    const startedAt = req.now();
    // Per-attempt deadline (FIX-06): bounds connect, headers, and the body
    // read below. A timer fire is a failover-eligible "timeout" failure;
    // a caller abort stays an abort.
    const deadline = attemptDeadline(req, config, signal);
    try {
      const capabilities = mergedModelCapabilities(config, handle.model);
      const gated = compactForModel(gateAnthropicRequestBody(body, capabilities), capabilities.contextWindow);
      if (options.useRoutedModel) gated.model = handle.model;
      let payload: unknown;
      try {
        payload = providerPayload(config, handle.model, gated);
      } catch (err) {
        handle.release(); // the request is invalid, not the provider
        throw err;
      }
      const init: RequestInit = {
        method: "POST",
        headers: providerHeaders(config, handle.apiKey, streaming),
        body: JSON.stringify(payload),
        signal: deadline.signal,
      };
      let upstream: Response;
      try {
        upstream = await fetchImpl(requestUrl(config, handle.model, streaming), init);
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (deadline.timedOut()) throw attemptTimeoutError(config, deadline.timeoutMs);
        throw new UpstreamError(
          `Network error from ${config.id}: ${errorMessage(err)}`,
          0,
          "network",
        );
      }

      if (!upstream.ok) {
        const { err, raw } = await upstreamFailure(req, config, upstream);
        const failure: AttemptFailure = {
          status: upstream.status,
          kind: err.kind,
          retryAfterMs: err.retryAfterMs,
          headers: upstream.headers,
          latencyMs: req.now() - startedAt,
          message: err.message,
        };
        if (!failoverEligible(upstream.status, err.kind)) {
          // 400/413/422…: the request is at fault, so no provider penalty.
          handle.release();
          recordFailure(req, handle, failure, redact(raw, req.secrets).slice(0, 300), attemptTiming(req, startedAt));
          throw { status: err.status, body: anthropicErrorBody(err.status, err.message), attempts: req.attempts } satisfies LlmFailure;
        }
        await handle.fail(failure);
        recordFailure(req, handle, failure, redact(raw, req.secrets).slice(0, 300), attemptTiming(req, startedAt));
        continue;
      }

      if (streaming) {
        // The request asked for streaming but this path never returns a body;
        // the caller uses forwardLlmStreaming for that. Defensive parse.
        const raw = await upstream.text();
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          json = {};
        }
        const latencyMs = req.now() - startedAt;
        await handle.succeed({ latencyMs, ttftMs: latencyMs, headers: upstream.headers, outputText: raw.slice(0, MAX_OBSERVED_TEXT) || " " });
        recordAttempt(req, handle, handle.attemptIndex, "ok", latencyMs, undefined, attemptTiming(req, startedAt, latencyMs));
        return { body: json, usage: withReportedCost(usageOf(json), config, json), attempts: req.attempts };
      }

      let json: unknown;
      try {
        json = await upstream.json();
      } catch {
        // A body read aborted by our deadline is a timeout, not bad JSON.
        if (deadline.timedOut()) throw attemptTimeoutError(config, deadline.timeoutMs);
        const failure: AttemptFailure = { kind: "invalid_response", latencyMs: req.now() - startedAt, message: `Invalid JSON response from ${config.id}.` };
        await handle.fail(failure);
        recordFailure(req, handle, failure, undefined, attemptTiming(req, startedAt));
        continue;
      }

      const translated = anthropicResponse(config, json, handle.model, declaredToolNames(body));
      const usage = withReportedCost(usageOf(translated), config, json);
      const latencyMs = req.now() - startedAt;
      const content = contentOf(translated);
      const openAiJson = upstreamOpenAiJson(config, json, handle.model);
      await handle.succeed({
        latencyMs,
        ttftMs: latencyMs,
        usage,
        outputText: content.text,
        toolCalls: openAiToolCalls(openAiJson) ?? content.toolCalls,
        headers: upstream.headers,
      });
      recordAttempt(req, handle, handle.attemptIndex, "ok", latencyMs, usage, attemptTiming(req, startedAt, latencyMs));
      return { body: translated, usage, attempts: req.attempts };
    } catch (err) {
      if (signal?.aborted) {
        handle.release();
        throw new Error("aborted");
      }
      if (err instanceof BridgeValidationError || isLlmFailure(err)) {
        handle.release();
        throw err;
      }
      const up = deadline.timedOut()
        ? attemptTimeoutError(config, deadline.timeoutMs)
        : err instanceof UpstreamError
          ? err
          : new UpstreamError(`Unexpected error from ${config.id}: ${errorMessage(err)}`, 502, "unknown");
      const failure: AttemptFailure = {
        ...(up.status !== 0 ? { status: up.status } : {}),
        kind: up.kind,
        retryAfterMs: up.retryAfterMs,
        latencyMs: req.now() - startedAt,
        message: up.message,
      };
      await handle.fail(failure);
      recordFailure(req, handle, failure, up.message.slice(0, 300), attemptTiming(req, startedAt));
      continue;
    } finally {
      deadline.dispose();
      // Never leak a router slot: a no-op when the attempt already settled,
      // and the release path when the consumer abandoned the stream.
      handle.release();
    }
  }

  throw {
    status: 502,
    body: anthropicErrorBody(502, "All LLM providers failed. " + summarize(req.attempts)),
    attempts: req.attempts,
  } satisfies LlmFailure;
}

function summarize(attempts: LlmAttempt[]): string {
  const failed = attempts.filter((a) => !a.ok).slice(-4);
  if (failed.length === 0) return "No provider had a usable key.";
  return failed
    .map((a) => `${a.provider}${a.status !== undefined ? ` (${a.status})` : ""}: ${a.kind ?? "failed"}`)
    .join("; ");
}

function usageOf(body: unknown): TokenUsage {
  const root = (body ?? {}) as { usage?: { input_tokens?: number; output_tokens?: number } };
  const usage = root.usage ?? {};
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
  };
}

/**
 * Attach the provider-reported cost from the raw upstream body to gateway
 * usage. The translated Anthropic body has no cost field, so the raw body
 * is the only place it survives; relayed bodies stay byte-identical. Only
 * the OpenAI-wire styles are read: Responses (`usage.cost`, Perplexity) and
 * chat (`usage.cost_in_usd_ticks`, xAI — docs.x.ai/developers/
 * cost-tracking). Anthropic/Ollama/Gemini usages carry no cost field in
 * either documented shape and are untouched.
 */
function withReportedCost(usage: TokenUsage, config: ProviderConfig, rawBody: unknown): TokenUsage {
  const style = apiStyleFor(config);
  if (style !== "openai-responses" && style !== "openai-chat") return usage;
  const cost = parseReportedCostUsd(isRecordValue(rawBody) ? rawBody.usage : undefined);
  return cost !== undefined ? { ...usage, costUsd: cost } : usage;
}

function providerConfigsFor(owner: string): ProviderConfig[] {
  return routerProviders(owner);
}

/**
 * Forward a streaming Anthropic Messages request. Yields the raw bytes to
 * relay to the client (already Anthropic SSE). Provider failover happens only
 * before the first byte is committed — after that the stream is forked to
 * the client, exactly like the router commits to the first speaking provider.
 *
 * Throws LlmFailure when no provider could be committed.
 */
/**
 * Adapt one provider's streaming body to OpenAI chat chunks. Anthropic
 * pass-through is handled by the caller; this covers every translated style.
 */
async function* upstreamChunks(
  config: ProviderConfig,
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<OpenAIChunk, void, void> {
  const style = apiStyleFor(config);

  if (style === "ollama") {
    const state = newOllamaStreamState(config.id);
    for await (const line of readJsonLines(body, signal)) {
      yield* ollamaLineToChunks(line, state);
    }
    return;
  }

  const frames = readSseFrames(body, signal);
  if (style === "openai-responses") {
    const state = newResponsesStreamState(config.id);
    for await (const frame of frames) {
      if (frame.data.trim() === "[DONE]") break;
      let event: unknown;
      try {
        event = JSON.parse(frame.data);
      } catch {
        continue;
      }
      yield* responsesEventToChunks(event, state);
    }
    return;
  }

  if (style === "gemini") {
    const state = newGeminiStreamState(config.id);
    let finishReason: string | undefined;
    let sawChunk = false;
    for await (const frame of frames) {
      if (frame.data.trim() === "[DONE]") break;
      let chunk: unknown;
      try {
        chunk = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (isRecordValue(chunk) && isRecordValue(chunk.error)) {
        const message = typeof chunk.error.message === "string" ? chunk.error.message : "Gemini stream failed.";
        throw new Error(message);
      }
      sawChunk = true;
      const candidates = isRecordValue(chunk) && Array.isArray(chunk.candidates) ? chunk.candidates : [];
      const first = isRecordValue(candidates[0]) ? candidates[0] : {};
      if (typeof first.finishReason === "string") finishReason = first.finishReason;
      yield* geminiChunkToChunks(chunk, state);
    }
    if (sawChunk) yield geminiFinalChunk(finishReason, state);
    return;
  }

  // OpenAI chat completions SSE. Chunks pass through raw except that a
  // provider-reported cost (xAI `usage.cost_in_usd_ticks` on the final
  // usage chunk) is stamped as `cost_usd` for the gateway's accounting
  // tap, exactly as the Responses shim stamps its terminal chunk; the
  // bridge drops unknown usage fields, so relayed SSE is unchanged.
  for await (const frame of frames) {
    if (frame.data.trim() === "[DONE]") break;
    let chunk: unknown;
    try {
      chunk = JSON.parse(frame.data);
    } catch {
      continue;
    }
    yield chatChunkWithReportedCost(chunk);
  }
}

/**
 * Forward a streaming Anthropic Messages request. Yields Anthropic SSE bytes
 * for the client. Failover only happens before the first byte is committed.
 */
export async function* forwardLlmStreaming(options: LlmForwardOptions): AsyncGenerator<Uint8Array, void, void> {
  const { signal } = options;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (!fetchImpl) {
    throw { status: 503, body: anthropicErrorBody(503, "No fetch implementation available."), attempts: [] } satisfies LlmFailure;
  }
  const prepared = prepareRequest(options);
  if ("error" in prepared) throw prepared.error;
  const req = prepared;
  // As in forwardLlmNonStreaming: forward the prepared (compacted) body,
  // never the raw options.body.
  const body = req.body;

  const encoder = new TextEncoder();
  const source = await attemptSource(req);

  for (;;) {
    // Budget gate first: a paid call that would cross the run's per-run cap
    // holds here, before the router picks the provider. The owner answers
    // "continue" (lift the cap for this run) or "stop" (the run ends with a
    // 402 and a clear message).
    const budget = await budgetCheck(req);
    if (!budget.proceed) throw budget.failure;
    const next = await source.next();
    if (!next) break;
    const handle = settleOnce(next);
    const { config } = handle;
    const startedAt = req.now();
    // Per-attempt deadline (FIX-06): bounds connect + headers here; after
    // headers, the stream guard below bounds first-byte and idle gaps.
    const deadline = attemptDeadline(req, config, signal);
    try {
      const style = apiStyleFor(config);
      const capabilities = mergedModelCapabilities(config, handle.model);
      const gated = compactForModel(gateAnthropicRequestBody(body, capabilities), capabilities.contextWindow);
      let payload: unknown;
      try {
        payload = providerPayload(config, handle.model, gated);
      } catch (err) {
        handle.release();
        throw err;
      }
      let upstream: Response;
      try {
        upstream = await fetchImpl(requestUrl(config, handle.model, true), {
          method: "POST",
          headers: providerHeaders(config, handle.apiKey, true),
          body: JSON.stringify(payload),
          signal: deadline.signal,
        });
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        const failure: AttemptFailure = deadline.timedOut()
          ? {
              kind: "timeout",
              latencyMs: req.now() - startedAt,
              message: `Request to ${config.id} timed out after ${deadline.timeoutMs}ms.`,
            }
          : {
              kind: "network",
              latencyMs: req.now() - startedAt,
              message: `Network error from ${config.id}: ${errorMessage(err)}`,
            };
        await handle.fail(failure);
        recordFailure(req, handle, failure, undefined, attemptTiming(req, startedAt));
        continue;
      }

      if (!upstream.ok) {
        const { err, raw } = await upstreamFailure(req, config, upstream);
        const failure: AttemptFailure = {
          status: upstream.status,
          kind: err.kind,
          retryAfterMs: err.retryAfterMs,
          headers: upstream.headers,
          latencyMs: req.now() - startedAt,
          message: err.message,
        };
        if (!failoverEligible(upstream.status, err.kind)) {
          handle.release();
          recordFailure(req, handle, failure, redact(raw, req.secrets).slice(0, 300), attemptTiming(req, startedAt));
          throw { status: err.status, body: anthropicErrorBody(err.status, err.message), attempts: req.attempts } satisfies LlmFailure;
        }
        await handle.fail(failure);
        recordFailure(req, handle, failure, redact(raw, req.secrets).slice(0, 300), attemptTiming(req, startedAt));
        continue;
      }

      // Headers are in: the fetch deadline is done and the stream guard
      // takes over — first byte within the remaining attempt budget, then
      // an idle-gap cap. Total stream duration is never capped (FIX-06).
      deadline.clearTimer();
      if (!upstream.body) {
        throw new UpstreamError(`No response body from ${config.id}.`, 502, "invalid_response");
      }
      const guardedBody = guardStreamTimeouts(upstream.body, {
        firstByteMs: Math.max(1, deadline.timeoutMs - (req.now() - startedAt)),
        idleMs: req.streamIdleTimeoutMs,
      });

      const observer = new AnthropicStreamObserver(startedAt, req.now);
      // Provider-reported cost tapped from translated chunks (see below).
      let reportedStreamCostUsd: number | undefined;
      if (style === "anthropic") {
        // Pass-through: relay the upstream SSE bytes unchanged.
        const reader = guardedBody.getReader();
        let committed = false;
        try {
          // Read the first chunk before announcing the provider: until a
          // byte is committed to the client, a first-byte timeout (or any
          // first-read failure) can still fail over to the next provider.
          const first: Awaited<ReturnType<typeof reader.read>> = await reader.read();
          committed = true;
          // First bytes are in hand and this provider owns the stream: pin
          // the run's sticky target now (see AttemptHandle.confirmFirstToken).
          handle.confirmFirstToken?.();
          // Committed: this provider owns the stream from here on. Announce
          // it as a leading SSE comment so the serving provider (which may
          // differ from the first ranked one after failover) is observable
          // on the wire.
          yield encoder.encode(`: provider=${config.id}\n\n`);
          if (!first.done) {
            observer.pushBytes(first.value);
            yield first.value;
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              observer.pushBytes(value);
              yield value;
            }
          }
        } catch (err) {
          if (signal?.aborted) throw new Error("aborted");
          if (!committed) {
            // First-byte timeout can fail over. Other body errors on a 200
            // response are mid-stream (see OpenAI path above).
            if (err instanceof StreamTimeoutError) {
              throw attemptTimeoutError(config, deadline.timeoutMs);
            }
            yield encoder.encode(`: provider=${config.id}\n\n`);
            const failure: AttemptFailure = {
              kind: "network",
              latencyMs: req.now() - startedAt,
              message: errorMessage(err),
            };
            await handle.fail(failure);
            recordFailure(req, handle, failure);
            const body = anthropicErrorBody(502, `Stream error from ${config.id}: ${errorMessage(err)}`);
            yield encoder.encode(`event: error\ndata: ${body}\n\n`);
            return;
          }
          // Bytes are already committed to the client: report the failure
          // and end with an error event instead of splicing in another
          // provider's stream.
          const failure: AttemptFailure = {
            kind: err instanceof StreamTimeoutError ? "timeout" : "network",
            latencyMs: req.now() - startedAt,
            message: errorMessage(err),
          };
          await handle.fail(failure);
          recordFailure(req, handle, failure);
          const body = anthropicErrorBody(502, `Stream error from ${config.id}: ${errorMessage(err)}`);
          yield encoder.encode(`event: error\ndata: ${body}\n\n`);
          return;
        } finally {
          reader.releaseLock();
        }
      } else {
        const translator = new OpenAIStreamTranslator(declaredToolNames(body));
        const chunks = upstreamChunks(config, guardedBody, deadline.signal);
        // Pull the first chunk before announcing the provider (see above).
        let step: IteratorResult<OpenAIChunk>;
        try {
          step = await chunks.next();
        } catch (err) {
          if (signal?.aborted) throw new Error("aborted");
          // First-byte timeout can still fail over. Any other body error on a
          // 200 response is treated as mid-stream: the upstream already
          // committed, and enqueue-then-error fixtures surface on first read.
          if (err instanceof StreamTimeoutError) {
            throw attemptTimeoutError(config, deadline.timeoutMs);
          }
          yield encoder.encode(`: provider=${config.id}\n\n`);
          const failure: AttemptFailure = {
            kind: "network",
            latencyMs: req.now() - startedAt,
            message: errorMessage(err),
          };
          await handle.fail(failure);
          recordFailure(req, handle, failure);
          const body = anthropicErrorBody(502, `Stream error from ${config.id}: ${errorMessage(err)}`);
          yield encoder.encode(`event: error\ndata: ${body}\n\n`);
          return;
        }
        // Committed (see above): pin the run's sticky target now.
        handle.confirmFirstToken?.();
        yield encoder.encode(`: provider=${config.id}\n\n`);
        try {
          while (true) {
            if (step.done) break;
            const chunk: OpenAIChunk = step.value;
            const chunkCost = chunk.usage?.cost_usd;
            if (typeof chunkCost === "number" && Number.isFinite(chunkCost) && chunkCost >= 0) {
              reportedStreamCostUsd = chunkCost;
            }
            const events = translator.push(chunk);
            for (const event of events) observer.pushData(event.data);
            if (events.length > 0) yield encoder.encode(events.map(sseLine).join(""));
            step = await chunks.next();
          }
          // Close any open content blocks and emit the terminal events.
          const final = translator.finish();
          for (const event of final) observer.pushData(event.data);
          if (final.length > 0) yield encoder.encode(final.map(sseLine).join(""));
        } catch (err) {
          if (signal?.aborted) throw new Error("aborted");
          // Mid-stream upstream failure: emit an Anthropic error event, then
          // stop. We cannot fail over after bytes are committed.
          const failure: AttemptFailure = {
            kind: err instanceof StreamTimeoutError ? "timeout" : "network",
            latencyMs: req.now() - startedAt,
            message: errorMessage(err),
          };
          await handle.fail(failure);
          recordFailure(req, handle, failure);
          const body = anthropicErrorBody(502, `Stream error from ${config.id}: ${errorMessage(err)}`);
          yield encoder.encode(`event: error\ndata: ${body}\n\n`);
          return;
        } finally {
          void chunks.return(undefined).catch(() => {});
        }
      }

      const latencyMs = req.now() - startedAt;
      const observed = observer.result();
      const observedUsage =
        observed.usage && reportedStreamCostUsd !== undefined
          ? { ...observed.usage, costUsd: reportedStreamCostUsd }
          : observed.usage;
      await handle.succeed({
        latencyMs,
        ...observed,
        ...(observedUsage ? { usage: observedUsage } : {}),
        headers: upstream.headers,
      });
      recordAttempt(req, handle, handle.attemptIndex, "ok", latencyMs, observedUsage, attemptTiming(req, startedAt, observed.ttftMs));
      return;
    } catch (err) {
      if (signal?.aborted) {
        handle.release();
        throw new Error("aborted");
      }
      if (err instanceof BridgeValidationError || isLlmFailure(err)) {
        handle.release();
        throw err;
      }
      const up = deadline.timedOut()
        ? attemptTimeoutError(config, deadline.timeoutMs)
        : err instanceof UpstreamError
          ? err
          : new UpstreamError(`Unexpected error from ${config.id}: ${errorMessage(err)}`, 502, "unknown");
      const failure: AttemptFailure = {
        ...(up.status !== 0 ? { status: up.status } : {}),
        kind: up.kind,
        retryAfterMs: up.retryAfterMs,
        latencyMs: req.now() - startedAt,
        message: up.message,
      };
      await handle.fail(failure);
      recordFailure(req, handle, failure, up.message.slice(0, 300), attemptTiming(req, startedAt));
      continue;
    } finally {
      deadline.dispose();
      // Never leak a router slot: a no-op when the attempt already settled,
      // and the release path when the consumer abandoned the stream.
      handle.release();
    }
  }

  throw {
    status: 502,
    body: anthropicErrorBody(502, "All LLM providers failed. " + summarize(req.attempts)),
    attempts: req.attempts,
  } satisfies LlmFailure;
}

function sseLine(event: AnthropicSseEvent): string {
  const out = [];
  if (event.event) out.push(`event: ${event.event}`);
  out.push(`data: ${event.data}`);
  return `${out.join("\n")}\n\n`;
}
