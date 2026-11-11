/**
 * Key clusters: one OpenAI-compatible endpoint, many API keys, raced concurrently.
 *
 * Each call fans out to `raceWidth` healthy keys at once; the first to answer wins and the
 * losers are aborted, so one slow or throttled key never sets the latency. Keys rotate
 * round-robin so load spreads across the whole pool. Failures bench the key:
 *  - 401/403: the key is dead (revoked, no access) and leaves rotation for `authCooldownMs`.
 *  - 429: exponential backoff per key (never shorter than `Retry-After`).
 *  - other retryable errors (5xx, timeouts, stalls) and garbled answers: counted, no backoff.
 * Key health lives in the shared `KeyPool` from packages/providers.
 * When a whole wave fails the next wave of healthy keys is tried at once, so a request only
 * errors when every key in the cluster has failed it.
 *
 * Keys only ever come from the caller (env vars or a server-side secret store). Nothing here
 * logs or returns a key; stats name keys by index and a 4-character suffix at most.
 */
import { ProviderError } from '../errors.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import type { CompletionRequest, CompletionResponse, Provider } from '../providers/types.js';
// The shared multi-key pool (packages/providers): rotation, exponential backoff, latency EMAs.
import { KeyPool, type ProviderId } from '../../../providers/src/keyPool.js';

const POOL_IDS: ReadonlySet<string> = new Set(['gemini', 'groq', 'cerebras', 'nemotron', 'mercury']);

export interface KeyClusterOptions {
  /** Provider name, used as the route (e.g. "nemotron", "mercury"). */
  name: string;
  baseUrl: string;
  keys: readonly string[];
  /** Model id sent to the endpoint when the request does not carry one for this cluster. */
  model: string;
  /** Keys raced per wave. Default 2. */
  raceWidth?: number;
  /** Base of the exponential 429 backoff (KeyPool). Default 2s, doubling per consecutive 429. */
  cooldownMs?: number;
  /** How long a key that answered 401/403 stays out of rotation. Default 15 min. */
  authCooldownMs?: number;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  fetch?: typeof fetch;
  /** Test seam: build the per-key client. */
  makeClient?: (key: string, index: number) => Provider;
  now?: () => number;
  onEvent?: (e: KeyClusterEvent) => void;
  /**
   * Accepts or rejects a response. A rejected response (e.g. garbled tokens from an overloaded
   * replica) does not win the race: the other racers keep going. Default: {@link isUsableResponse}.
   */
  validate?: (res: CompletionResponse) => boolean;
}

/** Text that is mostly replacement characters, runaway punctuation or script soup. */
export function looksGarbled(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 2_000);
  if (sample.includes('\uFFFD')) return true;
  if (/(?:-Re){2,}|(?:-P){3,}|-{40,}/.test(sample)) return true;
  let high = 0;
  for (const ch of sample) if ((ch.codePointAt(0) ?? 0) > 0x2fff) high++;
  return high / sample.length > 0.08;
}

/** A tool call, or non-empty text that is not garbled. */
export function isUsableResponse(res: CompletionResponse): boolean {
  if (res.content.some((b) => b.type === 'tool_use')) return true;
  const text = res.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (looksGarbled(text) || looksGarbled((res.reasoning ?? '').slice(0, 400))) return false;
  return text.trim().length > 0;
}

export type KeyClusterEvent =
  | { type: 'race.start'; cluster: string; keys: number[] }
  | { type: 'race.win'; cluster: string; key: number; ms: number }
  | { type: 'race.rejected'; cluster: string; key: number }
  | { type: 'key.benched'; cluster: string; key: number; status: number }
  | { type: 'key.cooldown'; cluster: string; key: number; ms: number; status: number | undefined };

export interface KeyStat {
  index: number;
  suffix: string;
  state: 'ok' | 'cooling';
  wins: number;
  failures: number;
  avgLatencyMs: number;
  tokensPerSec: number;
}

const isAuthFailure = (s: number | undefined): boolean => s === 401 || s === 403;

export class KeyCluster implements Provider {
  readonly name: string;
  readonly model: string;
  /** Key health, rotation, backoff and latency stats: the shared SwarmAgents KeyPool. */
  readonly pool: KeyPool;
  private readonly clients: Provider[];
  private readonly raceWidth: number;
  private readonly authCooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: KeyClusterOptions) {
    const keys = [...new Set(opts.keys.map((k) => k.trim()).filter(Boolean))];
    if (keys.length === 0) throw new Error(`key cluster "${opts.name}" has no keys`);
    this.name = opts.name;
    this.model = opts.model;
    this.raceWidth = Math.max(1, opts.raceWidth ?? 2);
    this.authCooldownMs = opts.authCooldownMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
    this.pool = new KeyPool({
      provider: (POOL_IDS.has(opts.name) ? opts.name : 'nemotron') as ProviderId,
      keys,
      baseCooldownMs: opts.cooldownMs ?? 2_000,
      maxCooldownMs: Math.max(this.authCooldownMs, 300_000),
      now: this.now,
    });
    this.clients = keys.map(
      (key, i) =>
        opts.makeClient?.(key, i) ??
        new OpenAICompatProvider({
          name: opts.name,
          baseUrl: opts.baseUrl,
          apiKey: key,
          timeoutMs: opts.timeoutMs ?? 120_000,
          stallTimeoutMs: opts.stallTimeoutMs ?? 60_000,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        }),
    );
  }

  get size(): number {
    return this.clients.length;
  }

  stats(): KeyStat[] {
    const t = this.now();
    return this.pool.stats().map((s) => ({
      index: s.index,
      suffix: s.suffix,
      state: s.coolingUntil > t ? 'cooling' : 'ok',
      wins: s.successes,
      failures: s.failures,
      avgLatencyMs: Math.round(s.avgLatencyMs),
      tokensPerSec: Math.round(s.tokensPerSec * 10) / 10,
    }));
  }

  private noteFailure(i: number, err: unknown): void {
    const status = err instanceof ProviderError ? err.status : undefined;
    if (isAuthFailure(status)) {
      // A revoked key: out of rotation for a long cooldown rather than retried every call.
      this.pool.reportFailure(i, status ?? 401, this.authCooldownMs);
      this.opts.onEvent?.({ type: 'key.benched', cluster: this.name, key: i, status: status ?? 0 });
      return;
    }
    if (status === 429) {
      const retryAfter = err instanceof ProviderError ? err.retryAfterMs : undefined;
      this.pool.reportFailure(i, 429, retryAfter);
      const until = this.pool.stats()[i]?.coolingUntil ?? this.now();
      this.opts.onEvent?.({ type: 'key.cooldown', cluster: this.name, key: i, ms: Math.max(0, until - this.now()), status });
      return;
    }
    // Transient (5xx, timeout, stall): counted, no backoff; the race already covers it.
    this.pool.reportFailure(i, status ?? 0);
  }

  /** Next wave: healthy keys in rotation order; if none, the one that cools down soonest. */
  private nextWave(tried: ReadonlySet<number>): number[] {
    const fresh = this.pool
      .available()
      .map((k) => k.index)
      .filter((i) => !tried.has(i))
      .slice(0, this.raceWidth);
    if (fresh.length) {
      // Advance the shared cursor past this wave.
      this.pool.take(this.pool.available().findIndex((k) => k.index === fresh[fresh.length - 1]) + 1);
      return fresh;
    }
    const soonest = this.pool
      .stats()
      .filter((s) => !tried.has(s.index))
      .sort((a, b) => a.coolingUntil - b.coolingUntil)[0];
    return soonest ? [soonest.index] : [];
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const model = req.model && req.model !== 'auto' ? req.model : this.model;
    const tried = new Set<number>();
    let lastErr: unknown;
    let sawRateLimit: unknown;
    for (;;) {
      if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
      const wave = this.nextWave(tried);
      if (wave.length === 0) break;
      for (const i of wave) tried.add(i);
      try {
        return await this.race(wave, { ...req, model });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        const errs = err instanceof AggregateError ? err.errors : [err];
        for (const e of errs) {
          if (!(e instanceof ProviderError)) throw e;
          if (e.status === 429) sawRateLimit = e;
          lastErr = e;
          // A request the endpoint rejects as malformed fails on every key: do not burn the pool.
          if (!e.retryable && !isAuthFailure(e.status) && e.status !== 429) throw e;
        }
      }
    }
    throw (
      sawRateLimit ??
      lastErr ??
      new ProviderError(`key cluster "${this.name}": every key is unavailable`, {
        retryable: true,
        status: 503,
      })
    );
  }

  private race(wave: number[], req: CompletionRequest): Promise<CompletionResponse> {
    const started = this.now();
    this.opts.onEvent?.({ type: 'race.start', cluster: this.name, keys: wave });
    const controllers = wave.map(() => new AbortController());
    const onAbort = (): void => {
      for (const c of controllers) c.abort(req.signal?.reason);
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    // The first racer to stream owns the deltas; the others' are dropped.
    let deltaOwner = -1;
    const attempts = wave.map(async (i, slot) => {
      const ctl = controllers[slot] as AbortController;
      const onDelta = req.onDelta;
      const sub: CompletionRequest = {
        ...req,
        signal: ctl.signal,
        ...(onDelta
          ? {
              onDelta: (d: { text?: string; reasoning?: string }) => {
                if (deltaOwner === -1) deltaOwner = slot;
                if (deltaOwner === slot) onDelta(d);
              },
            }
          : {}),
      };
      try {
        const res = await (this.clients[i] as Provider).complete(sub);
        if (!(this.opts.validate ?? isUsableResponse)(res)) {
          this.pool.reportFailure(i, 0);
          this.opts.onEvent?.({ type: 'race.rejected', cluster: this.name, key: i });
          // Retryable and not a key fault: the next wave tries again, the key stays in rotation.
          throw new ProviderError(`${this.name}: unusable response (garbled or empty)`, {
            retryable: true,
            status: 0,
          });
        }
        return { res, i, slot };
      } catch (err) {
        const garbled = err instanceof ProviderError && err.status === 0;
        if (!ctl.signal.aborted && !garbled) this.noteFailure(i, err);
        throw err;
      }
    });
    return Promise.any(attempts)
      .then(({ res, i, slot }) => {
        controllers.forEach((c, s) => {
          if (s !== slot) c.abort(new Error('lost the race'));
        });
        const ms = this.now() - started;
        this.pool.reportSuccess(i, { latencyMs: ms, tokens: res.usage.output });
        this.opts.onEvent?.({ type: 'race.win', cluster: this.name, key: i, ms });
        return res;
      })
      .finally(() => req.signal?.removeEventListener('abort', onAbort));
  }
}

/**
 * Routes each call to the cluster named by `req.route`. With `race: true` (or route "race")
 * every cluster runs the call at once with its own model and the first answer wins; a failed
 * cluster falls through to the others either way.
 */
export class ClusterRouter implements Provider {
  readonly name = 'swarm-clusters';
  private readonly byName: Map<string, KeyCluster>;

  constructor(
    readonly clusters: readonly KeyCluster[],
    private readonly opts: { race?: boolean } = {},
  ) {
    if (clusters.length === 0) throw new Error('ClusterRouter needs at least one cluster');
    this.byName = new Map(clusters.map((c) => [c.name, c]));
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const primary = req.route ? this.byName.get(req.route) : undefined;
    if (this.opts.race || req.route === 'race' || !primary) return this.raceAll(req);
    try {
      return await primary.complete(req);
    } catch (err) {
      const failover =
        err instanceof ProviderError &&
        (err.retryable || err.status === 429 || err.status === 401 || err.status === 403);
      if (req.signal?.aborted || !failover) throw err;
      const rest = this.clusters.filter((c) => c !== primary);
      if (rest.length === 0) throw err;
      return this.raceAll(req, rest);
    }
  }

  private async raceAll(
    req: CompletionRequest,
    clusters: readonly KeyCluster[] = this.clusters,
  ): Promise<CompletionResponse> {
    const ctls = clusters.map(() => new AbortController());
    const onAbort = (): void => {
      for (const c of ctls) c.abort(req.signal?.reason);
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    let owner = -1;
    try {
      return await Promise.any(
        clusters.map(async (c, slot) => {
          const onDelta = req.onDelta;
          const res = await c.complete({
            ...req,
            // Each cluster speaks its own model id.
            model: c.model,
            route: c.name,
            signal: (ctls[slot] as AbortController).signal,
            ...(onDelta
              ? {
                  onDelta: (d: { text?: string; reasoning?: string }) => {
                    if (owner === -1) owner = slot;
                    if (owner === slot) onDelta(d);
                  },
                }
              : {}),
          });
          ctls.forEach((x, s) => {
            if (s !== slot) x.abort(new Error('lost the race'));
          });
          return res;
        }),
      );
    } catch (err) {
      if (err instanceof AggregateError) throw err.errors[0] ?? err;
      throw err;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}
