import { apiStyleFor, authFor, buildRequest, modelForTier } from "./adapters";
import { classifyStatus, errorMessage, redact } from "./errors";
import type { ProbeErrorClass } from "./errors";
import type { FetchLike, ProviderConfig, ProviderErrorKind } from "./types";

export interface ProviderHealth {
  id: string;
  ok: boolean;
  /**
   * Round-trip time of the probe in ms, or null when no request was made
   * (e.g. no keys configured) so callers never see an epoch-sized value.
   */
  latencyMs: number | null;
  checkedAt: number;
  error?: string;
  /** True when no probe result exists yet for this provider. */
  checking?: boolean;
  /** Finer failure kind (auth, rate_limit, …) when the probe classified one. */
  errorKind?: ProviderErrorKind;
  /** Coarse failure class for UI rendering: auth / network / rate-limit / unknown. */
  errorClass?: ProbeErrorClass;
  /** HTTP status the provider answered with, when it answered at all. */
  status?: number;
  /** The model the probe actually called. */
  model?: string;
}

export interface HealthCheckerOptions {
  providers: ProviderConfig[];
  fetch?: FetchLike;
  /** Interval between checks in ms. Default 30_000. */
  intervalMs?: number;
  /** Jitter fraction (0-1). Default 0.2. */
  jitter?: number;
  /** Timeout for each health check request in ms. Default 10_000. */
  timeoutMs?: number;
  /** Environment source for SWARM_KEYS_<PROVIDER>. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injectable clock, primarily for deterministic tests. */
  now?: () => number;
  /**
   * Called when a provider fails a health check so the callee can put keys on
   * cooldown. The first argument is the provider id and the second is a
   * suggested cooldown duration in ms derived from the configured interval.
   */
  onUnhealthy?: (providerId: string, cooldownMs: number) => void;
}

function dedupe(keys: string[]): string[] {
  return Array.from(new Set(keys.map((k) => k.trim()).filter(Boolean)));
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

const PING_MESSAGES = [{ role: "user" as const, content: "ping" }];

/**
 * Output tokens requested by the probe. More than 1 so reasoning models,
 * which spend their first tokens thinking, still have room to reply — and
 * small enough that the probe stays cheap.
 */
const PING_MAX_TOKENS = 16;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Clear label for the HTTP statuses the probe is most likely to hit, so a
 * dead key or an empty wallet is not reported as a generic failure.
 */
function httpStatusLabel(status: number): string {
  switch (status) {
    case 401:
      return "HTTP 401 (Unauthorized — invalid or revoked key)";
    case 402:
      return "HTTP 402 (Payment required — billing or credits exhausted)";
    case 429:
      return "HTTP 429 (Rate limited — too many requests)";
    default:
      return `HTTP ${status}`;
  }
}

/**
 * Lenient shape check for a 2xx completion body. A health probe only needs
 * to know the provider answered with a well-formed completion — it must NOT
 * require text content: reasoning models can legitimately return an empty
 * message (reasoning-only, or cut off by the small token budget) while
 * serving live traffic fine. Returns a human-readable problem, or null when
 * the body is well-formed.
 */
function completionProblem(config: ProviderConfig, body: unknown): string | null {
  const root = asRecord(body);
  if (!root) return "response body was not an object";
  const err = asRecord(root.error);
  if (err) {
    const message = typeof err.message === "string" ? err.message : "";
    return message ? `provider error: ${message}` : "provider returned an error object";
  }
  const style = apiStyleFor(config);
  if (style === "anthropic") {
    if (!Array.isArray(root.content)) return "missing content array";
    return null;
  }
  if (style === "openai-responses") {
    if (typeof root.output_text === "string") return null;
    if (!Array.isArray(root.output)) return "missing output array";
    return null;
  }
  if (style === "ollama") {
    if (asRecord(root.message) === undefined && root.done !== true) {
      return "missing message object";
    }
    return null;
  }
  if (style === "openai-chat") {
    const choices = root.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return "missing choices array";
    }
    const first = asRecord(choices[0]);
    if (!first) return "malformed choice";
    // Chat completions carry `message`; reasoning-only replies may carry
    // only `reasoning_content`/`reasoning`; legacy completions carry `text`.
    const message = asRecord(first.message);
    const delta = asRecord(first.delta);
    const hasContent =
      message !== undefined ||
      delta !== undefined ||
      typeof first.text === "string" ||
      typeof first.reasoning_content === "string" ||
      typeof first.reasoning === "string";
    if (!hasContent) return "choice has no message, delta, text, or reasoning";
    return null;
  }
  // gemini
  const candidates = root.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return "missing candidates array";
  }
  return null;
}

function jitteredDelay(intervalMs: number, jitter: number): number {
  const jitterMs = intervalMs * jitter * (Math.random() * 2 - 1);
  return Math.max(1000, intervalMs + jitterMs);
}

/**
 * Periodically pings LLM providers with a cheap model call to detect dead
 * endpoints before user requests reach them.
 *
 * When a provider fails, the optional `onUnhealthy` callback is invoked so
 * callers (e.g. a Router) can put the provider's keys on cooldown, which
 * naturally excludes the provider from routing.
 */
export class HealthChecker {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly jitter: number;
  private readonly timeoutMs: number;
  private readonly env: Record<string, string | undefined>;
  /** Every provider passed to the checker (used for single-provider checks). */
  private readonly allProviders: ProviderConfig[];
  /** Enabled providers, used by the periodic sweep. */
  private readonly providers: ProviderConfig[];
  private readonly onUnhealthy?: (providerId: string, cooldownMs: number) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly results = new Map<string, ProviderHealth>();
  /** Promise for the first check round, if one has started. */
  private firstCheck: Promise<void> | null = null;
  private firstCheckSettled = false;
  /** Whether the periodic sweep has been armed off the first check. */
  private scheduleArmed = false;

  constructor(options: HealthCheckerOptions) {
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new Error("No fetch implementation is available for the health checker");
    }
    this.fetchImpl = fetchImpl;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.jitter = options.jitter ?? 0.2;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.env = options.env ?? process.env;
    this.allProviders = options.providers;
    this.providers = options.providers.filter((c) => c.enabled !== false);
    this.onUnhealthy = options.onUnhealthy;
  }

  /** Latest per-provider health snapshot. */
  get snapshot(): ProviderHealth[] {
    return Array.from(this.results.values());
  }

  /**
   * One entry per enabled provider. Providers with no probe result yet are
   * reported as `checking` instead of being silently absent, so a first
   * response always covers every configured provider.
   */
  fullSnapshot(): ProviderHealth[] {
    const checkedAt = this.now();
    return this.providers.map((p) => {
      const existing = this.results.get(p.id);
      if (existing) return existing;
      return {
        id: p.id,
        ok: false,
        latencyMs: null,
        checkedAt,
        checking: true,
        error: "Check in progress",
      };
    });
  }

  /**
   * Await the first check round (starting one if none is running). Resolves
   * immediately once a round has completed, so later callers pay nothing.
   * Individual probes are bounded by `timeoutMs`, so this cannot hang
   * longer than one probe timeout plus overhead.
   */
  async ensureChecked(): Promise<void> {
    if (this.firstCheckSettled) return;
    if (!this.firstCheck) {
      this.firstCheck = this.checkAll().finally(() => {
        this.firstCheckSettled = true;
      });
    }
    await this.firstCheck;
  }

  /** Begin periodic checks. The first check runs immediately. */
  start(): void {
    if (this.timer || this.stopped) return;
    if (!this.firstCheck) {
      this.firstCheck = this.checkAll().finally(() => {
        this.firstCheckSettled = true;
      });
    }
    if (!this.scheduleArmed) {
      this.scheduleArmed = true;
      void this.firstCheck.finally(() => {
        if (!this.stopped) this.scheduleNext();
      });
    }
  }

  /** Stop periodic checks. Safe to call multiple times. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Run one health-check round for every configured provider. */
  async checkAll(): Promise<void> {
    await Promise.all(this.providers.map((p) => this.checkOne(p)));
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.checkAll().finally(() => {
        if (!this.stopped) this.scheduleNext();
      });
    }, jitteredDelay(this.intervalMs, this.jitter));
    // A background sweep must not keep a process (or a test run) alive.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async checkOne(config: ProviderConfig): Promise<ProviderHealth> {
    const keys = loadKeys(config, this.env);
    const keyless =
      apiStyleFor(config) === "ollama" ||
      authFor(config).scheme === "none";
    if (keys.length === 0 && !keyless) {
      // No request is made, so there is no duration to report.
      return this.recordFailure(config.id, null, "No keys configured");
    }

    const model =
      config.models?.fast ??
      config.models?.balanced ??
      config.availableModels?.[0] ??
      modelForTier(config, "fast");
    const key = keys[0] ?? "";
    const { url, init } = buildRequest(
      config,
      key,
      model,
      { messages: PING_MESSAGES, maxTokens: PING_MAX_TOKENS },
      undefined
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = this.now();

    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const detail = body
          ? `: ${redact(body.slice(0, 200), [key])}`
          : "";
        const errorKind = classifyStatus(response.status);
        return this.recordFailure(
          config.id,
          startedAt,
          `${httpStatusLabel(response.status)}${detail}`,
          {
            errorKind,
            errorClass:
              errorKind === "auth"
                ? "auth"
                : errorKind === "rate_limit" || errorKind === "quota_exhausted"
                  ? "rate-limit"
                  : errorKind === "server" || errorKind === "timeout"
                    ? "network"
                    : "unknown",
            status: response.status,
            model,
          }
        );
      }

      const body = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return this.recordFailure(config.id, startedAt, "Invalid response: body was not JSON", {
          errorKind: "invalid_response",
          errorClass: "unknown",
          status: response.status,
          model,
        });
      }
      // A health probe only needs a well-formed completion, not text: a
      // reasoning model may legitimately answer with empty content.
      const problem = completionProblem(config, json);
      if (problem) {
        return this.recordFailure(
          config.id,
          startedAt,
          `Invalid response from ${config.id}: ${problem}`,
          {
            errorKind: "invalid_response",
            errorClass: "unknown",
            status: response.status,
            model,
          }
        );
      }

      const result: ProviderHealth = {
        id: config.id,
        ok: true,
        latencyMs: this.now() - startedAt,
        checkedAt: this.now(),
        status: response.status,
        model,
      };
      this.results.set(config.id, result);
      return result;
    } catch (err) {
      clearTimeout(timeoutId);
      // A thrown fetch (DNS, connection, TLS, abort/timeout) is a network
      // failure — the provider never answered.
      return this.recordFailure(config.id, startedAt, errorMessage(err), {
        errorClass: "network",
        model,
      });
    }
  }

  private recordFailure(
    id: string,
    startedAt: number | null,
    error: string,
    extra?: Pick<ProviderHealth, "errorKind" | "errorClass" | "status" | "model">
  ): ProviderHealth {
    const latencyMs = startedAt === null ? null : this.now() - startedAt;
    const result: ProviderHealth = {
      id,
      ok: false,
      latencyMs,
      checkedAt: this.now(),
      error,
      ...(extra ?? {}),
    };
    this.results.set(id, result);
    const cooldownMs = Math.min(60_000, this.intervalMs * 2);
    this.onUnhealthy?.(id, cooldownMs);
    return result;
  }

  /**
   * Run the health probe for a single provider by id and return its result.
   * Unlike the periodic sweep, this checks any configured provider — even a
   * disabled one — so a user can verify a key they just added. Returns null
   * for an unknown provider.
   */
  async checkProvider(id: string): Promise<ProviderHealth | null> {
    const config = this.allProviders.find((p) => p.id === id);
    if (!config) return null;
    return this.checkOne(config);
  }
}
