// Shared types for the server-only LLM provider router.
// This module must never be imported into a client component.

export type ProviderKind = "anthropic" | "openai" | "gemini";

/**
 * Wire format a provider speaks. This is broader than ProviderKind: several
 * styles share the OpenAI wire kind while using a different endpoint or body
 * shape, and the native Ollama API is neither OpenAI nor Anthropic.
 */
export type ApiStyle =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "ollama";

export const API_STYLES: readonly ApiStyle[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
  "ollama",
];

export function isApiStyle(value: unknown): value is ApiStyle {
  return typeof value === "string" && (API_STYLES as readonly string[]).includes(value);
}

/** How the provider expects a credential on requests. */
export type AuthScheme =
  | "none"
  | "bearer"
  | "x-api-key"
  | "x-goog-api-key"
  | "custom-header"
  | "basic";

export const AUTH_SCHEMES: readonly AuthScheme[] = [
  "none",
  "bearer",
  "x-api-key",
  "x-goog-api-key",
  "custom-header",
  "basic",
];

export function isAuthScheme(value: unknown): value is AuthScheme {
  return typeof value === "string" && (AUTH_SCHEMES as readonly string[]).includes(value);
}

/**
 * Perplexity Agent API effort levels, lowest to highest intensity. An effort
 * level is a pre-configured model + system prompt + search parameters; it
 * replaces the retired Sonar model tiers (Sonar/Sonar Pro -> fast, Sonar
 * Reasoning Pro -> low, Sonar Deep Research -> high).
 * https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar
 */
export const PERPLEXITY_EFFORTS = ["fast", "low", "medium", "high", "xhigh"] as const;
export type PerplexityEffort = (typeof PERPLEXITY_EFFORTS)[number];

export function isPerplexityEffort(value: unknown): value is PerplexityEffort {
  return typeof value === "string" && (PERPLEXITY_EFFORTS as readonly string[]).includes(value);
}

export interface ProviderAuth {
  scheme: AuthScheme;
  /** Header name for `custom-header` (defaults to Authorization). */
  headerName?: string;
}

/**
 * What a model can do, used to decide how a run behaves. Presets provide
 * defaults, discovery (Ollama /api/show, provider model lists) refines them,
 * and the user can override any model by hand.
 */
export interface ModelCapabilities {
  vision: boolean;
  /** The model accepts tool/function definitions. */
  tools: boolean;
  /** The model can drive the desktop through computer-use tools. */
  computerUse: boolean;
  contextWindow?: number;
  /**
   * Hard cap on output tokens for one response, when known. The gateway
   * clamps Anthropic `max_tokens` to this before wire translation so an
   * oversized request is never rejected upstream. Undefined = no known
   * cap; the request value passes through unchanged.
   */
  maxOutputTokens?: number;
  source?: "preset" | "discovery" | "override";
}

/**
 * GUI = desktop + computer tools, text = headless sandbox tools,
 * text-desktop = desktop tools driven through text (describe_screen +
 * accessibility snapshots) for models without vision, chat = no tools.
 */
export type RunMode = "gui" | "text" | "text-desktop" | "chat";

/**
 * How multiple racing providers are started.
 * - "simultaneous": every racer starts at once; the first valid response wins.
 * - "hedged": the primary starts immediately; the next healthy provider starts
 *   only after a hedge delay if no first token has arrived yet. Whichever
 *   streams first wins and the losers are aborted.
 */
export type RaceMode = "simultaneous" | "hedged";

export const MODEL_TIERS = ["fast", "balanced", "deep"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export function isModelTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

/** A text content block in Anthropic's message format. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** A base64 image block in Anthropic's message format. */
export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type ContentBlock = TextBlock | ImageBlock;

export type MessageRole = "user" | "assistant";

/** Anthropic-shaped message used as the router's canonical input format. */
export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
}

export interface ProviderConfig {
  /** Stable, non-secret identifier, e.g. "anthropic" or "openrouter". */
  id: string;
  kind: ProviderKind;
  /** Wire format. Defaults to the one implied by `kind`/the catalog entry. */
  apiStyle?: ApiStyle;
  /** Optional custom credential placement. Defaults per style/provider. */
  auth?: ProviderAuth;
  /** Optional API root. Defaults to the provider's public host. */
  baseUrl?: string;
  /** Model per capability tier. Missing tiers fall back to built-in defaults. */
  models?: Partial<Record<ModelTier, string>>;
  /**
   * Every selectable model id (presets and discovered models). `models` maps
   * the fast/balanced/deep tiers; this is the full list the UI may pick from.
   */
  availableModels?: string[];
  /** Per-model capabilities. Merged over the preset/discovery defaults. */
  modelCapabilities?: Record<string, ModelCapabilities>;
  /** Lower ranks are tried first. */
  rank?: number;
  /** Explicit keys. When omitted, keys come from the environment. */
  keys?: string[];
  /** Override the environment variable that holds this provider's keys. */
  envKeys?: string;
  /** Extra request headers (for gateways / OpenAI-compatible proxies). */
  headers?: Record<string, string>;
  /** Per-request timeout. Defaults to the router's defaultTimeoutMs. */
  timeoutMs?: number;
  /**
   * Perplexity Agent API effort level. Only honored for the Perplexity
   * provider (rejected at save time for others); unset sends a model-only
   * request and lets the server apply its default.
   */
  effort?: PerplexityEffort;
  enabled?: boolean;
  /**
   * Free provider: estimated cost is billed as $0 and, when the user's
   * "Prefer free providers" setting is on, free providers are tried before
   * paid ones (rank is kept inside each group).
   */
  isFree?: boolean;
  /** Daily USD budget. When set alongside pricing, the router skips the provider once spent. */
  dailyBudgetUsd?: number;
  /** Input token price per 1M tokens, used for budget tracking. */
  inputPricePer1mTokens?: number;
  /** Output token price per 1M tokens, used for budget tracking. */
  outputPricePer1mTokens?: number;
}

export interface CompleteRequest {
  messages: Message[];
  system?: string;
  /** Capability tier. Defaults to "balanced". */
  tier?: ModelTier;
  /** Explicit model id, or a tier name as a shorthand. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Explicit cache breakpoints for a prefix-stable prompt, set by
   * CacheAwarePromptBuilder (lib/providers/cache-aware-prompt.ts).
   * Absent = today's behaviour (no markers). Only the Anthropic wire
   * format supports explicit breakpoints; adapters for other styles
   * ignore this field entirely, so the markers are stripped cleanly
   * by construction.
   */
  cacheBreakpoints?: CacheBreakpoints;
  signal?: AbortSignal;
  /**
   * Race up to this many ranked providers in parallel and take the first valid
   * response. 1 (or omitted) uses sequential failover.
   */
  race?: number;
  /**
   * Opt into race mode for this call. `true` uses the router's configured race
   * mode (or "hedged" by default); a string selects the mode explicitly; a
   * number uses hedged racing with that custom hedge delay in ms.
   *
   * When `race` is also set, `raceMode` takes precedence.
   */
  raceMode?: RaceMode;
  /**
   * Hedged racing: start the primary provider immediately, and if no first
   * token has arrived within `hedge` ms, start the next healthy provider. The
   * first provider to stream wins and the loser is aborted. `true` uses the
   * router's default hedge delay (env SWARM_HEDGE_DELAY_MS); a number
   * overrides the delay for this call. Defaults to the router's hedged race
   * mode when race mode is enabled.
   */
  hedge?: boolean | number;
}

/**
 * Explicit prompt-cache breakpoints for a prefix-stable prompt.
 * Set by CacheAwarePromptBuilder; read by the Anthropic body builder in
 * adapters.ts. Providers without explicit breakpoint support ignore it.
 */
export interface CacheBreakpoints {
  /** Breakpoint after the system prompt (Zone 0 boundary). */
  system?: boolean;
  /** Breakpoint after the first message (Zone 1 boundary). */
  firstMessage?: boolean;
  /** Breakpoint after the second-to-last message. */
  secondLastMessage?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Input tokens served from the provider's prompt cache on this call
   * (Anthropic `cache_read_input_tokens`, OpenAI `cached_tokens`,
   * Gemini `cachedContentTokenCount`). Absent = the provider reported none.
   */
  cachedInputTokens?: number;
  /**
   * Input tokens written to the provider's prompt cache on this call
   * (Anthropic `cache_creation_input_tokens`). Absent = none reported.
   */
  cacheWriteTokens?: number;
  /**
   * Provider-reported cost of this call in USD, when the response carried
   * one (e.g. the Perplexity Agent API's `usage.cost.total_cost`, xAI's
   * `usage.cost_in_usd_ticks`). Absent = the provider reported no cost;
   * cost then falls back to the price-table estimate (pricing.ts).
   */
  costUsd?: number;
}

export type ProviderErrorKind =
  | "rate_limit"
  | "auth"
  | "server"
  | "network"
  | "timeout"
  | "invalid_response"
  | "bad_request"
  | "aborted"
  | "budget_exhausted"
  | "quota_exhausted"
  | "unknown";

export interface AttemptInfo {
  provider: string;
  model: string;
  /** Safe key slot label (e.g. "key-1"), never the key itself. */
  keyId?: string;
  ok: boolean;
  status?: number;
  kind?: ProviderErrorKind;
  /** Redacted error summary. */
  error?: string;
  latencyMs: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  /** Safe key slot label, never the key itself. */
  keyId?: string;
  attempts: AttemptInfo[];
}

/** One incremental text chunk from a streamed completion. */
export interface StreamDelta {
  type: "delta";
  text: string;
  provider: string;
  model: string;
  /** Safe key slot label, never the key itself. */
  keyId?: string;
}

/** Terminal event emitted once a streamed completion has fully finished. */
export interface StreamDone {
  type: "done";
  text: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
  /** Safe key slot label, never the key itself. */
  keyId?: string;
  attempts: AttemptInfo[];
}

/**
 * Unified stream event, independent of the upstream provider wire format.
 * Consumers receive zero or more deltas followed by exactly one done event.
 */
export type StreamEvent = StreamDelta | StreamDone;

export interface KeyStat {
  /** Safe slot label, never the key itself. */
  id: string;
  available: boolean;
  /** Epoch ms at which the key becomes usable again, if cooling down. */
  cooldownUntil?: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  /** Moving average of successful request latency. */
  avgLatencyMs: number;
  lastStatus?: number;
  lastErrorKind?: string;
}

export interface ProviderStats {
  id: string;
  kind: ProviderKind;
  rank: number;
  models: Record<ModelTier, string>;
  keys: KeyStat[];
}

export interface RouterStats {
  totalRequests: number;
  succeeded: number;
  failed: number;
  providers: ProviderStats[];
}

/** Minimal fetch contract so tests and callers can inject their own client. */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
  /** SSE body for streaming requests. Providers may omit it (tests/mocks). */
  body?: ReadableStream<Uint8Array> | null;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;
