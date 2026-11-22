import { ProviderError, classifyStatus, isRetryableKind, parseRetryAfter, redact } from "./errors";
import { catalogEntry } from "./catalog";
import type {
  ApiStyle,
  AuthScheme,
  CompleteRequest,
  ContentBlock,
  FetchInit,
  Message,
  ModelTier,
  PerplexityEffort,
  ProviderAuth,
  ProviderConfig,
  ProviderKind,
  TextBlock,
  TokenUsage,
} from "./types";
import { isModelTier, isPerplexityEffort } from "./types";
import { parseReportedCostUsd } from "./wire-shims";

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
};

/** Base URL for a style when the provider has no catalog/known host. */
export const DEFAULT_STYLE_BASE_URL: Record<ApiStyle, string> = {
  "openai-chat": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434",
};

/** Canonical wire style for a provider config (legacy configs derive from kind). */
export function apiStyleFor(config: Pick<ProviderConfig, "kind" | "apiStyle" | "id">): ApiStyle {
  if (config.apiStyle) return config.apiStyle;
  if (config.kind === "anthropic") return "anthropic";
  if (config.kind === "gemini") return "gemini";
  return "openai-chat";
}

/** Does this style use the Anthropic Messages wire format? */
export function isAnthropicStyle(
  config: Pick<ProviderConfig, "kind" | "apiStyle" | "id">
): boolean {
  return apiStyleFor(config) === "anthropic";
}

/**
 * The Perplexity Agent API effort level to send for this config, if any.
 * `effort` is a Perplexity-only request field, so every other provider's
 * requests are left untouched even if a stray value was saved (or a config
 * file was hand-edited to an invalid one).
 */
export function perplexityEffortFor(
  config: Pick<ProviderConfig, "id" | "effort">
): PerplexityEffort | undefined {
  if (config.id !== "perplexity") return undefined;
  return isPerplexityEffort(config.effort) ? config.effort : undefined;
}

/** Credential placement for a provider, defaulting sensibly per provider. */
export function authFor(config: Pick<ProviderConfig, "kind" | "auth" | "id" | "apiStyle">): ProviderAuth {
  if (config.auth) return config.auth;
  // Native Ollama servers take no credential; a proxied one can opt in via
  // an explicit `auth`. Check the style before the catalog so a custom
  // provider (id "custom") reusing the Ollama wire does not inherit bearer.
  if (config.apiStyle === "ollama") return { scheme: "none" };
  const entry = catalogEntry(config.id);
  if (entry?.auth) return entry.auth;
  if (config.kind === "anthropic") return { scheme: "x-api-key" };
  if (config.kind === "gemini") return { scheme: "x-goog-api-key" };
  if (entry?.authHeader === "none") return { scheme: "none" };
  if (entry?.authHeader === "x-api-key") return { scheme: "x-api-key" };
  if (entry?.authHeader === "x-goog-api-key") return { scheme: "x-goog-api-key" };
  if (entry?.authHeader === "custom") {
    return {
      scheme: "custom-header",
      headerName: config.id === "azure-openai" ? "api-key" : "Authorization",
    };
  }
  return { scheme: "bearer" };
}

export function authSchemeFor(config: Pick<ProviderConfig, "kind" | "auth" | "id" | "apiStyle">): AuthScheme {
  return authFor(config).scheme;
}

/** Default base URL for a provider config. */
export function baseUrlFor(config: Pick<ProviderConfig, "kind" | "apiStyle" | "id" | "baseUrl">): string {
  if (config.baseUrl) return config.baseUrl;
  const entry = catalogEntry(config.id);
  if (entry?.baseUrl) return entry.baseUrl;
  return DEFAULT_STYLE_BASE_URL[apiStyleFor(config)] ?? DEFAULT_BASE_URLS[config.kind];
}

export const DEFAULT_MODELS: Record<ProviderKind, Record<ModelTier, string>> = {
  anthropic: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-4-5",
    deep: "claude-opus-4-1",
  },
  openai: {
    fast: "gpt-4.1-mini",
    balanced: "gpt-4.1",
    deep: "o3",
  },
  gemini: {
    fast: "gemini-2.5-flash",
    balanced: "gemini-2.5-pro",
    deep: "gemini-2.5-pro",
  },
};

/** The only request fields model resolution reads. */
export type ModelRequest = Pick<CompleteRequest, "model" | "tier">;

export function resolveTier(request: ModelRequest): ModelTier {
  if (request.tier) return request.tier;
  if (request.model && isModelTier(request.model)) return request.model;
  return "balanced";
}

export function modelForTier(config: ProviderConfig, tier: ModelTier): string {
  return config.models?.[tier] ?? DEFAULT_MODELS[config.kind][tier];
}

export function resolveModel(config: ProviderConfig, request: ModelRequest): string {
  if (request.model && !isModelTier(request.model)) return request.model;
  return modelForTier(config, resolveTier(request));
}

function toBlocks(message: Message): ContentBlock[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1") && path.startsWith("/v1/")) return base + path.slice(3);
  if (base.endsWith("/v1beta") && path.startsWith("/v1beta/")) {
    return base + path.slice("/v1beta".length);
  }
  return base + path;
}

function anthropicBody(
  config: ProviderConfig,
  model: string,
  request: CompleteRequest,
  stream: boolean
) {
  void config;
  const breakpoints = request.cacheBreakpoints;
  // Explicit cache breakpoints (CacheAwarePromptBuilder): one after the
  // system prompt (Zone 0), one after the first message (Zone 1), one
  // after the second-to-last message. Each lands on the last content
  // block of its message. Without breakpoints this is byte-identical to
  // today's body: system stays a plain string.
  const messages = request.messages.map((message, index) => {
    const blocks = toBlocks(message);
    const isBreakpoint =
      (breakpoints?.firstMessage === true && index === 0) ||
      (breakpoints?.secondLastMessage === true && index === request.messages.length - 2);
    if (!isBreakpoint || blocks.length === 0) return { role: message.role, content: blocks };
    const last = blocks[blocks.length - 1];
    return {
      role: message.role,
      content: [...blocks.slice(0, -1), { ...last, cache_control: { type: "ephemeral" } }],
    };
  });
  return {
    model,
    max_tokens: request.maxTokens ?? 1024,
    messages,
    ...(request.system
      ? {
          system:
            breakpoints?.system === true
              ? [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }]
              : request.system,
        }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function openaiContent(blocks: ContentBlock[]): string | Record<string, unknown>[] {
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => (block as TextBlock).text).join("");
  }
  return blocks.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : {
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        }
  );
}

function openaiBody(
  config: ProviderConfig,
  model: string,
  request: CompleteRequest,
  stream: boolean
) {
  void config;
  const messages: Record<string, unknown>[] = [];
  if (request.system) messages.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    messages.push({ role: message.role, content: openaiContent(toBlocks(message)) });
  }
  return {
    model,
    messages,
    max_tokens: request.maxTokens ?? 1024,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function geminiParts(blocks: ContentBlock[]): Record<string, unknown>[] {
  return blocks.map((block) =>
    block.type === "text"
      ? { text: block.text }
      : {
          inlineData: {
            mimeType: block.source.media_type,
            data: block.source.data,
          },
        }
  );
}

function geminiBody(config: ProviderConfig, model: string, request: CompleteRequest) {
  void config;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: request.maxTokens ?? 1024,
  };
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;

  return {
    contents: request.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: geminiParts(toBlocks(message)),
    })),
    generationConfig,
    ...(request.system
      ? { systemInstruction: { parts: [{ text: request.system }] } }
      : {}),
  };
}

function responsesContent(blocks: ContentBlock[]): Record<string, unknown>[] {
  return blocks.map((block) =>
    block.type === "text"
      ? { type: "input_text", text: block.text }
      : {
          type: "input_image",
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        }
  );
}

function responsesBody(config: ProviderConfig, model: string, request: CompleteRequest, stream: boolean) {
  const effort = perplexityEffortFor(config);
  const input: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    input.push({
      role: message.role,
      content: responsesContent(toBlocks(message)),
    });
  }
  return {
    model,
    input,
    max_output_tokens: request.maxTokens ?? 1024,
    // Perplexity Agent API effort level (top-level `effort`); unset keeps the
    // model-only request shape every other Responses provider expects.
    ...(effort ? { effort } : {}),
    ...(request.system ? { instructions: request.system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function ollamaBody(config: ProviderConfig, model: string, request: CompleteRequest, stream: boolean) {
  void config;
  const messages: Record<string, unknown>[] = [];
  if (request.system) messages.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    const blocks = toBlocks(message);
    const text = blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
    const images = blocks
      .filter((b) => b.type === "image")
      .map((b) => (b as Extract<ContentBlock, { type: "image" }>).source.data);
    messages.push({
      role: message.role,
      content: text,
      ...(images.length > 0 ? { images } : {}),
    });
  }
  return {
    model,
    messages,
    stream,
    options: {
      num_predict: request.maxTokens ?? 1024,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    },
  };
}

function headerName(value: string | undefined, fallback: string): string {
  const name = (value ?? "").trim();
  return /^[A-Za-z0-9-]+$/.test(name) ? name : fallback;
}

/** Build the request headers for a provider key, honoring its auth scheme. */
export function authHeadersFor(
  config: ProviderConfig,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...config.headers,
  };
  const auth = authFor(config);
  const key = apiKey.trim();
  switch (auth.scheme) {
    case "none":
      break;
    case "bearer":
      if (key) headers.authorization = `Bearer ${key}`;
      break;
    case "x-api-key":
      if (key) headers["x-api-key"] = key;
      if (apiStyleFor(config) === "anthropic") headers["anthropic-version"] = "2023-06-01";
      break;
    case "x-goog-api-key":
      if (key) headers["x-goog-api-key"] = key;
      break;
    case "basic":
      if (key) headers.authorization = `Basic ${Buffer.from(key, "utf8").toString("base64")}`;
      break;
    case "custom-header": {
      const name = headerName(auth.headerName, "Authorization").toLowerCase();
      if (key) headers[name] = key;
      break;
    }
  }
  return headers;
}

/** Back-compat alias for the old private helper. */
export const headersFor = authHeadersFor;

/** Provider-specific URL for one request. */
export function requestUrl(
  config: ProviderConfig,
  model: string,
  stream = false,
): string {
  const baseUrl = baseUrlFor(config);
  switch (apiStyleFor(config)) {
    case "anthropic":
      return endpoint(baseUrl, "/v1/messages");
    case "openai-responses":
      return endpoint(baseUrl, "/v1/responses");
    case "ollama":
      return endpoint(baseUrl, "/api/chat");
    case "gemini": {
      const path = stream
        ? `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
        : `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      return endpoint(baseUrl, path);
    }
    default:
      return endpoint(baseUrl, "/v1/chat/completions");
  }
}

/** Build the provider-specific HTTP request for one model/key pair. */
export function buildRequest(
  config: ProviderConfig,
  apiKey: string,
  model: string,
  request: CompleteRequest,
  signal?: AbortSignal,
  stream = false
): { url: string; init: FetchInit } {
  const headers = authHeadersFor(config, apiKey);
  if (stream) {
    headers.accept =
      apiStyleFor(config) === "ollama" ? "application/x-ndjson" : "text/event-stream";
  }
  const init: FetchInit = {
    method: "POST",
    headers,
    ...(signal ? { signal } : {}),
  };
  const style = apiStyleFor(config);

  let body: unknown;
  switch (style) {
    case "anthropic":
      body = anthropicBody(config, model, request, stream);
      break;
    case "openai-responses":
      body = responsesBody(config, model, request, stream);
      break;
    case "ollama":
      body = ollamaBody(config, model, request, stream);
      break;
    case "gemini":
      body = geminiBody(config, model, request);
      break;
    default:
      body = openaiBody(config, model, request, stream);
  }

  return { url: requestUrl(config, model, stream), init: { ...init, body: JSON.stringify(body) } };
}

export { endpoint };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface ParsedCompletion {
  text: string;
  model: string;
  usage: TokenUsage;
}

function invalidResponse(provider: string, detail: string): ProviderError {
  return new ProviderError(`Invalid response from ${provider}: ${detail}`, {
    provider,
    kind: "invalid_response",
    retryable: false,
  });
}

function requireText(provider: string, text: string): string {
  if (!text.trim()) throw invalidResponse(provider, "no text content");
  return text;
}

export function parseResponse(
  config: ProviderConfig,
  body: unknown,
  requestedModel: string
): ParsedCompletion {
  const root = asRecord(body);
  if (!root) throw invalidResponse(config.id, "response body was not an object");
  const style = apiStyleFor(config);

  if (style === "anthropic") {
    const content = Array.isArray(root.content) ? root.content : [];
    const text = content
      .map((part) => {
        const block = asRecord(part);
        return block?.type === "text" ? asString(block.text) ?? "" : "";
      })
      .join("");
    const usage = asRecord(root.usage);
    return {
      text: requireText(config.id, text),
      model: asString(root.model) ?? requestedModel,
      usage: {
        inputTokens: asNumber(usage?.input_tokens) ?? 0,
        outputTokens: asNumber(usage?.output_tokens) ?? 0,
        ...(asNumber(usage?.cache_read_input_tokens) !== undefined
          ? { cachedInputTokens: asNumber(usage?.cache_read_input_tokens) }
          : {}),
        ...(asNumber(usage?.cache_creation_input_tokens) !== undefined
          ? { cacheWriteTokens: asNumber(usage?.cache_creation_input_tokens) }
          : {}),
      },
    };
  }

  if (style === "openai-chat") {
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]);
    const message = asRecord(first?.message);
    const rawContent = message?.content;
    let text = "";
    if (typeof rawContent === "string") {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      text = rawContent
        .map((part) => {
          const block = asRecord(part);
          return asString(block?.text) ?? "";
        })
        .join("");
    }
    const usage = asRecord(root.usage);
    // xAI reports the exact billed cost as usage.cost_in_usd_ticks on chat
    // completions (docs.x.ai/developers/cost-tracking); parseReportedCostUsd
    // also recognizes the Perplexity cost object / flattened numeric cost
    // defensively. Absent or malformed -> undefined -> usage unchanged.
    const reportedCost = parseReportedCostUsd(usage);
    const cached = asNumber(asRecord(usage?.prompt_tokens_details)?.cached_tokens);
    return {
      text: requireText(config.id, text),
      model: asString(root.model) ?? requestedModel,
      usage: {
        inputTokens: asNumber(usage?.prompt_tokens) ?? 0,
        outputTokens: asNumber(usage?.completion_tokens) ?? 0,
        ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
        ...(reportedCost !== undefined ? { costUsd: reportedCost } : {}),
      },
    };
  }

  if (style === "openai-responses") {
    // Responses API: a top-level output_text convenience field, or the
    // output[] array of message/function_call items.
    const direct = asString(root.output_text);
    let text = direct ?? "";
    if (!text && Array.isArray(root.output)) {
      for (const item of root.output) {
        const entry = asRecord(item);
        if (!entry) continue;
        if (entry.type === "message" && Array.isArray(entry.content)) {
          for (const part of entry.content) {
            const block = asRecord(part);
            if (block?.type === "output_text" || block?.type === "text") {
              text += asString(block.text) ?? "";
            }
          }
        }
      }
    }
    const usage = asRecord(root.usage);
    const reportedCost = parseReportedCostUsd(usage);
    const cached =
      asNumber(asRecord(usage?.input_tokens_details)?.cached_tokens) ??
      asNumber(asRecord(usage?.prompt_tokens_details)?.cached_tokens);
    return {
      text: requireText(config.id, text),
      model: asString(root.model) ?? requestedModel,
      usage: {
        inputTokens: asNumber(usage?.input_tokens) ?? 0,
        outputTokens: asNumber(usage?.output_tokens) ?? 0,
        ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
        ...(reportedCost !== undefined ? { costUsd: reportedCost } : {}),
      },
    };
  }

  if (style === "ollama") {
    const message = asRecord(root.message);
    const text = asString(message?.content) ?? "";
    const evalCount = asNumber(root.eval_count);
    const promptCount = asNumber(root.prompt_eval_count);
    return {
      text: requireText(config.id, text),
      model: asString(root.model) ?? requestedModel,
      usage: {
        inputTokens: promptCount ?? 0,
        outputTokens: evalCount ?? 0,
      },
    };
  }

  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const first = asRecord(candidates[0]);
  const content = asRecord(first?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts
    .map((part) => asString(asRecord(part)?.text) ?? "")
    .join("");
  const usage = asRecord(root.usageMetadata);
  const cached = asNumber(usage?.cachedContentTokenCount);
  return {
    text: requireText(config.id, text),
    model: asString(root.modelVersion) ?? requestedModel,
    usage: {
      inputTokens: asNumber(usage?.promptTokenCount) ?? 0,
      outputTokens: asNumber(usage?.candidatesTokenCount) ?? 0,
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    },
  };
}

/** Convert a non-2xx provider response into a redacted, classified error. */
export function httpError(
  config: ProviderConfig,
  apiKey: string,
  response: { status: number; headers: { get(name: string): string | null } },
  body: string,
  now: number
): ProviderError {
  const kind = classifyStatus(response.status);
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now);
  const detail = redact(body.slice(0, 500).trim(), [apiKey]);
  const suffix = detail ? `: ${detail}` : "";
  return new ProviderError(`HTTP ${response.status} from ${config.id}${suffix}`, {
    provider: config.id,
    kind,
    status: response.status,
    retryable: isRetryableKind(kind),
    retryAfterMs,
  });
}
