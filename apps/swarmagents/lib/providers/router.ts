import {
  buildRequest,
  httpError,
  modelForTier,
  parseResponse,
  resolveModel,
  resolveTier,
} from "./adapters";
import type { ModelRequest } from "./adapters";
import {
  buildClaudeEnv,
  type ClaudeSelection,
  type ClaudeSelectionInput,
} from "./claude-env";
import { CooldownStore } from "./cooldown-store";
import {
  AbortError,
  ProviderError,
  RouterError,
  errorMessage,
  redact,
} from "./errors";
import { KeyPool } from "./key-pool";
import type { KeyLease } from "./key-pool";
import { parseStreamFrame, readSseFrames } from "./stream";
import type { SseFrame, StreamPiece } from "./stream";
import type {
  AttemptInfo,
  CompleteRequest,
  CompletionResult,
  FetchLike,
  ModelTier,
  ProviderConfig,
  ProviderStats,
  RaceMode,
  RouterStats,
  StreamEvent,
  TokenUsage,
} from "./types";
import { MODEL_TIERS } from "./types";

export interface RouterOptions {
  providers: ProviderConfig[];
  /** Injectable fetch implementation. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Environment source for SWARM_KEYS_<PROVIDER>. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injectable clock, primarily for deterministic tests. */
  now?: () => number;
  cooldownBaseMs?: number;
  cooldownMaxMs?: number;
  /** Default number of providers to race. 1 = sequential failover. */
  defaultRace?: number;
  /** Per-request timeout when a provider does not set its own. */
  defaultTimeoutMs?: number;
  /**
   * Streaming only: max gap between provider frames after the first text
   * before the attempt is declared stalled (FIX-06). Total stream duration
   * is not capped. Defaults to SWARM_LLM_STREAM_IDLE_TIMEOUT_MS (60s).
   */
  streamIdleTimeoutMs?: number;
  /**
   * Default race mode (per tier or per call). Defaults to "hedged": the
   * primary starts immediately and a second healthy provider starts only after
   * a hedge delay if no first token has arrived. "simultaneous" starts every
   * racer at once. False disables racing (sequential failover).
   */
  raceMode?: RaceMode | false;
  /**
   * Tiers that opt into racing by default. The router's `raceMode` applies to
   * these tiers when a call does not set `race`, `raceMode` or `hedge`.
   */
  raceTiers?: readonly ModelTier[];
  /**
   * Hedge delay in ms before a second healthy provider starts when no first
   * token has arrived. Defaults to 1500, tunable via SWARM_HEDGE_DELAY_MS.
   */
  hedgeDelayMs?: number;
  /**
   * Persist the cooldown/backoff state of provider keys under SWARM_HOME so a
   * restart does not hammer a rate-limited key again.
   *
   * Off by default: the cooldown state is deployment-wide, so only the
   * long-lived router of a server (see lib/runtime/manager) turns it on.
   * Short-lived routers would otherwise share (and fight over) one file.
   */
  persistCooldowns?: boolean;
  /** Explicit cooldown state file. Defaults to `<SWARM_HOME>/provider_cooldowns.json`. */
  cooldownFile?: string;
}

interface Candidate {
  config: ProviderConfig;
  pool: KeyPool;
  rank: number;
}

interface ProviderBudget {
  dailyBudgetUsd: number;
  inputPricePer1mTokens: number;
  outputPricePer1mTokens: number;
  spentTodayUsd: number;
  lastResetDate: string;
}

interface StreamSession {
  candidate: Candidate;
  model: string;
  keyId: string;
  lease: KeyLease;
  frames: AsyncGenerator<SseFrame, void, void>;
  first: StreamPiece;
  usage: TokenUsage;
  startedAt: number;
  controller: AbortController;
  attempts: AttemptInfo[];
  finishSuccess(latencyMs: number): void;
  finishFailure(err: ProviderError, latencyMs: number): void;
  finishCancel(): void;
}

function linkAbort(
  external: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

function mergeUsage(target: TokenUsage, update: Partial<TokenUsage>): void {
  if (update.inputTokens !== undefined) target.inputTokens = update.inputTokens;
  if (update.outputTokens !== undefined) target.outputTokens = update.outputTokens;
}

function dedupe(keys: string[]): string[] {
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
}

function envKeysName(config: ProviderConfig): string {
  if (config.envKeys) return config.envKeys;
  const suffix = config.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `SWARM_KEYS_${suffix}`;
}

function loadKeys(
  config: ProviderConfig,
  env: Record<string, string | undefined>
): string[] {
  if (config.keys) return dedupe(config.keys);

  let raw = env[envKeysName(config)];
  if (raw === undefined && config.id !== config.kind) {
    raw = env[`SWARM_KEYS_${config.kind.toUpperCase()}`];
  }
  return dedupe((raw ?? "").split(","));
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof AbortError) return true;
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === "AbortError" || name === "TimeoutError";
}

function clampRace(value: number | undefined, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(Math.floor(value), Math.max(1, max)));
}

const DEFAULT_HEDGE_DELAY_MS = 1_500;
const MAX_HEDGE_RACERS = 2;
const DEFAULT_RACE_MODE: RaceMode = "hedged";

function parseHedgeDelay(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Read a positive timeout (ms) from an env value, falling back when unset/invalid. */
function envTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Default per-attempt deadline (FIX-06): whole fetch + body read for
 * non-streaming; time-to-first-text for streaming. Always set — an
 * unbounded attempt lets one hung provider hang the turn forever.
 */
const DEFAULT_ROUTER_TIMEOUT_MS = 120_000;
/** Default max gap between streamed frames before an attempt is declared stalled. */
const DEFAULT_ROUTER_STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Default provider definitions. Keys are populated from SWARM_KEYS_* env vars. */
export function defaultProviderConfigs(): ProviderConfig[] {
  return [
    { id: "anthropic", kind: "anthropic", rank: 0 },
    { id: "openai", kind: "openai", rank: 1 },
    { id: "gemini", kind: "gemini", rank: 2 },
  ];
}

/**
 * Server-only multi-provider LLM router. It accepts Anthropic-shaped messages,
 * ranks providers, rotates keys, fails over on provider errors and can race
 * several providers in parallel.
 */
export class Router {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly defaultRace: number;
  private readonly defaultTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly candidates: Candidate[];
  private readonly secrets: string[];
  private readonly budgets: Map<string, ProviderBudget>;
  private readonly defaultRaceMode: RaceMode | undefined;
  private readonly raceTiers: ReadonlySet<ModelTier>;
  private readonly hedgeDelayMs: number;
  private readonly cooldownStore: CooldownStore | null;

  private totalRequests = 0;
  private succeeded = 0;
  private failed = 0;

  constructor(options: RouterOptions) {
    if (typeof window !== "undefined") {
      throw new Error("lib/providers is server-only and cannot run in a browser");
    }
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new Error("No fetch implementation is available for the provider router");
    }

    this.fetchImpl = fetchImpl;
    this.now = options.now ?? Date.now;
    this.defaultRace = options.defaultRace ?? 1;
    const env = options.env ?? process.env;
    // Deadlines are never infinite by default (FIX-06): option > env > default.
    this.defaultTimeoutMs =
      options.defaultTimeoutMs && options.defaultTimeoutMs > 0
        ? options.defaultTimeoutMs
        : envTimeoutMs(env.SWARM_LLM_TIMEOUT_MS, DEFAULT_ROUTER_TIMEOUT_MS);
    this.streamIdleTimeoutMs =
      options.streamIdleTimeoutMs && options.streamIdleTimeoutMs > 0
        ? options.streamIdleTimeoutMs
        : envTimeoutMs(env.SWARM_LLM_STREAM_IDLE_TIMEOUT_MS, DEFAULT_ROUTER_STREAM_IDLE_TIMEOUT_MS);

    this.defaultRaceMode =
      options.raceMode === false ? undefined : (options.raceMode ?? DEFAULT_RACE_MODE);
    this.raceTiers = new Set(options.raceTiers ?? []);
    const envHedge = parseHedgeDelay(env.SWARM_HEDGE_DELAY_MS);
    this.hedgeDelayMs = options.hedgeDelayMs ?? envHedge ?? DEFAULT_HEDGE_DELAY_MS;

    this.cooldownStore =
      options.persistCooldowns !== true
        ? null
        : new CooldownStore({
            ...(options.cooldownFile !== undefined ? { file: options.cooldownFile } : {}),
            now: this.now,
          });

    this.candidates = options.providers
      .filter((config) => config.enabled !== false)
      .map((config) => {
        const keys = loadKeys(config, env);
        const pool = new KeyPool(config.id, keys, {
          now: this.now,
          ...(options.cooldownBaseMs !== undefined
            ? { cooldownBaseMs: options.cooldownBaseMs }
            : {}),
          ...(options.cooldownMaxMs !== undefined
            ? { cooldownMaxMs: options.cooldownMaxMs }
            : {}),
          onStateChange: () => this.persistCooldownState(),
        });
        return { config, pool, rank: config.rank ?? 0 };
      })
      .sort((a, b) => a.rank - b.rank);

    // Restore the cooldowns a previous process left behind: a key that was
    // rate-limited must stay out of rotation instead of being hammered again.
    if (this.cooldownStore) {
      const records = this.cooldownStore.load();
      for (const candidate of this.candidates) {
        candidate.pool.restore(records.filter((r) => r.provider === candidate.config.id));
      }
    }

    this.secrets = this.candidates.flatMap((candidate) => candidate.pool.secretValues());

    this.budgets = new Map();
    const today = this.currentDate();
    for (const candidate of this.candidates) {
      const { dailyBudgetUsd, inputPricePer1mTokens, outputPricePer1mTokens } = candidate.config;
      if (dailyBudgetUsd !== undefined && dailyBudgetUsd > 0) {
        this.budgets.set(candidate.config.id, {
          dailyBudgetUsd,
          inputPricePer1mTokens: inputPricePer1mTokens ?? 0,
          outputPricePer1mTokens: outputPricePer1mTokens ?? 0,
          spentTodayUsd: 0,
          lastResetDate: today,
        });
      }
    }
  }

  /**
   * Try ranked providers, rotating keys within each, and return the first valid
   * completion. When `race` is greater than 1, that many providers start in
   * parallel and the losers are aborted.
   */
  async complete(request: CompleteRequest): Promise<CompletionResult> {
    this.totalRequests += 1;

    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      this.failed += 1;
      throw new RouterError("messages must contain at least one message.", "invalid_request");
    }

    const usable = this.candidates.filter((candidate) => candidate.pool.size > 0);
    if (usable.length === 0) {
      this.failed += 1;
      throw new RouterError(
        "No LLM providers are configured with API keys.",
        "no_providers"
      );
    }

    if (request.signal?.aborted) {
      this.failed += 1;
      throw new RouterError("Request aborted.", "aborted");
    }

    try {
      const { race, mode, hedge } = this.resolveRace(request, usable.length);
      const result =
        race > 1
          ? mode === "hedged"
            ? await this.runHedgedRace(this.hedgeCandidates(usable), request, hedge)
            : await this.runRace(usable.slice(0, race), request)
          : await this.runSequential(usable, request);
      this.succeeded += 1;
      return result;
    } catch (err) {
      this.failed += 1;
      if (err instanceof RouterError) throw this.sanitiseRouterError(err);
      throw new RouterError(
        this.redact(`Provider routing failed: ${errorMessage(err)}`),
        "all_failed"
      );
    }
  }

  /**
   * Stream a completion as a unified delta stream. Supports Anthropic and
   * OpenAI-compatible SSE wire formats (plus Gemini SSE), racing the first
   * valid token across `race` candidates when requested. Losing candidates are
   * aborted as soon as a winner produces its first token.
   */
  async *stream(request: CompleteRequest): AsyncGenerator<StreamEvent, void, void> {
    this.totalRequests += 1;

    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      this.failed += 1;
      throw new RouterError("messages must contain at least one message.", "invalid_request");
    }

    const usable = this.candidates.filter((candidate) => candidate.pool.size > 0);
    if (usable.length === 0) {
      this.failed += 1;
      throw new RouterError(
        "No LLM providers are configured with API keys.",
        "no_providers"
      );
    }

    if (request.signal?.aborted) {
      this.failed += 1;
      throw new RouterError("Request aborted.", "aborted");
    }

    const attempts: AttemptInfo[] = [];
    let session: StreamSession | undefined;

    try {
      const { race, mode, hedge } = this.resolveRace(request, usable.length);
      session =
        race > 1
          ? mode === "hedged"
            ? await this.openStreamHedgedRace(
                this.hedgeCandidates(usable),
                request,
                attempts,
                hedge
              )
            : await this.openStreamRace(usable.slice(0, race), request, attempts)
          : await this.openStreamSequential(usable, request, attempts);

      const { config } = session.candidate;
      let text = "";
      let model = session.model;
      const usage: TokenUsage = { ...session.usage };

      const apply = (piece: StreamPiece) => {
        if (piece.model) model = piece.model;
        if (piece.usage) mergeUsage(usage, piece.usage);
      };

      apply(session.first);
      if (session.first.text) {
        text += session.first.text;
        yield {
          type: "delta",
          text: session.first.text,
          provider: config.id,
          model,
          keyId: session.keyId,
        };
      }

      while (true) {
        const step = await session.frames.next();
        if (step.done) break;
        const piece = parseStreamFrame(config, step.value);
        apply(piece);
        if (piece.text) {
          text += piece.text;
          yield {
            type: "delta",
            text: piece.text,
            provider: config.id,
            model,
            keyId: session.keyId,
          };
        }
        if (piece.done) break;
      }

      const latencyMs = Math.max(0, this.now() - session.startedAt);
      session.finishSuccess(latencyMs);
      this.recordSpend(config.id, usage);
      this.succeeded += 1;
      yield {
        type: "done",
        text,
        provider: config.id,
        model,
        usage,
        latencyMs,
        keyId: session.keyId,
        attempts,
      };
    } catch (err) {
      this.failed += 1;

      if (!session) {
        if (err instanceof RouterError) throw this.sanitiseRouterError(err);
        if (err instanceof AbortError || request.signal?.aborted) {
          throw new RouterError("Request aborted.", "aborted");
        }
        throw new RouterError(
          this.redact(`Provider streaming failed: ${errorMessage(err)}`),
          "all_failed"
        );
      }

      if (err instanceof AbortError || request.signal?.aborted) {
        session.finishCancel();
        throw new RouterError("Request aborted.", "aborted", attempts);
      }

      const providerError = this.toStreamError(err, session.candidate.config.id);
      const latencyMs = Math.max(0, this.now() - session.startedAt);
      session.finishFailure(providerError, latencyMs);
      throw new RouterError(
        this.redact(`Provider streaming failed: ${providerError.message}`),
        "all_failed",
        attempts
      );
    } finally {
      session?.finishCancel();
    }
  }

  /** Safe snapshot of provider/key health. Never contains raw keys. */
  stats(): RouterStats {
    return {
      totalRequests: this.totalRequests,
      succeeded: this.succeeded,
      failed: this.failed,
      providers: this.candidates.map(
        (candidate): ProviderStats => ({
          id: candidate.config.id,
          kind: candidate.config.kind,
          rank: candidate.rank,
          models: Object.fromEntries(
            MODEL_TIERS.map((tier) => [tier, modelForTier(candidate.config, tier)])
          ) as Record<ModelTier, string>,
          keys: candidate.pool.stats(),
        })
      ),
    };
  }

  /** Returns the key pool for a given provider id, for health-checker integration. */
  keyPool(providerId: string): KeyPool | undefined {
    return this.candidates.find((c) => c.config.id === providerId)?.pool;
  }

  /**
   * Ranked provider configs (server-side only — they include decrypted keys).
   * Used by the LLM translation proxy to forward requests for the same user
   * without re-reading the providers file on every request.
   */
  providerConfigs(): ProviderConfig[] {
    return this.candidates.map((candidate) => candidate.config);
  }

  /** Path of the persisted cooldown state file, when persistence is enabled. */
  get cooldownFile(): string | undefined {
    return this.cooldownStore?.file;
  }

  /**
   * Write the current cooldown/backoff state of every key to disk. Keys are
   * identified by a one-way hash, never by their value. Persisting is best
   * effort: a broken disk must never break a request.
   */
  private persistCooldownState(): void {
    const store = this.cooldownStore;
    if (!store) return;
    try {
      const records = this.candidates.flatMap((candidate) => candidate.pool.cooldownStates());
      store.save(records);
    } catch (err) {
      console.error(
        "[swarm-router] could not persist provider cooldown state:",
        errorMessage(err)
      );
    }
  }

  /** Safe snapshot of per-provider budget state. */
  budgetStats(): Array<{
    id: string;
    dailyBudgetUsd: number;
    spentTodayUsd: number;
    remainingUsd: number;
  }> {
    const today = this.currentDate();
    return Array.from(this.budgets.entries()).map(([id, budget]) => {
      if (budget.lastResetDate !== today) {
        budget.spentTodayUsd = 0;
        budget.lastResetDate = today;
      }
      return {
        id,
        dailyBudgetUsd: budget.dailyBudgetUsd,
        spentTodayUsd: budget.spentTodayUsd,
        remainingUsd: Math.max(0, budget.dailyBudgetUsd - budget.spentTodayUsd),
      };
    });
  }

  private currentDate(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private resetBudgetIfNeeded(budget: ProviderBudget): void {
    const today = this.currentDate();
    if (budget.lastResetDate !== today) {
      budget.spentTodayUsd = 0;
      budget.lastResetDate = today;
    }
  }

  private isBudgetExhausted(providerId: string): boolean {
    const budget = this.budgets.get(providerId);
    if (!budget) return false;
    this.resetBudgetIfNeeded(budget);
    return budget.spentTodayUsd >= budget.dailyBudgetUsd;
  }

  private recordSpend(providerId: string, usage: TokenUsage): void {
    const budget = this.budgets.get(providerId);
    if (!budget) return;
    this.resetBudgetIfNeeded(budget);
    const inputCost = (usage.inputTokens / 1_000_000) * budget.inputPricePer1mTokens;
    const outputCost = (usage.outputTokens / 1_000_000) * budget.outputPricePer1mTokens;
    budget.spentTodayUsd += inputCost + outputCost;
  }

  /**
   * Resolve how this call should race: the participant count (per call, per
   * tier, or the router default), the mode ("simultaneous" vs "hedged"), and
   * the hedge delay (per call, router option, or SWARM_HEDGE_DELAY_MS).
   */
  private resolveRace(
    request: CompleteRequest,
    usableCount: number
  ): { race: number; mode: RaceMode | undefined; hedge: number } {
    const mode =
      request.raceMode ??
      (request.hedge !== undefined && request.hedge !== false
        ? "hedged"
        : this.raceTiers.has(resolveTier(request))
          ? this.defaultRaceMode
          : undefined);

    const want =
      request.race ??
      (mode === "simultaneous"
        ? Math.max(2, this.defaultRace)
        : mode === "hedged"
          ? 2
          : this.defaultRace);
    const race = clampRace(want, usableCount);
    const hedgeRaw = typeof request.hedge === "number" ? request.hedge : this.hedgeDelayMs;
    const hedge =
      Number.isFinite(hedgeRaw) && hedgeRaw > 0
        ? hedgeRaw
        : DEFAULT_HEDGE_DELAY_MS;
    return { race, mode, hedge };
  }

  /**
   * For hedged racing, only healthy providers participate: those with an
   * available key and a non-exhausted budget, in rank order, capped at
   * MAX_HEDGE_RACERS participants. When nothing is healthy, fall back to the
   * top-ranked candidates so callers still get a precise error.
   */
  private hedgeCandidates(candidates: Candidate[]): Candidate[] {
    const healthy = candidates.filter(
      (candidate) =>
        candidate.pool.hasAvailable() &&
        !this.isBudgetExhausted(candidate.config.id)
    );
    if (healthy.length > 0) return healthy.slice(0, MAX_HEDGE_RACERS);
    return candidates.slice(0, MAX_HEDGE_RACERS);
  }

  private async openStreamSequential(
    candidates: Candidate[],
    request: CompleteRequest,
    attempts: AttemptInfo[]
  ): Promise<StreamSession> {
    for (const candidate of candidates) {
      if (request.signal?.aborted) {
        throw new RouterError("Request aborted.", "aborted", attempts);
      }

      const controller = new AbortController();
      const unlink = linkAbort(request.signal, controller);
      try {
        return await this.startStreamCandidate(
          candidate,
          request,
          controller,
          attempts,
          unlink
        );
      } catch (err) {
        if (err instanceof AbortError) {
          unlink();
          throw new RouterError("Request aborted.", "aborted", attempts);
        }
        if (err instanceof RouterError) {
          unlink();
          throw err;
        }
        // Keep failing over to the next ranked provider.
      }
    }

    throw new RouterError(this.aggregate(attempts), "all_failed", attempts);
  }

  private async openStreamRace(
    candidates: Candidate[],
    request: CompleteRequest,
    attempts: AttemptInfo[]
  ): Promise<StreamSession> {
    const external = request.signal;

    return await new Promise<StreamSession>((resolve, reject) => {
      let done = false;
      let pending = candidates.length;
      const handles: { controller: AbortController; session?: StreamSession }[] = [];

      const failAll = (err: RouterError) => {
        if (done) return;
        done = true;
        for (const handle of handles) {
          handle.session?.finishCancel();
          handle.controller.abort();
        }
        reject(this.sanitiseRouterError(err));
      };

      for (const candidate of candidates) {
        const controller = new AbortController();
        const unlink = linkAbort(external, controller);
        const handle: { controller: AbortController; session?: StreamSession } = {
          controller,
        };
        handles.push(handle);

        this.startStreamCandidate(
          candidate,
          request,
          controller,
          attempts,
          unlink
        ).then(
          (session) => {
            handle.session = session;
            if (done) {
              session.finishCancel();
              return;
            }
            done = true;
            for (const other of handles) {
              if (other.controller === controller) continue;
              other.session?.finishCancel();
              other.controller.abort();
            }
            resolve(session);
          },
          (err: unknown) => {
            if (done) return;
            if (external?.aborted) {
              failAll(new RouterError("Request aborted.", "aborted", attempts));
              return;
            }
            if (err instanceof AbortError) {
              // Cancelled before another racer became the winner.
              if (external?.aborted) {
                failAll(new RouterError("Request aborted.", "aborted", attempts));
              }
            }
            pending -= 1;
            if (pending === 0) {
              failAll(new RouterError(this.aggregate(attempts), "all_failed", attempts));
            }
          }
        );
      }
    });
  }

  /**
   * Opt-in hedged race: the primary provider starts immediately and the next
   * healthy provider starts only after `hedgeDelayMs` if no first token has
   * arrived (a hard failure accelerates the hedge). Whichever provider streams
   * first wins and the losers are aborted without being charged as failures.
   */
  private async openStreamHedgedRace(
    candidates: Candidate[],
    request: CompleteRequest,
    attempts: AttemptInfo[],
    hedgeDelayMs: number
  ): Promise<StreamSession> {
    const external = request.signal;

    return await new Promise<StreamSession>((resolve, reject) => {
      let done = false;
      let inFlight = 0;
      let nextIndex = 0;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
      const active = new Map<AbortController, StreamSession | undefined>();

      const clearHedge = () => {
        if (hedgeTimer) {
          clearTimeout(hedgeTimer);
          hedgeTimer = undefined;
        }
      };

      const failAll = (err: RouterError) => {
        if (done) return;
        done = true;
        clearHedge();
        for (const [controller, session] of active) {
          session?.finishCancel();
          controller.abort();
        }
        reject(this.sanitiseRouterError(err));
      };

      const startNext = () => {
        if (done) return;
        if (nextIndex >= candidates.length) {
          if (inFlight === 0) {
            failAll(new RouterError(this.aggregate(attempts), "all_failed", attempts));
          }
          return;
        }
        const candidate = candidates[nextIndex];
        nextIndex += 1;
        inFlight += 1;

        const controller = new AbortController();
        const unlink = linkAbort(external, controller);
        active.set(controller, undefined);

        this.startStreamCandidate(
          candidate,
          request,
          controller,
          attempts,
          unlink
        ).then(
          (session) => {
            active.set(controller, session);
            if (done) {
              session.finishCancel();
              return;
            }
            done = true;
            clearHedge();
            for (const [otherController, otherSession] of active) {
              if (otherController === controller) continue;
              otherSession?.finishCancel();
              otherController.abort();
            }
            resolve(session);
          },
          (err: unknown) => {
            active.delete(controller);
            inFlight -= 1;
            if (done) return;
            if (external?.aborted) {
              failAll(new RouterError("Request aborted.", "aborted", attempts));
              return;
            }
            if (err instanceof AbortError) {
              // Cancelled before a winner appeared (e.g. a timeout, or an
              // earlier racer won and aborted us).
              if (inFlight === 0 && nextIndex >= candidates.length) {
                failAll(new RouterError(this.aggregate(attempts), "all_failed", attempts));
              }
              return;
            }
            // A hard failure accelerates the hedge: try the next provider now.
            clearHedge();
            startNext();
          }
        );

        if (nextIndex < candidates.length) {
          clearHedge();
          hedgeTimer = setTimeout(() => startNext(), hedgeDelayMs);
          hedgeTimer.unref?.();
        }
      };

      if (external?.aborted) {
        failAll(new RouterError("Request aborted.", "aborted", attempts));
        return;
      }
      startNext();
    });
  }

  /**
   * Open one provider's streaming response and consume frames until the first
   * valid text token. Returns a committed session whose remaining frames can be
   * read by the caller; all pre-token failures settle the key/attempt here.
   */
  private async startStreamCandidate(
    candidate: Candidate,
    request: CompleteRequest,
    controller: AbortController,
    attempts: AttemptInfo[],
    unlinkExternal: () => void
  ): Promise<StreamSession> {
    const { config, pool } = candidate;
    const model = resolveModel(config, request);

    if (this.isBudgetExhausted(config.id)) {
      unlinkExternal();
      throw new ProviderError(`${config.id} daily budget exhausted.`, {
        provider: config.id,
        kind: "budget_exhausted",
        retryable: false,
      });
    }

    const lease = pool.acquire();

    if (!lease) {
      unlinkExternal();
      throw new ProviderError(`${config.id} has no available API key.`, {
        provider: config.id,
        kind: "rate_limit",
        retryable: true,
      });
    }

    const startedAt = this.now();
    const timeoutMs =
      config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : this.defaultTimeoutMs;
    const signal = controller.signal;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let frames: AsyncGenerator<SseFrame, void, void> | undefined;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timeoutId.unref?.();
    }

    const clearTimer = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    try {
      const { url, init } = buildRequest(
        config,
        lease.value,
        model,
        request,
        signal,
        true
      );

      let response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (err) {
        if (timedOut) {
          throw new ProviderError(`Request to ${config.id} timed out.`, {
            provider: config.id,
            kind: "timeout",
            retryable: true,
          });
        }
        if (signal.aborted) throw new AbortError();
        throw new ProviderError(
          `Network error from ${config.id}: ${this.redact(errorMessage(err))}`,
          { provider: config.id, kind: "network", retryable: true }
        );
      }

      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch {
          // The status code is enough to classify the error.
        }
        if (timedOut) {
          throw new ProviderError(`Request to ${config.id} timed out.`, {
            provider: config.id,
            kind: "timeout",
            retryable: true,
          });
        }
        if (signal.aborted) throw new AbortError();
        throw httpError(config, lease.value, response, body, this.now());
      }

      let bodyStream = response.body;
      if (!bodyStream) {
        const text = await response.text();
        const bytes = new TextEncoder().encode(text);
        bodyStream = new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(bytes);
            streamController.close();
          },
        });
      }

      frames = readSseFrames(bodyStream, signal);

      let first: StreamPiece | undefined;
      let streamModel: string | undefined;
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

      while (true) {
        const step = await frames.next();
        if (step.done) break;
        const piece = parseStreamFrame(config, step.value);
        if (piece.model) streamModel = piece.model;
        if (piece.usage) mergeUsage(usage, piece.usage);
        if (piece.text) {
          first = piece;
          break;
        }
        if (piece.done) break;
      }

      if (!first?.text) {
        throw new ProviderError(
          `Invalid response from ${config.id}: stream contained no text content.`,
          { provider: config.id, kind: "invalid_response", retryable: false }
        );
      }

      clearTimer();

      const resolvedModel = streamModel ?? model;
      // After first text the first-byte deadline is done; the idle guard
      // takes over for the rest of the stream (FIX-06).
      const activeFrames = this.idleGuardedFrames(frames, controller, config.id);
      let settled = false;
      const settle = (): boolean => {
        if (settled) return true;
        settled = true;
        clearTimer();
        unlinkExternal();
        return false;
      };

      const session: StreamSession = {
        candidate,
        model: resolvedModel,
        keyId: lease.id,
        lease,
        frames: activeFrames,
        first,
        usage,
        startedAt,
        controller,
        attempts,
        finishSuccess: (latencyMs: number) => {
          if (settle()) return;
          lease.success(latencyMs);
          attempts.push({
            provider: config.id,
            model: resolvedModel,
            keyId: lease.id,
            ok: true,
            latencyMs,
          });
        },
        finishFailure: (err: ProviderError, latencyMs: number) => {
          if (settle()) return;
          lease.failure({
            status: err.status,
            kind: err.kind,
            retryAfterMs: err.retryAfterMs,
          });
          attempts.push({
            provider: config.id,
            model: resolvedModel,
            keyId: lease.id,
            ok: false,
            status: err.status,
            kind: err.kind,
            error: this.redact(err.message),
            latencyMs,
          });
          controller.abort();
          void activeFrames.return(undefined).catch(() => {});
        },
        finishCancel: () => {
          if (settle()) return;
          lease.cancel();
          controller.abort();
          void activeFrames.return(undefined).catch(() => {});
        },
      };

      return session;
    } catch (err) {
      const aborted = err instanceof AbortError || signal.aborted;
      clearTimer();
      unlinkExternal();
      if (frames) {
        controller.abort();
        void frames.return(undefined).catch(() => {});
      }

      const latencyMs = Math.max(0, this.now() - startedAt);

      if (timedOut) {
        lease.failure({ kind: "timeout" });
        attempts.push({
          provider: config.id,
          model,
          keyId: lease.id,
          ok: false,
          kind: "timeout",
          error: this.redact(`Request to ${config.id} timed out.`),
          latencyMs,
        });
        throw new ProviderError(`Request to ${config.id} timed out.`, {
          provider: config.id,
          kind: "timeout",
          retryable: true,
        });
      }

      if (aborted) {
        lease.cancel();
        throw new AbortError();
      }

      const providerError = this.toStreamError(err, config.id);
      lease.failure({
        status: providerError.status,
        kind: providerError.kind,
        retryAfterMs: providerError.retryAfterMs,
      });
      attempts.push({
        provider: config.id,
        model,
        keyId: lease.id,
        ok: false,
        status: providerError.status,
        kind: providerError.kind,
        error: this.redact(providerError.message),
        latencyMs,
      });
      throw providerError;
    }
  }

  private toStreamError(err: unknown, providerId: string): ProviderError {
    if (err instanceof ProviderError) return this.toProviderError(err, providerId);
    return new ProviderError(
      this.redact(`Stream from ${providerId} failed: ${errorMessage(err)}`),
      { provider: providerId, kind: "network", retryable: true }
    );
  }

  /**
   * Wrap a frame stream with an idle deadline (FIX-06): if no frame arrives
   * within streamIdleTimeoutMs, abort the provider connection and fail the
   * attempt with a "timeout" ProviderError. Total stream duration is not
   * capped — a flowing stream runs as long as it keeps producing frames.
   */
  private async *idleGuardedFrames(
    frames: AsyncGenerator<SseFrame, void, void>,
    controller: AbortController,
    providerId: string
  ): AsyncGenerator<SseFrame, void, void> {
    const idleMs = this.streamIdleTimeoutMs;
    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let step: IteratorResult<SseFrame, void>;
        try {
          step = await Promise.race([
            frames.next(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(
                  new ProviderError(
                    `Stream from ${providerId} stalled for ${idleMs}ms without data.`,
                    { provider: providerId, kind: "timeout", retryable: true }
                  )
                );
              }, idleMs);
              timer.unref?.();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (step.done) return;
        yield step.value;
      }
    } finally {
      void frames.return(undefined).catch(() => {});
    }
  }

  /**
   * Pick the best available provider/key/model for an out-of-band consumer
   * (Claude Code in a user's VM) and build its environment. Returns null when
   * every key is cooling down or none are configured. The lease is settled by
   * the caller after the run via `settle` / `release` so pool rotation and
   * cooldown state stay accurate.
   */
  selectForClaude(request: ModelRequest = {}, skipProviders?: ReadonlySet<string>): ClaudeSelection | null {
    for (const candidate of this.candidates) {
      if (skipProviders?.has(candidate.config.id)) continue;
      if (this.isBudgetExhausted(candidate.config.id)) continue;
      const lease = candidate.pool.acquire();
      if (!lease) continue;

      const model = resolveModel(candidate.config, {
        model: request.model,
        tier: request.tier,
      });
      const input: ClaudeSelectionInput = {
        provider: candidate.config.id,
        kind: candidate.config.kind,
        baseUrl: candidate.config.baseUrl,
        key: lease.value,
        model,
      };
      const startedAt = this.now();
      const env = buildClaudeEnv(input);

      return {
        env,
        secrets: this.secrets.slice(),
        provider: input.provider,
        keyId: lease.id,
        model,
        settle: (outcome) => {
          if (outcome.ok) {
            lease.success(Math.max(0, this.now() - startedAt));
          } else {
            lease.failure({
              kind: outcome.kind ?? "unknown",
              status: outcome.status,
              retryAfterMs: outcome.retryAfterMs,
            });
          }
        },
        release: () => lease.cancel(),
      };
    }
    return null;
  }

  private async runSequential(
    candidates: Candidate[],
    request: CompleteRequest
  ): Promise<CompletionResult> {
    const attempts: AttemptInfo[] = [];

    for (const candidate of candidates) {
      if (request.signal?.aborted) throw new RouterError("Request aborted.", "aborted", attempts);
      try {
        return await this.tryProvider(candidate, request, request.signal, attempts);
      } catch (err) {
        if (err instanceof AbortError || err instanceof RouterError) {
          throw this.sanitiseRouterError(
            err instanceof RouterError ? err : new RouterError("Request aborted.", "aborted", attempts)
          );
        }
        // Keep failing over to the next ranked provider.
      }
    }

    throw new RouterError(this.aggregate(attempts), "all_failed", attempts);
  }

  private async runRace(
    candidates: Candidate[],
    request: CompleteRequest
  ): Promise<CompletionResult> {
    const external = request.signal;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    const attempts: AttemptInfo[] = [];

    return await new Promise<CompletionResult>((resolve, reject) => {
      let done = false;
      let pending = candidates.length;

      const cleanup = () => external?.removeEventListener("abort", onExternalAbort);
      const succeed = (result: CompletionResult) => {
        if (done) return;
        done = true;
        cleanup();
        controller.abort();
        resolve(result);
      };
      const fail = (err: RouterError) => {
        if (done) return;
        done = true;
        cleanup();
        controller.abort();
        reject(this.sanitiseRouterError(err));
      };

      for (const candidate of candidates) {
        this.tryProvider(candidate, request, controller.signal, attempts).then(
          succeed,
          (err: unknown) => {
            if (done) return;
            if (external?.aborted) {
              fail(new RouterError("Request aborted.", "aborted", attempts));
              return;
            }
            if (err instanceof AbortError) {
              // A losing racer was cancelled after a winner appeared.
              if (done) return;
            }
            pending -= 1;
            if (pending === 0) {
              fail(new RouterError(this.aggregate(attempts), "all_failed", attempts));
            }
          }
        );
      }
    });
  }

  /**
   * Opt-in hedged race for non-streaming completions: the primary starts
   * immediately and the next healthy provider starts only after `hedgeDelayMs`
   * if no response has arrived yet (a hard failure accelerates the hedge).
   * Whichever provider resolves first wins and the losers are aborted.
   */
  private async runHedgedRace(
    candidates: Candidate[],
    request: CompleteRequest,
    hedgeDelayMs: number
  ): Promise<CompletionResult> {
    const external = request.signal;
    const attempts: AttemptInfo[] = [];
    const parent = new AbortController();
    const onExternalAbort = () => parent.abort();
    if (external) {
      if (external.aborted) parent.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    return await new Promise<CompletionResult>((resolve, reject) => {
      let done = false;
      let inFlight = 0;
      let nextIndex = 0;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

      const clearHedge = () => {
        if (hedgeTimer) {
          clearTimeout(hedgeTimer);
          hedgeTimer = undefined;
        }
      };

      const cleanup = () => {
        clearHedge();
        external?.removeEventListener("abort", onExternalAbort);
      };

      const failAll = (err: RouterError) => {
        if (done) return;
        done = true;
        cleanup();
        parent.abort();
        reject(this.sanitiseRouterError(err));
      };

      const succeed = (result: CompletionResult) => {
        if (done) return;
        done = true;
        cleanup();
        parent.abort();
        resolve(result);
      };

      const startNext = () => {
        if (done) return;
        if (nextIndex >= candidates.length) {
          if (inFlight === 0) {
            failAll(new RouterError(this.aggregate(attempts), "all_failed", attempts));
          }
          return;
        }
        const candidate = candidates[nextIndex];
        nextIndex += 1;
        inFlight += 1;

        this.tryProvider(candidate, request, parent.signal, attempts).then(
          succeed,
          (err: unknown) => {
            if (done) return;
            inFlight -= 1;
            if (external?.aborted) {
              failAll(new RouterError("Request aborted.", "aborted", attempts));
              return;
            }
            if (err instanceof AbortError) {
              // Cancelled by our own abort after another racer won, or
              // externally.
              if (inFlight === 0 && nextIndex >= candidates.length) {
                failAll(new RouterError(this.aggregate(attempts), "all_failed", attempts));
              }
              return;
            }
            // A hard failure accelerates the hedge: try the next provider now.
            clearHedge();
            startNext();
          }
        );

        if (nextIndex < candidates.length) {
          clearHedge();
          hedgeTimer = setTimeout(() => startNext(), hedgeDelayMs);
          hedgeTimer.unref?.();
        }
      };

      startNext();
    });
  }

  /**
   * Try one provider, rotating through its available keys when a retryable
   * error takes a key out of rotation.
   */
  private async tryProvider(
    candidate: Candidate,
    request: CompleteRequest,
    signal: AbortSignal | undefined,
    attempts: AttemptInfo[]
  ): Promise<CompletionResult> {
    const { config, pool } = candidate;

    if (this.isBudgetExhausted(config.id)) {
      const err = new ProviderError(`${config.id} daily budget exhausted.`, {
        provider: config.id,
        kind: "budget_exhausted",
        retryable: false,
      });
      attempts.push({
        provider: config.id,
        model: resolveModel(config, request),
        ok: false,
        kind: err.kind,
        error: err.message,
        latencyMs: 0,
      });
      throw err;
    }

    const model = resolveModel(config, request);
    const keyAttempts = Math.max(1, pool.size);
    let lastError: ProviderError | undefined;

    for (let index = 0; index < keyAttempts; index += 1) {
      if (signal?.aborted) throw new AbortError();

      const lease = pool.acquire();
      if (!lease) {
        if (lastError) break;
        throw new ProviderError(`${config.id} has no available API key.`, {
          provider: config.id,
          kind: "rate_limit",
          retryable: true,
        });
      }

      const startedAt = this.now();
      try {
        const parsed = await this.callProvider(candidate, model, lease.value, request, signal);
        const latencyMs = Math.max(0, this.now() - startedAt);
        lease.success(latencyMs);
        this.recordSpend(config.id, parsed.usage);
        attempts.push({
          provider: config.id,
          model,
          keyId: lease.id,
          ok: true,
          latencyMs,
        });
        return {
          text: parsed.text,
          provider: config.id,
          model: parsed.model || model,
          usage: parsed.usage,
          latencyMs,
          keyId: lease.id,
          attempts,
        };
      } catch (err) {
        const latencyMs = Math.max(0, this.now() - startedAt);
        if (err instanceof AbortError || signal?.aborted) {
          lease.cancel();
          throw new AbortError();
        }

        const providerError = this.toProviderError(err, config.id);
        lease.failure({
          status: providerError.status,
          kind: providerError.kind,
          retryAfterMs: providerError.retryAfterMs,
        });
        attempts.push({
          provider: config.id,
          model,
          keyId: lease.id,
          ok: false,
          status: providerError.status,
          kind: providerError.kind,
          error: this.redact(providerError.message),
          latencyMs,
        });
        lastError = providerError;

        if (!providerError.retryable) break;
      }
    }

    throw lastError ?? new ProviderError(`${config.id} failed.`, {
      provider: config.id,
      kind: "unknown",
      retryable: false,
    });
  }

  private async callProvider(
    candidate: Candidate,
    model: string,
    apiKey: string,
    request: CompleteRequest,
    signal: AbortSignal | undefined
  ): Promise<ReturnType<typeof parseResponse>> {
    const { config } = candidate;
    const timeoutMs =
      config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : this.defaultTimeoutMs;

    let timeoutController: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let callSignal = signal;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutController = new AbortController();
      if (signal?.aborted) timeoutController.abort();
      else signal?.addEventListener("abort", () => timeoutController?.abort(), { once: true });
      timeoutId = setTimeout(() => {
        timedOut = true;
        timeoutController?.abort();
      }, timeoutMs);
      callSignal = timeoutController.signal;
    }

    const { url, init } = buildRequest(config, apiKey, model, request, callSignal);

    let response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) {
        throw new ProviderError(`Request to ${config.id} timed out after ${timeoutMs}ms.`, {
          provider: config.id,
          kind: "timeout",
          retryable: true,
        });
      }
      if (signal?.aborted || err instanceof AbortError) throw new AbortError();
      throw new ProviderError(
        `Network error from ${config.id}: ${this.redact(errorMessage(err))}`,
        { provider: config.id, kind: "network", retryable: true }
      );
    }

    // The deadline stays armed through the body read (FIX-06): a provider
    // that sends headers and then stalls must not hang the attempt.
    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      if (timedOut) {
        throw new ProviderError(`Request to ${config.id} timed out after ${timeoutMs}ms.`, {
          provider: config.id,
          kind: "timeout",
          retryable: true,
        });
      }
      if (signal?.aborted) throw new AbortError();
      throw new ProviderError(
        `Failed to read response from ${config.id}: ${this.redact(errorMessage(err))}`,
        { provider: config.id, kind: "network", retryable: true }
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw httpError(config, apiKey, response, body, this.now());
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ProviderError(
        `Invalid JSON response from ${config.id}.`,
        { provider: config.id, kind: "invalid_response", retryable: false }
      );
    }

    return parseResponse(config, json, model);
  }

  private toProviderError(err: unknown, providerId: string): ProviderError {
    if (err instanceof ProviderError) {
      return new ProviderError(this.redact(err.message), {
        provider: err.provider || providerId,
        kind: err.kind,
        status: err.status,
        retryable: err.retryable,
        retryAfterMs: err.retryAfterMs,
      });
    }
    return new ProviderError(
      this.redact(`Provider ${providerId} failed: ${errorMessage(err)}`),
      { provider: providerId, kind: "unknown", retryable: false }
    );
  }

  private aggregate(attempts: AttemptInfo[]): string {
    return this.redact(aggregateFailureSummary(attempts));
  }

  private redact(text: string): string {
    return redact(text, this.secrets);
  }

  private sanitiseRouterError(err: RouterError): RouterError {
    return new RouterError(this.redact(err.message), err.code, err.attempts);
  }
}

export { AbortError, ProviderError, RouterError } from "./errors";

/** Convenience factory using the three built-in providers and env keys. */
export function createRouter(options: Partial<RouterOptions> = {}): Router {
  return new Router({
    ...options,
    providers: options.providers ?? defaultProviderConfigs(),
  });
}

/**
 * Human-readable, redacted summary of failed attempts, for callers that want
 * to report provider failover without leaking raw error bodies.
 */
export function aggregateFailureSummary(attempts: readonly AttemptInfo[]): string {
  const failures = attempts.filter((attempt) => !attempt.ok);
  if (failures.length === 0) return "All providers failed.";
  const detail = failures
    .slice(-6)
    .map((attempt) => {
      const status = attempt.status ? ` (${attempt.status})` : "";
      return `${attempt.provider}${status}: ${attempt.error ?? attempt.kind ?? "failed"}`;
    })
    .join("; ");
  return `All providers failed. ${detail}`;
}
