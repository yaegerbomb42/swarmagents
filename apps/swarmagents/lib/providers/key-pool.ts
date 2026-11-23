import { hashProviderKey, DEFAULT_QUOTA_COOLDOWN_MS } from "./cooldown-store";
import type { PersistedCooldown } from "./cooldown-store";
import { isCooldownKind } from "./errors";
import type { KeyStat, ProviderErrorKind } from "./types";
import type { KeySelectionMode } from "./settings";

export interface KeyPoolOptions {
  /** First cooldown, before exponential growth. */
  cooldownBaseMs?: number;
  /** Upper bound for a single cooldown. */
  cooldownMaxMs?: number;
  /**
   * How long every key of the provider is skipped after a 402 (payment/quota
   * exhausted). Defaults to DEFAULT_QUOTA_COOLDOWN_MS.
   */
  quotaCooldownMs?: number;
  /** Injectable clock, primarily for deterministic tests. */
  now?: () => number;
  /**
   * How acquire() picks among usable keys (the user's quota fallback
   * method). Defaults to "round-robin" — fewest consecutive failures,
   * then least recently used.
   */
  selectionMode?: KeySelectionMode;
  /** Injectable randomness for "random" mode, primarily for tests. */
  random?: () => number;
  /**
   * Called whenever the cooldown/backoff state of a key changes. The router
   * uses it to persist the state so it survives a restart.
   */
  onStateChange?: (providerId: string) => void;
}

export interface KeyFailure {
  status?: number;
  kind: ProviderErrorKind;
  retryAfterMs?: number;
}

interface KeyState {
  id: string;
  /** One-way id of the key. Used to persist state across restarts. */
  keyHash: string;
  value: string;
  cooldownUntil: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  latencySamples: number;
  lastStatus?: number;
  lastErrorKind?: string;
  lastUsedTick: number;
}

export interface KeyLease {
  /** Safe slot label, never the secret. */
  readonly id: string;
  /** Secret value. Only providers are allowed to read this. */
  readonly value: string;
  success(latencyMs: number): void;
  failure(failure: KeyFailure): void;
  /** Release without recording a success or failure (e.g. race cancellation). */
  cancel(): void;
}

const DEFAULT_COOLDOWN_BASE_MS = 1_000;
const DEFAULT_COOLDOWN_MAX_MS = 5 * 60_000;

/**
 * Resolve the provider-wide 402 cooldown window from SWARM_QUOTA_COOLDOWN_MS
 * (default DEFAULT_QUOTA_COOLDOWN_MS).
 */
export function resolveQuotaCooldownMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SWARM_QUOTA_COOLDOWN_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_QUOTA_COOLDOWN_MS;
}

function dedupe(keys: string[]): string[] {
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
}

/**
 * A rotating pool of API keys belonging to one provider. Keys are referenced
 * externally only by their slot id; the raw value never leaves the lease.
 */
export class KeyPool {
  private readonly providerId: string;
  private readonly states: KeyState[];
  private readonly cooldownBaseMs: number;
  private readonly cooldownMaxMs: number;
  private readonly quotaCooldownMs: number;
  private readonly now: () => number;
  private readonly selectionMode: KeySelectionMode;
  private readonly random: () => number;
  private readonly onStateChange?: (providerId: string) => void;
  private tick = 0;

  constructor(providerId: string, keys: string[], options: KeyPoolOptions = {}) {
    this.providerId = providerId;
    this.cooldownBaseMs = options.cooldownBaseMs ?? DEFAULT_COOLDOWN_BASE_MS;
    this.cooldownMaxMs = options.cooldownMaxMs ?? DEFAULT_COOLDOWN_MAX_MS;
    this.quotaCooldownMs = options.quotaCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.selectionMode = options.selectionMode ?? "round-robin";
    this.random = options.random ?? Math.random;
    this.onStateChange = options.onStateChange;
    this.states = dedupe(keys).map((value, index) => ({
      id: `${this.providerId}:key-${index + 1}`,
      keyHash: hashProviderKey(value),
      value,
      cooldownUntil: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      avgLatencyMs: 0,
      latencySamples: 0,
      lastUsedTick: 0,
    }));
  }

  get size(): number {
    return this.states.length;
  }

  /** Raw keys, for the router's redaction registry. Never expose or log this. */
  secretValues(): string[] {
    return this.states.map((state) => state.value);
  }

  /** Whether at least one key is currently usable (not cooling down). */
  hasAvailable(): boolean {
    const now = this.now();
    return this.states.some((state) => state.cooldownUntil <= now);
  }

  /** Returns a lease on the best available key, or null if all are cooling. */
  acquire(): KeyLease | null {
    const now = this.now();
    const available = this.states.filter((state) => state.cooldownUntil <= now);
    if (available.length === 0) return null;

    let chosen: KeyState;
    switch (this.selectionMode) {
      case "fallback":
        // Strict priority: the first usable key in saved order serves
        // until it cools down; later keys are pure fallbacks.
        chosen = available[0]!;
        break;
      case "random": {
        const index = Math.min(
          available.length - 1,
          Math.max(0, Math.floor(this.random() * available.length)),
        );
        chosen = available[index]!;
        break;
      }
      case "tiered":
        // Healthiest tier first, then fastest average latency, then LRU.
        chosen = available.reduce((best, state) =>
          state.consecutiveFailures < best.consecutiveFailures ||
          (state.consecutiveFailures === best.consecutiveFailures &&
            (state.avgLatencyMs < best.avgLatencyMs ||
              (state.avgLatencyMs === best.avgLatencyMs &&
                state.lastUsedTick < best.lastUsedTick)))
            ? state
            : best,
        );
        break;
      case "round-robin":
      default:
        // Fewest consecutive failures, then least recently used.
        chosen = available.reduce((best, state) =>
          state.consecutiveFailures < best.consecutiveFailures ||
          (state.consecutiveFailures === best.consecutiveFailures &&
            state.lastUsedTick < best.lastUsedTick)
            ? state
            : best,
        );
        break;
    }

    chosen.lastUsedTick = ++this.tick;
    const state = chosen;
    let settled = false;

    return {
      id: state.id,
      value: state.value,
      success: (latencyMs: number) => {
        if (settled) return;
        settled = true;
        this.recordSuccess(state, latencyMs);
      },
      failure: (failure: KeyFailure) => {
        if (settled) return;
        settled = true;
        this.recordFailure(state, failure);
      },
      cancel: () => {
        settled = true;
      },
    };
  }

  stats(): KeyStat[] {
    const now = this.now();
    return this.states.map((state) => ({
      id: state.id,
      available: state.cooldownUntil <= now,
      cooldownUntil: state.cooldownUntil > now ? state.cooldownUntil : undefined,
      successes: state.successes,
      failures: state.failures,
      consecutiveFailures: state.consecutiveFailures,
      avgLatencyMs: Math.round(state.avgLatencyMs),
      lastStatus: state.lastStatus,
      lastErrorKind: state.lastErrorKind,
    }));
  }

  /** Put every key on cooldown for at least `ms` milliseconds. */
  cooldownAllKeys(ms: number): void {
    const until = this.now() + Math.max(0, ms);
    let changed = false;
    for (const state of this.states) {
      if (state.cooldownUntil < until) {
        state.cooldownUntil = until;
        changed = true;
      }
    }
    if (changed) this.notifyStateChange();
  }

  /**
   * Apply persisted cooldown/backoff state, matched by the one-way key hash.
   * A record whose cooldown already elapsed is ignored: the key is usable
   * again and must not be blocked by a stale file.
   */
  restore(records: readonly PersistedCooldown[]): void {
    const byHash = new Map(records.map((record) => [record.keyHash, record]));
    const now = this.now();
    for (const state of this.states) {
      const record = byHash.get(state.keyHash);
      if (!record) continue;
      if (record.cooldownUntil <= now) continue;
      state.cooldownUntil = Math.max(state.cooldownUntil, record.cooldownUntil);
      state.consecutiveFailures = Math.max(state.consecutiveFailures, record.consecutiveFailures);
      state.failures = Math.max(state.failures, record.failures);
      if (record.lastStatus !== undefined) state.lastStatus = record.lastStatus;
      if (record.lastErrorKind !== undefined) state.lastErrorKind = record.lastErrorKind;
    }
  }

  /**
   * The persistable view of this pool: one record per key that is currently
   * cooling down. Keys without an active cooldown carry no state worth
   * keeping, so they are left out (and pruned from the state file).
   */
  cooldownStates(): PersistedCooldown[] {
    const now = this.now();
    const records: PersistedCooldown[] = [];
    for (const state of this.states) {
      if (state.cooldownUntil <= now) continue;
      records.push({
        provider: this.providerId,
        keyHash: state.keyHash,
        cooldownUntil: state.cooldownUntil,
        consecutiveFailures: state.consecutiveFailures,
        failures: state.failures,
        ...(state.lastStatus !== undefined ? { lastStatus: state.lastStatus } : {}),
        ...(state.lastErrorKind !== undefined ? { lastErrorKind: state.lastErrorKind } : {}),
        updatedAt: now,
      });
    }
    return records;
  }

  private recordSuccess(state: KeyState, latencyMs: number): void {
    const sample = Math.max(0, latencyMs);
    const hadState = state.cooldownUntil > 0 || state.consecutiveFailures > 0;
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    state.latencySamples += 1;
    // Exponential moving average, weighting recent requests more heavily.
    state.avgLatencyMs =
      state.latencySamples === 1
        ? sample
        : state.avgLatencyMs * 0.7 + sample * 0.3;
    if (hadState) this.notifyStateChange();
  }

  private recordFailure(state: KeyState, failure: KeyFailure): void {
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastStatus = failure.status;
    state.lastErrorKind = failure.kind;

    if (!isCooldownKind(failure.kind)) {
      this.notifyStateChange();
      return;
    }

    // 402 / quota: cool every key of the provider down for a fixed window
    // (default 15 min) instead of retrying it on every call.
    if (failure.kind === "quota_exhausted") {
      state.cooldownUntil =
        this.now() + Math.max(this.quotaCooldownMs, failure.retryAfterMs ?? 0);
      this.notifyStateChange();
      return;
    }

    const exponent = Math.min(state.consecutiveFailures - 1, 20);
    const backoff = Math.min(
      this.cooldownMaxMs,
      this.cooldownBaseMs * 2 ** exponent
    );
    const wait = Math.max(backoff, failure.retryAfterMs ?? 0);
    state.cooldownUntil = this.now() + wait;
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    this.onStateChange?.(this.providerId);
  }
}
