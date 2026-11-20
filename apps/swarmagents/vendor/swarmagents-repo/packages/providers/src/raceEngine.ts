import { KeyPool, type ProviderId } from './keyPool.js';

export interface ProviderEndpoint {
  baseUrl: string;
  model: string;
}

export interface ProviderRaceEngineOptions {
  pools: Partial<Record<ProviderId, KeyPool>>;
  endpoints?: Partial<Record<ProviderId, ProviderEndpoint>>;
  fetch?: typeof fetch;
  /**
   * Predicate deciding whether a response text counts as a valid completion.
   * Default: non-empty text that is not mostly replacement/garbage characters.
   */
  validate?: (text: string) => boolean;
}

export interface CompleteRequest {
  prompt: string;
  provider: ProviderId;
  /** Max number of keys to race from the pool. Default 3. */
  candidates?: number;
  /** Override the default model for the provider. */
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  provider: ProviderId;
  keyIndex: number;
  latencyMs: number;
  tokens: number;
}

export const DEFAULT_ENDPOINTS: Record<ProviderId, ProviderEndpoint> = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
  },
  cerebras: {
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b',
  },
  nemotron: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
  },
  mercury: {
    baseUrl: 'https://api.inceptionlabs.ai/v1',
    model: 'mercury-3',
  },
};

const DEFAULT_VALIDATE = (text: string): boolean => {
  const t = text.trim();
  if (!t) return false;
  let bad = 0;
  for (const ch of t) {
    const code = ch.codePointAt(0)!;
    // U+FFFD replacement char, NUL, or other control characters.
    if (code === 0xfffd || (code >= 0x0000 && code <= 0x001f)) bad += 1;
  }
  if (bad / t.length >= 0.5) return false;
  // Overloaded replicas (seen on NVIDIA NIM's Nemotron) emit token soup: runaway "-Re-P"
  // fragments or a high share of unrelated CJK/Hangul/symbol code points.
  const sample = t.slice(0, 2000);
  if (/(?:-Re){2,}|(?:-P){3,}|-{40,}/.test(sample)) return false;
  let high = 0;
  for (const ch of sample) if (ch.codePointAt(0)! > 0x2fff) high += 1;
  return high / sample.length <= 0.08;
};

interface FailureRecord {
  index: number;
  status: number;
  message: string;
}

/**
 * Parse a Retry-After header: either integer seconds or an HTTP-date.
 * Returns ms, or undefined when absent/unparseable.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  return undefined;
}

interface ParsedCompletion {
  text: string;
  tokens: number;
}

function parseCompletionBody(json: unknown): ParsedCompletion | null {
  if (typeof json !== 'object' || json === null) return null;
  const data = json as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, unknown> };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return null;
  const usage = data.usage;
  const completionTokens =
    usage && typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const totalTokens = usage && typeof usage.total_tokens === 'number' ? usage.total_tokens : 0;
  return { text, tokens: completionTokens || totalTokens || 0 };
}

export class ProviderRaceEngine {
  private readonly pools: Partial<Record<ProviderId, KeyPool>>;
  private readonly endpoints: Record<ProviderId, ProviderEndpoint>;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly validate: (text: string) => boolean;

  constructor(options: ProviderRaceEngineOptions) {
    this.pools = options.pools;
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.validate = options.validate ?? DEFAULT_VALIDATE;
  }

  /**
   * Race up to `candidates` keys from the provider's pool. The first
   * VALID response wins; failed or invalid responses never win. Rejects
   * only when every candidate has failed (or the outer signal aborts).
   */
  complete(request: CompleteRequest): Promise<CompleteResult> {
    const { prompt, provider, candidates = 3, model, maxTokens, signal } = request;
    const pool = this.pools[provider];
    if (!pool) {
      return Promise.reject(new Error(`No key pool registered for provider "${provider}"`));
    }
    const endpoint = this.endpoints[provider];
    const fetchFn = this.fetchFn;
    if (!fetchFn) {
      return Promise.reject(new Error('No fetch implementation available'));
    }

    const selected = pool.take(candidates);
    if (selected.length === 0) {
      const stats = pool.stats();
      const cooling = stats.filter((s) => s.coolingUntil > 0).length;
      return Promise.reject(
        new Error(
          `Provider "${provider}" has no available keys (${cooling}/${stats.length} cooling)`,
        ),
      );
    }

    return new Promise<CompleteResult>((resolve, reject) => {
      const innerControllers: AbortController[] = [];
      const failures: FailureRecord[] = [];
      let settled = 0;
      let rejected = false;
      let winnerFound = false;

      const abortAll = (except?: AbortController) => {
        for (const controller of innerControllers) {
          if (controller !== except) controller.abort();
        }
      };

      const onOuterAbort = () => {
        if (rejected) return;
        rejected = true;
        abortAll();
        const reason = signal?.reason instanceof Error ? signal.reason : new Error('Aborted');
        reject(reason);
      };

      if (signal) {
        if (signal.aborted) {
          onOuterAbort();
          return;
        }
        signal.addEventListener('abort', onOuterAbort, { once: true });
      }

      const recordFailure = (failure: FailureRecord) => {
        failures.push(failure);
        settled += 1;
        if (!rejected && settled >= selected.length) {
          rejected = true;
          const detail = failures
            .map((f) => `key#${f.index} status ${f.status} (${f.message})`)
            .join('; ');
          reject(
            new Error(`All ${selected.length} candidate(s) for provider "${provider}" failed: ${detail}`),
          );
        }
      };

      for (const { index, key } of selected) {
        const controller = new AbortController();
        innerControllers.push(controller);
        const startedAt = Date.now();

        void (async () => {
          const finish = () => {
            // Winner found (or outer abort): stop the race and clear the
            // outer signal listener so aborts don't double-fire.
            if (signal) signal.removeEventListener('abort', onOuterAbort);
          };

          try {
            const response = await fetchFn(`${endpoint.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: model ?? endpoint.model,
                messages: [{ role: 'user', content: prompt }],
                ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
              }),
              signal: controller.signal,
            });

            if (response.ok) {
              let json: unknown;
              try {
                json = await response.json();
              } catch {
                json = null;
              }
              const parsed = parseCompletionBody(json);
              const latencyMs = Date.now() - startedAt;
              if (parsed && this.validate(parsed.text)) {
                if (!winnerFound && !rejected) {
                  winnerFound = true;
                  pool.reportSuccess(index, { latencyMs, tokens: parsed.tokens });
                  abortAll(controller);
                  finish();
                  resolve({
                    text: parsed.text,
                    provider,
                    keyIndex: index,
                    latencyMs,
                    tokens: parsed.tokens,
                  });
                } else if (!rejected) {
                  // A valid response that lost the race: still count it as
                  // a success for this key — it worked, it just wasn't first.
                  pool.reportSuccess(index, { latencyMs, tokens: parsed.tokens });
                }
                return;
              }
              // OK status but unusable body/text.
              pool.reportFailure(index, 0);
              recordFailure({ index, status: 0, message: 'invalid response text' });
              return;
            }

            const status = response.status;
            const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
            pool.reportFailure(index, status, retryAfterMs);
            recordFailure({ index, status, message: `HTTP ${status}` });
          } catch (error) {
            if (rejected) return; // outer abort already rejected the race.
            if (error instanceof Error && error.name === 'AbortError') {
              // Aborted because a winner was found; not a failure.
              return;
            }
            pool.reportFailure(index, 0);
            recordFailure({ index, status: 0, message: String(error) });
          }
        })();
      }
    });
  }
}
