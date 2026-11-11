export type ProviderId = 'gemini' | 'groq' | 'cerebras' | 'nemotron' | 'mercury';

export interface KeyPoolOptions {
  provider: ProviderId;
  keys: string[];
  /**
   * Base cooldown for exponential backoff (ms). Default 1000.
   */
  baseCooldownMs?: number;
  /**
   * Upper bound for cooldown (ms). Default 300000 (5 min).
   */
  maxCooldownMs?: number;
  /**
   * Injectable clock for tests. Default Date.now.
   */
  now?: () => number;
}

export interface AvailableKey {
  index: number;
  key: string;
}

export interface KeyStats {
  index: number;
  /** Last 4 characters of the key, or full key if shorter. */
  suffix: string;
  /** Epoch ms after which the key may be used again (0 = not cooling). */
  coolingUntil: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  tokensPerSec: number;
  successes: number;
  failures: number;
}

interface KeyState {
  key: string;
  coolingUntil: number;
  consecutiveFailures: number;
  avgLatencyMs: number;
  tokensPerSec: number;
  successes: number;
  failures: number;
}

const EMA_ALPHA = 0.3;
const DEFAULT_KEY_COOLDOWN_MS = 1000;
const MAX_KEY_COOLDOWN_MS = 300000;

function ema(prev: number, sample: number, alpha: number): number {
  if (prev <= 0) return sample;
  return prev + alpha * (sample - prev);
}

export class KeyPool {
  readonly provider: ProviderId;
  readonly baseCooldownMs: number;
  readonly maxCooldownMs: number;
  private readonly now: () => number;
  private readonly keys: KeyState[];
  /**
   * Round-robin cursor: index of the last-used key. The first available
   * key on a take is cursor + 1, so -1 means "start at index 0".
   */
  private cursor = -1;

  constructor(options: KeyPoolOptions) {
    this.provider = options.provider;
    this.baseCooldownMs = options.baseCooldownMs ?? DEFAULT_KEY_COOLDOWN_MS;
    this.maxCooldownMs = options.maxCooldownMs ?? MAX_KEY_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
    if (options.keys.length === 0) {
      throw new Error(`KeyPool(${this.provider}) requires at least one key`);
    }
    this.keys = options.keys.map((key) => ({
      key,
      coolingUntil: 0,
      consecutiveFailures: 0,
      avgLatencyMs: 0,
      tokensPerSec: 0,
      successes: 0,
      failures: 0,
    }));
  }

  get size(): number {
    return this.keys.length;
  }

  /**
   * Keys that are not currently cooling, in round-robin order starting
   * after the last-used key.
   */
  available(): AvailableKey[] {
    const now = this.now();
    const result: AvailableKey[] = [];
    for (let n = 0; n < this.keys.length; n++) {
      const i = (this.cursor + 1 + n) % this.keys.length;
      const state = this.keys[i]!;
      if (state.coolingUntil <= now) {
        result.push({ index: i, key: state.key });
      }
    }
    return result;
  }

  /**
   * Take up to `n` available keys and advance the round-robin cursor
   * past the last one taken.
   */
  take(n: number): AvailableKey[] {
    const avail = this.available();
    const taken = avail.slice(0, n);
    if (taken.length > 0) {
      this.cursor = taken[taken.length - 1]!.index;
    }
    return taken;
  }

  /**
   * Record a successful request. Resets the consecutive-failure counter
   * and updates the latency/token-speed EMA.
   */
  reportSuccess(index: number, metrics: { latencyMs: number; tokens: number }): void {
    const state = this.keys[index];
    if (!state) return;
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.coolingUntil = 0;
    state.avgLatencyMs = ema(state.avgLatencyMs, metrics.latencyMs, EMA_ALPHA);
    const secs = metrics.latencyMs / 1000;
    const tokensPerSec = secs > 0 ? metrics.tokens / secs : 0;
    state.tokensPerSec = ema(state.tokensPerSec, tokensPerSec, EMA_ALPHA);
  }

  /**
   * Record a failed request. 429 (rate limited) and 401/403 (auth) apply
   * exponential backoff: cooldown = min(max, base * 2^(consecutive-1)),
   * never less than the server's Retry-After hint.
   */
  reportFailure(index: number, status: number, retryAfterMs?: number): void {
    const state = this.keys[index];
    if (!state) return;
    state.failures += 1;

    if (status === 429 || status === 401 || status === 403) {
      state.consecutiveFailures += 1;
      const exponent = Math.max(0, state.consecutiveFailures - 1);
      const backoff = this.baseCooldownMs * Math.pow(2, exponent);
      const cooldown = Math.min(this.maxCooldownMs, backoff);
      const waitMs = Math.max(cooldown, retryAfterMs ?? 0);
      state.coolingUntil = this.now() + waitMs;
    } else {
      // Non-throttle failures do not escalate backoff, but do clear any
      // stale cooldown so the key can be retried immediately.
      state.consecutiveFailures = 0;
      state.coolingUntil = 0;
    }
  }

  stats(): KeyStats[] {
    return this.keys.map((state, index) => ({
      index,
      suffix: state.key.length > 4 ? state.key.slice(-4) : state.key,
      coolingUntil: state.coolingUntil,
      consecutiveFailures: state.consecutiveFailures,
      avgLatencyMs: state.avgLatencyMs,
      tokensPerSec: state.tokensPerSec,
      successes: state.successes,
      failures: state.failures,
    }));
  }
}
