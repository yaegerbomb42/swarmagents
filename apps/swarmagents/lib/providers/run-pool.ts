/**
 * Run-level provider pool: picks the provider, key and model for each attempt
 * of ONE agent run, and decides what to do when an attempt fails.
 *
 * What it adds over Router#selectForClaude + the manager's failover loop:
 *
 *  1. Key rotation before failover. A 429 / 402-quota / 401-403 from one key
 *     benches only that key (KeyPool cooldown) and the next attempt reuses the
 *     SAME provider with its next healthy key. Only when every key of the
 *     provider is cooling does the provider count as exhausted and the run
 *     fail over to the next ranked provider. (The manager loop today marks the
 *     whole provider exhausted on the first failing key, so a user with three
 *     free-tier keys on one host only ever uses the first.)
 *  2. Mid-task model-family switch. switchFamily("gpt") makes every later
 *     attempt pick a provider + model of that family (failover stays inside
 *     it), and the attempt carries the CLI session id so the runner resumes
 *     the same conversation (--resume) on the new model.
 *
 * Keys: the pool never reads keys. It only drives a Router, and the Router a
 * caller passes must be built from the signed-in user's own provider config
 * (see user-run-pool.ts, or RuntimeManager#routerForUser). Events and
 * summaries carry safe key slot labels ("groq:key-2"), never key values, and
 * error text is redacted against every key the router holds.
 */

import { resolveModel } from "./adapters";
import { classifyClaudeRunError } from "./claude-env";
import type { ClaudeSelection } from "./claude-env";
import { redact } from "./errors";
import { modelFamily } from "./model-family";
import type { ModelFamily } from "./model-family";
import type { ModelTier, ProviderConfig, ProviderErrorKind } from "./types";

/** The slice of Router the pool needs (Router satisfies it structurally). */
export interface PoolRouter {
  selectForClaude(
    request?: { model?: string; tier?: ModelTier },
    skipProviders?: ReadonlySet<string>
  ): ClaudeSelection | null;
  keyPool(providerId: string): { hasAvailable(): boolean } | undefined;
  providerConfigs(): ProviderConfig[];
}

export type AttemptReason = "initial" | "key-rotation" | "failover" | "family-switch";

export interface RunAttempt {
  /** 1-based attempt number within the run. */
  readonly n: number;
  readonly selection: ClaudeSelection;
  readonly reason: AttemptReason;
  readonly family: ModelFamily;
  /** CLI session to resume; undefined only for a fresh run's first attempt. */
  readonly resumeSessionId?: string;
}

export interface PoolFailure {
  kind: ProviderErrorKind;
  status?: number;
  retryAfterMs?: number;
}

export type FailureAction = "rotate-key" | "failover" | "fatal";

export interface FailureDecision {
  action: FailureAction;
  kind: ProviderErrorKind;
  status?: number;
  /** Why the run cannot continue (only for "fatal"). */
  reason?: string;
}

export type RunPoolEvent =
  | {
      type: "pool.attempt";
      n: number;
      provider: string;
      keyId: string;
      model: string;
      family: ModelFamily;
      reason: AttemptReason;
      resume: boolean;
    }
  | { type: "pool.rotate"; provider: string; fromKeyId: string; kind: ProviderErrorKind; status?: number }
  | { type: "pool.failover"; provider: string; keyId: string; kind: ProviderErrorKind; status?: number }
  | { type: "pool.family"; from: ModelFamily | null; to: ModelFamily; model?: string; reason?: string }
  | { type: "pool.exhausted"; family: ModelFamily | null; message: string };

export interface RunPoolOptions {
  /** The run's requested model (or tier alias), as Router#selectForClaude takes it. */
  model?: string;
  tier?: ModelTier;
  /** Keep every attempt inside this family from the start. */
  family?: ModelFamily;
  /** Continue an existing CLI conversation from the first attempt. */
  resumeSessionId?: string;
  /** Hard cap on attempts per run (rotations + failovers + switches). Default 12. */
  maxAttempts?: number;
  onEvent?: (event: RunPoolEvent) => void;
}

const KEY_SCOPED: ReadonlySet<ProviderErrorKind> = new Set(["rate_limit", "quota_exhausted", "auth"]);
const PROVIDER_SCOPED: ReadonlySet<ProviderErrorKind> = new Set(["server", "network", "timeout"]);

/**
 * Classify a Claude Code run error into a provider failure, or null when it is
 * not a provider problem (a task error the next key would hit too).
 *
 * Extends classifyClaudeRunError (401 / 429 / 529 / "overloaded") with what
 * free-tier hosts actually send: 402 and "quota"/"insufficient credit"
 * (quota_exhausted), 403 (auth), "rate limit"/"too many requests" without a
 * status, 500/502/503/504 (server) and connection failures (network).
 */
export function classifyPoolError(message: string): { kind: ProviderErrorKind; status?: number } | null {
  const text = String(message ?? "");
  const base = classifyClaudeRunError(text);
  if (base) return base;

  const status = text.match(/(?:^|[^\d.])(402|403|500|502|503|504)(?:[^\d.]|$)/);
  if (status) {
    const code = Number(status[1]);
    if (code === 402) return { kind: "quota_exhausted", status: code };
    if (code === 403) return { kind: "auth", status: code };
    return { kind: "server", status: code };
  }
  if (/insufficient[\s_-]*(?:credit|balance|funds|quota)|quota|billing|exceeded your current/i.test(text)) {
    return { kind: "quota_exhausted" };
  }
  if (/rate[\s_-]*limit|too many requests/i.test(text)) return { kind: "rate_limit" };
  if (/invalid[\s_-]*(?:api[\s_-]*)?key|unauthori[sz]ed|authentication[\s_-]*(?:failed|error)/i.test(text)) {
    return { kind: "auth" };
  }
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed/i.test(text)) {
    return { kind: "network" };
  }
  return null;
}

/** Pick a model of `family` this provider can serve, preferring `preferred`. */
export function familyModelFor(
  config: ProviderConfig,
  family: ModelFamily,
  preferred?: string
): string | undefined {
  const candidates = [
    preferred,
    ...Object.values(config.models ?? {}),
    ...(config.availableModels ?? []),
    resolveModel(config, {}),
  ];
  for (const model of candidates) {
    if (!model) continue;
    if (modelFamily(model) === family) return model;
  }
  return undefined;
}

export class RunProviderPool {
  private readonly router: PoolRouter;
  private readonly model?: string;
  private readonly tier?: ModelTier;
  private readonly maxAttempts: number;
  private readonly onEvent?: (event: RunPoolEvent) => void;

  /** Providers this run must not use again (every key failed, or provider down). */
  private readonly exhausted = new Set<string>();
  private family: ModelFamily | null;
  private familyModel?: string;
  private sessionId?: string;
  private pending: RunAttempt | null = null;
  private nextReason: AttemptReason = "initial";
  private readonly history: RunAttempt[] = [];
  private readonly failures: string[] = [];

  constructor(router: PoolRouter, options: RunPoolOptions = {}) {
    this.router = router;
    this.model = options.model;
    this.tier = options.tier;
    this.family = options.family ?? null;
    this.sessionId = options.resumeSessionId;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 12);
    this.onEvent = options.onEvent;
  }

  /** The family later attempts are pinned to, or null when unpinned. */
  get pinnedFamily(): ModelFamily | null {
    return this.family;
  }

  /** Attempts handed out so far (selection objects included; no key values). */
  get attempts(): readonly RunAttempt[] {
    return this.history;
  }

  /** Remember the CLI session id so later attempts resume the same conversation. */
  recordSession(sessionId: string | undefined): void {
    if (sessionId) this.sessionId = sessionId;
  }

  /**
   * Lease the provider/key/model for the next attempt, or null when nothing
   * usable is left (call failureSummary() for the user-facing reason).
   */
  next(): RunAttempt | null {
    if (this.pending) {
      throw new Error("run pool: settle the current attempt before starting the next one");
    }
    if (this.history.length >= this.maxAttempts) {
      this.emitExhausted(`stopped after ${this.maxAttempts} attempts`);
      return null;
    }

    const selection = this.family ? this.selectInFamily(this.family) : this.selectAny();
    if (!selection) {
      this.emitExhausted(
        this.family
          ? `no configured provider with a healthy key serves a ${this.family} model`
          : "no configured provider has a healthy key left"
      );
      return null;
    }

    const attempt: RunAttempt = {
      n: this.history.length + 1,
      selection,
      reason: this.nextReason,
      family: modelFamily(selection.model),
      ...(this.sessionId ? { resumeSessionId: this.sessionId } : {}),
    };
    this.pending = attempt;
    this.history.push(attempt);
    this.emit({
      type: "pool.attempt",
      n: attempt.n,
      provider: selection.provider,
      keyId: selection.keyId,
      model: selection.model,
      family: attempt.family,
      reason: attempt.reason,
      resume: attempt.resumeSessionId !== undefined,
    });
    return attempt;
  }

  /** The attempt finished cleanly. */
  reportSuccess(attempt: RunAttempt, sessionId?: string): void {
    this.assertPending(attempt);
    this.recordSession(sessionId);
    attempt.selection.settle({ ok: true });
    this.pending = null;
  }

  /**
   * The attempt failed. Settles the key (so its cooldown applies) and decides:
   * "rotate-key" (same provider, next key), "failover" (next provider) or
   * "fatal" (not a provider problem, or out of attempts — end the run).
   */
  reportFailure(attempt: RunAttempt, error: string | PoolFailure, sessionId?: string): FailureDecision {
    this.assertPending(attempt);
    this.recordSession(sessionId);
    this.pending = null;
    const { selection } = attempt;

    const failure: PoolFailure | null = typeof error === "string" ? classifyPoolError(error) : error;
    if (typeof error === "string") {
      this.failures.push(
        `${selection.provider} (${selection.keyId}, ${selection.model}): ${redact(error, selection.secrets).slice(0, 300)}`
      );
    } else {
      this.failures.push(
        `${selection.provider} (${selection.keyId}, ${selection.model}): ${error.kind}${error.status ? ` ${error.status}` : ""}`
      );
    }

    if (!failure || (!KEY_SCOPED.has(failure.kind) && !PROVIDER_SCOPED.has(failure.kind))) {
      // Not the provider's fault: do not cool the key down for it.
      selection.release();
      return {
        action: "fatal",
        kind: failure?.kind ?? "unknown",
        ...(failure?.status !== undefined ? { status: failure.status } : {}),
        reason: "not a provider error",
      };
    }

    selection.settle({
      ok: false,
      kind: failure.kind,
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    });
    const status = failure.status !== undefined ? { status: failure.status } : {};

    const decision: FailureDecision =
      KEY_SCOPED.has(failure.kind) && this.router.keyPool(selection.provider)?.hasAvailable() === true
        ? { action: "rotate-key", kind: failure.kind, ...status }
        : { action: "failover", kind: failure.kind, ...status };

    if (decision.action === "rotate-key") {
      this.nextReason = "key-rotation";
      this.emit({ type: "pool.rotate", provider: selection.provider, fromKeyId: selection.keyId, kind: failure.kind, ...status });
    } else {
      this.exhausted.add(selection.provider);
      this.nextReason = "failover";
      this.emit({ type: "pool.failover", provider: selection.provider, keyId: selection.keyId, kind: failure.kind, ...status });
    }

    if (this.history.length >= this.maxAttempts) {
      return { ...decision, action: "fatal", reason: `stopped after ${this.maxAttempts} attempts` };
    }
    return decision;
  }

  /**
   * Switch the rest of this run to another model family (optionally a specific
   * model). Returns false — and changes nothing — when no configured provider
   * with a healthy key serves that family. A lease still held for the current
   * attempt is released without counting as a failure.
   */
  switchFamily(family: ModelFamily, options: { model?: string; reason?: string; sessionId?: string } = {}): boolean {
    if (options.model && modelFamily(options.model) !== family) {
      throw new Error(`run pool: model "${options.model}" is not in the ${family} family`);
    }
    if (!this.familyCandidate(family, options.model)) return false;

    this.recordSession(options.sessionId);
    if (this.pending) {
      this.pending.selection.release();
      this.pending = null;
    }
    const from = this.family ?? (this.history.length > 0 ? this.history[this.history.length - 1].family : null);
    this.family = family;
    this.familyModel = options.model;
    this.nextReason = "family-switch";
    this.emit({
      type: "pool.family",
      from,
      to: family,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    });
    return true;
  }

  /** One line per failed attempt, redacted — for the run's final error. */
  failureSummary(): string {
    if (this.failures.length === 0) return "No provider attempt was made.";
    return `All provider attempts failed:\n- ${this.failures.join("\n- ")}`;
  }

  private selectAny(): ClaudeSelection | null {
    return this.router.selectForClaude(
      {
        ...(this.model !== undefined ? { model: this.model } : {}),
        ...(this.tier !== undefined ? { tier: this.tier } : {}),
      },
      this.exhausted
    );
  }

  /** First ranked, non-exhausted provider with a healthy key and a model of `family`. */
  private familyCandidate(family: ModelFamily, preferred?: string): { id: string; model: string } | null {
    for (const config of this.router.providerConfigs()) {
      if (config.enabled === false || this.exhausted.has(config.id)) continue;
      if (this.router.keyPool(config.id)?.hasAvailable() !== true) continue;
      const model = familyModelFor(config, family, preferred);
      if (model) return { id: config.id, model };
    }
    return null;
  }

  private selectInFamily(family: ModelFamily): ClaudeSelection | null {
    const preferred = this.familyModel ?? (modelFamily(this.model) === family ? this.model : undefined);
    const tried = new Set(this.exhausted);
    while (true) {
      const configs = this.router.providerConfigs();
      let candidate: { id: string; model: string } | null = null;
      for (const config of configs) {
        if (config.enabled === false || tried.has(config.id)) continue;
        if (this.router.keyPool(config.id)?.hasAvailable() !== true) continue;
        const model = familyModelFor(config, family, preferred);
        if (model) {
          candidate = { id: config.id, model };
          break;
        }
      }
      if (!candidate) return null;
      const chosenId = candidate.id;
      const skip = new Set(configs.map((c) => c.id).filter((id) => id !== chosenId));
      const selection = this.router.selectForClaude({ model: candidate.model }, skip);
      if (selection && modelFamily(selection.model) === family) return selection;
      selection?.release();
      tried.add(candidate.id);
    }
  }

  private assertPending(attempt: RunAttempt): void {
    if (this.pending !== attempt) {
      throw new Error("run pool: that attempt is not the one in flight");
    }
  }

  private emitExhausted(reason: string): void {
    this.emit({ type: "pool.exhausted", family: this.family, message: reason });
  }

  private emit(event: RunPoolEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A broken listener must not break the run.
    }
  }
}

/** What one attempt of the run reported back to runWithPool. */
export type AttemptOutcome =
  | { status: "done"; sessionId?: string }
  | { status: "error"; message: string; sessionId?: string }
  | { status: "switch-family"; family: ModelFamily; model?: string; reason?: string; sessionId?: string };

export interface PooledRunResult {
  ok: boolean;
  /** Redacted, user-facing error when ok is false. */
  error?: string;
  attempts: ReadonlyArray<Pick<RunAttempt, "n" | "reason" | "family" | "resumeSessionId"> & {
    provider: string;
    keyId: string;
    model: string;
  }>;
  sessionId?: string;
}

/**
 * Drive one run to completion through the pool: start an attempt, hand it to
 * `execute` (which runs the CLI with attempt.selection.env and, when set,
 * --resume attempt.resumeSessionId), and act on the outcome until the run is
 * done, fatally failed, or out of providers.
 */
export async function runWithPool(
  pool: RunProviderPool,
  execute: (attempt: RunAttempt) => Promise<AttemptOutcome>
): Promise<PooledRunResult> {
  let lastSession: string | undefined;
  const summary = (): PooledRunResult["attempts"] =>
    pool.attempts.map((a) => ({
      n: a.n,
      reason: a.reason,
      family: a.family,
      ...(a.resumeSessionId ? { resumeSessionId: a.resumeSessionId } : {}),
      provider: a.selection.provider,
      keyId: a.selection.keyId,
      model: a.selection.model,
    }));

  while (true) {
    const attempt = pool.next();
    if (!attempt) {
      return { ok: false, error: pool.failureSummary(), attempts: summary(), ...(lastSession ? { sessionId: lastSession } : {}) };
    }
    let outcome: AttemptOutcome;
    try {
      outcome = await execute(attempt);
    } catch (err) {
      outcome = { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.sessionId) lastSession = outcome.sessionId;

    if (outcome.status === "done") {
      pool.reportSuccess(attempt, outcome.sessionId);
      return { ok: true, attempts: summary(), ...(lastSession ? { sessionId: lastSession } : {}) };
    }
    if (outcome.status === "switch-family") {
      // The attempt ran fine up to the switch point; it is not a key failure.
      const switched = pool.switchFamily(outcome.family, {
        ...(outcome.model ? { model: outcome.model } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      });
      if (!switched) {
        pool.reportSuccess(attempt, outcome.sessionId);
        return {
          ok: false,
          error: `Cannot switch to the ${outcome.family} family: no configured provider with a healthy key serves it.`,
          attempts: summary(),
          ...(lastSession ? { sessionId: lastSession } : {}),
        };
      }
      continue;
    }
    const decision = pool.reportFailure(attempt, outcome.message, outcome.sessionId);
    if (decision.action === "fatal") {
      return { ok: false, error: pool.failureSummary(), attempts: summary(), ...(lastSession ? { sessionId: lastSession } : {}) };
    }
  }
}
