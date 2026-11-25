/**
 * Provider race engine: race up to N keys of ONE provider in parallel and
 * take the first VALID response.
 *
 * What it adds over the run pool (run-pool.ts) and the router's hedging:
 *
 *  - The run pool rotates keys SEQUENTIALLY: one attempt per key, and only
 *    after the previous attempt failed. The router hedges ACROSS providers
 *    (a second provider starts after a delay). Neither races several keys
 *    of the SAME provider at once.
 *  - This engine fires up to N keys of one provider in parallel. The first
 *    VALID response wins. A fast garbage reply (token soup from an
 *    overloaded free-tier replica) never wins — the race keeps going until
 *    a valid response arrives or every key has failed.
 *
 * Keys: the engine never reads keys. It only drives the Router the caller
 * passes, which must be built from the signed-in user's own provider config
 * (see user-run-pool.ts). Leases are settled through the app's KeyPool, so
 * a bad key cools down (Retry-After honoured) and a good key's latency is
 * recorded. Errors carry safe key slot labels ("groq:key-2"), never key
 * values. Requests are built with the app's adapters (buildRequest /
 * parseResponse), so auth, URL and body follow the provider's apiStyle.
 */

import { buildRequest, parseResponse, resolveModel } from "./adapters";
import { parseRetryAfter } from "./errors";
import type { KeyPool } from "./key-pool";
import type { FetchLike, ProviderConfig, ProviderErrorKind } from "./types";

/** The slice of Router the race needs (Router satisfies it structurally). */
export interface RaceRouter {
  keyPool(providerId: string): KeyPool | undefined;
  providerConfigs(): ProviderConfig[];
}

export interface RaceRequest {
  prompt: string;
  /** Provider id, e.g. "groq". */
  provider: string;
  /** Max number of keys to race from the pool. Default 3. */
  candidates?: number;
  /** Override the provider's default model. */
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface RaceResult {
  text: string;
  provider: string;
  model: string;
  /** Safe key slot label, e.g. "groq:key-2". Never the key value. */
  keyId: string;
  latencyMs: number;
  /** Output tokens reported by the provider (0 when unreported). */
  tokens: number;
}

export interface RaceEngineOptions {
  router: RaceRouter;
  fetch?: FetchLike;
  /** Override the garbage validator (tests). Default isValidCompletionText. */
  validate?: (text: string) => boolean;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

/**
 * Whether a completion text counts as a real answer. Rejects the token
 * soup overloaded free-tier replicas emit: replacement characters, control
 * characters, runaway "-Re"/"-P" fragments, or a high share of unrelated
 * CJK/Hangul/symbol code points. Pure function.
 */
export function isValidCompletionText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  let bad = 0;
  for (const ch of t) {
    const code = ch.codePointAt(0)!;
    // U+FFFD replacement char, NUL, or other control characters.
    if (code === 0xfffd || (code >= 0x0000 && code <= 0x001f)) bad += 1;
  }
  if (bad / t.length >= 0.5) return false;
  // Overloaded replicas (seen on NVIDIA NIM's Nemotron) emit token soup:
  // runaway "-Re-P" fragments or a high share of unrelated CJK/Hangul/
  // symbol code points.
  const sample = t.slice(0, 2000);
  if (/(?:-Re){2,}|(?:-P){3,}|-{40,}/.test(sample)) return false;
  let high = 0;
  for (const ch of sample) if (ch.codePointAt(0)! > 0x2fff) high += 1;
  return high / sample.length <= 0.08;
}

/** Map an HTTP status to the pool's failure kind (for key cooldown). */
export function kindForHttpStatus(status: number): ProviderErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota_exhausted";
  if (status === 408) return "timeout";
  if (status === 400 || status === 404 || status === 422) return "bad_request";
  if (status >= 500) return "server";
  return "server";
}

interface FailureRecord {
  keyId: string;
  status: number;
  message: string;
}

export class ProviderRaceEngine {
  private readonly router: RaceRouter;
  private readonly fetchFn: FetchLike;
  private readonly validate: (text: string) => boolean;
  private readonly now: () => number;

  constructor(options: RaceEngineOptions) {
    this.router = options.router;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.validate = options.validate ?? isValidCompletionText;
    this.now = options.now ?? Date.now;
  }

  /**
   * Race up to `candidates` keys from the provider's pool. The first
   * VALID response wins; failed or invalid responses never win. Rejects
   * only when every candidate has failed (or the outer signal aborts).
   */
  complete(request: RaceRequest): Promise<RaceResult> {
    const { prompt, provider, candidates = 3, model, maxTokens, signal } = request;
    const config = this.router.providerConfigs().find((c) => c.id === provider);
    if (!config) {
      return Promise.reject(new Error(`race: no provider config for "${provider}"`));
    }
    const pool = this.router.keyPool(provider);
    if (!pool) {
      return Promise.reject(new Error(`race: no key pool for provider "${provider}"`));
    }
    const resolvedModel = model ?? resolveModel(config, {});

    // Lease up to `candidates` DISTINCT keys. acquireMany() is required
    // here: plain acquire() returns the same key on every call in
    // "fallback" mode (and can repeat a draw in "random" mode), so a race
    // would silently run on one key.
    const leases = pool.acquireMany(candidates);
    if (leases.length === 0) {
      const cooling = pool.stats().filter((s) => s.cooldownUntil !== undefined).length;
      return Promise.reject(
        new Error(
          `race: provider "${provider}" has no available keys (${cooling}/${pool.size} cooling)`,
        ),
      );
    }

    return new Promise<RaceResult>((resolve, reject) => {
      const innerControllers: AbortController[] = [];
      const failures: FailureRecord[] = [];
      // lease id -> its outcome has been recorded (success/failure/cancel).
      const done = new Map<string, boolean>();
      let settled = 0;
      let rejected = false;
      let winnerFound = false;

      /** Release every lease whose outcome was never recorded. */
      const cancelUnsettled = () => {
        for (const lease of leases) {
          if (!done.get(lease.id)) {
            done.set(lease.id, true);
            lease.cancel();
          }
        }
      };

      const abortAll = (except?: AbortController) => {
        for (const controller of innerControllers) {
          if (controller !== except) controller.abort();
        }
      };

      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onOuterAbort);
      };

      const onOuterAbort = () => {
        if (rejected) return;
        rejected = true;
        abortAll();
        cancelUnsettled();
        cleanup();
        const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
        reject(reason);
      };

      if (signal) {
        if (signal.aborted) {
          onOuterAbort();
          return;
        }
        signal.addEventListener("abort", onOuterAbort, { once: true });
      }

      const recordFailure = (failure: FailureRecord) => {
        failures.push(failure);
        settled += 1;
        if (!rejected && settled >= leases.length) {
          rejected = true;
          cancelUnsettled();
          cleanup();
          const detail = failures
            .map((f) => `${f.keyId} status ${f.status} (${f.message})`)
            .join("; ");
          reject(
            new Error(
              `All ${leases.length} candidate(s) for provider "${provider}" failed: ${detail}`,
            ),
          );
        }
      };

      for (const lease of leases) {
        const controller = new AbortController();
        innerControllers.push(controller);
        const startedAt = this.now();

        void (async () => {
          try {
            const { url, init } = buildRequest(
              config,
              lease.value,
              resolvedModel,
              {
                messages: [{ role: "user", content: prompt }],
                ...(maxTokens !== undefined ? { maxTokens } : {}),
              },
              controller.signal,
            );
            const response = await this.fetchFn(url, init);
            const latencyMs = this.now() - startedAt;

            if (response.ok) {
              let json: unknown = null;
              try {
                json = JSON.parse(await response.text());
              } catch {
                json = null;
              }
              let parsed: { text: string; usage: { outputTokens: number } } | null = null;
              try {
                parsed = parseResponse(config, json, resolvedModel);
              } catch {
                parsed = null;
              }
              if (parsed && this.validate(parsed.text)) {
                if (!winnerFound && !rejected) {
                  winnerFound = true;
                  done.set(lease.id, true);
                  lease.success(latencyMs);
                  abortAll(controller);
                  cancelUnsettled();
                  cleanup();
                  resolve({
                    text: parsed.text,
                    provider,
                    model: resolvedModel,
                    keyId: lease.id,
                    latencyMs,
                    tokens: parsed.usage.outputTokens ?? 0,
                  });
                } else if (!rejected) {
                  // A valid response that lost the race: still a success
                  // for this key — it worked, it just wasn't first.
                  done.set(lease.id, true);
                  lease.success(latencyMs);
                }
                return;
              }
              // OK status but unusable body/text (invalid response or garbage).
              done.set(lease.id, true);
              lease.failure({ kind: "invalid_response" });
              recordFailure({ keyId: lease.id, status: 0, message: "invalid response text" });
              return;
            }

            const status = response.status;
            const retryAfterMs = parseRetryAfter(
              response.headers.get("retry-after"),
              this.now(),
            );
            const kind = kindForHttpStatus(status);
            done.set(lease.id, true);
            lease.failure({
              status,
              kind,
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            });
            recordFailure({ keyId: lease.id, status, message: `HTTP ${status}` });
          } catch (error) {
            if (rejected) return; // outer abort already rejected the race.
            if (error instanceof Error && error.name === "AbortError") {
              // Aborted because a winner was found; not a failure.
              // (The lease is cancelled by cancelUnsettled.)
              return;
            }
            done.set(lease.id, true);
            lease.failure({ kind: "network" });
            recordFailure({ keyId: lease.id, status: 0, message: String(error) });
          }
        })();
      }
    });
  }
}
