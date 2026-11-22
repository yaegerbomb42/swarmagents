/**
 * Model discovery and connection probes for configured providers.
 *
 * Everything here runs server-side. The API key is used only in request
 * headers; it is never included in a returned URL, model id or error message.
 * Parsing helpers are exported and pure so they can be unit-tested with fixture
 * payloads from every upstream shape.
 */

import {
  apiStyleFor,
  authHeadersFor,
  baseUrlFor,
  endpoint,
  httpError,
  parseResponse,
} from "./adapters";
import { ProviderError, redact } from "./errors";
import { guardStreamTimeouts } from "./stream";
import type { ModelCapabilities, ProviderConfig } from "./types";

export interface DiscoveredModel {
  id: string;
  capabilities?: ModelCapabilities;
  contextWindow?: number;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
  /** Endpoint that was queried (no credentials, no key material). */
  endpoint: string;
}

export interface TestConnectionResult {
  ok: true;
  model: string;
  text: string;
  latencyMs: number;
  endpoint: string;
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

function dedupeSorted(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** OpenAI-compatible `GET /v1/models` (OpenAI, Groq, Mistral, vLLM, ...). */
export function parseOpenAIModels(body: unknown): string[] {
  const root = asRecord(body) ?? {};
  const data = Array.isArray(root.data) ? root.data : [];
  return dedupeSorted(
    data.map((raw) => {
      const entry = asRecord(raw);
      return typeof entry?.id === "string" ? entry.id : "";
    }),
  );
}

/** Anthropic `GET /v1/models` (also `{data:[{id}]}`). */
export function parseAnthropicModels(body: unknown): string[] {
  return parseOpenAIModels(body);
}

/** Gemini `GET /v1beta/models`; only models that support generateContent. */
export function parseGeminiModels(body: unknown): string[] {
  const root = asRecord(body) ?? {};
  const models = Array.isArray(root.models) ? root.models : [];
  const ids: string[] = [];
  for (const raw of models) {
    const entry = asRecord(raw);
    if (!entry || typeof entry.name !== "string") continue;
    const methods = strings(entry.supportedGenerationMethods).map((m) => m.toLowerCase());
    if (!methods.includes("generatecontent")) continue;
    ids.push(entry.name.replace(/^models\//, ""));
  }
  return dedupeSorted(ids);
}

export interface OllamaTag {
  id: string;
  size?: number;
  family?: string;
  parameterSize?: string;
}

/** Ollama `GET /api/tags`. */
export function parseOllamaTags(body: unknown): OllamaTag[] {
  const root = asRecord(body) ?? {};
  const models = Array.isArray(root.models) ? root.models : [];
  const out: OllamaTag[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const entry = asRecord(raw);
    const id = typeof entry?.name === "string" ? entry.name : typeof entry?.model === "string" ? entry.model : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const details = asRecord(entry?.details);
    out.push({
      id,
      ...(typeof entry?.size === "number" ? { size: entry.size } : {}),
      ...(typeof details?.family === "string" ? { family: details.family } : {}),
      ...(typeof details?.parameter_size === "string" ? { parameterSize: details.parameter_size } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface OllamaShowInfo {
  capabilities: ModelCapabilities;
  contextWindow?: number;
}

/** Heuristic from `details.family` when `/api/show` omits `capabilities`. */
function ollamaFamilyHasVision(family: string | undefined): boolean {
  if (!family) return false;
  return /(llava|vision|vl|pixtral|internvl|minicpm-v|gemma3|qwen2\.?5?-vl|moondream)/i.test(family);
}

/**
 * Ollama `POST /api/show` -> capabilities. Newer servers return
 * `capabilities: ["completion","tools","vision"]`; older ones only expose model
 * info and the family name, which we use conservatively.
 */
export function parseOllamaShow(body: unknown): OllamaShowInfo {
  const root = asRecord(body) ?? {};
  const caps = strings(root.capabilities).map((c) => c.toLowerCase());
  const details = asRecord(root.details);
  const modelInfo = asRecord(root.model_info) ?? {};
  const family = typeof details?.family === "string" ? details.family : undefined;

  let contextWindow: number | undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!key.endsWith(".context_length")) continue;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      contextWindow = Math.max(contextWindow ?? 0, value);
    }
  }
  const parameterContext = asRecord(root.parameters)?.num_ctx;
  if (contextWindow === undefined && typeof parameterContext === "number" && parameterContext > 0) {
    contextWindow = parameterContext;
  }

  const declared = caps.length > 0;
  const vision = declared ? caps.includes("vision") : ollamaFamilyHasVision(family);
  // Ollama advertises tool support explicitly on current versions. Older
  // servers have no capabilities list; most chat models can call tools, so we
  // keep the conservative default of true unless the family is an embedding.
  const tools = declared
    ? caps.includes("tools")
    : !/(embed|whisper|tts)/i.test(family ?? "");
  const embedding = declared && caps.every((c) => c === "embedding");
  return {
    capabilities: {
      vision: vision && !embedding,
      tools: tools && !embedding,
      computerUse: vision && tools && !embedding,
      ...(contextWindow ? { contextWindow } : {}),
      source: "discovery",
    },
    ...(contextWindow ? { contextWindow } : {}),
  };
}

function discoveryUrl(config: ProviderConfig): { url: string; method: "GET" | "POST" } {
  const base = baseUrlFor(config);
  switch (apiStyleFor(config)) {
    case "ollama":
      return { url: endpoint(base, "/api/tags"), method: "GET" };
    case "gemini":
      return { url: endpoint(base, "/v1beta/models"), method: "GET" };
    case "anthropic":
      return { url: endpoint(base, "/v1/models"), method: "GET" };
    default:
      return { url: endpoint(base, "/v1/models"), method: "GET" };
  }
}

async function requestWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: ProbeOptions,
): Promise<Response> {
  if (options.signal) return fetchImpl(url, init);
  const timeoutMs = options.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  if (!response.body) {
    clearTimeout(timer);
    return response;
  }
  // The deadline covers the body read too (FIX-06): the guard errors the
  // stream when the remaining budget runs out, and settling it clears the
  // abort timer so a completed probe leaves nothing armed.
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  const guarded = guardStreamTimeouts(response.body, {
    firstByteMs: remainingMs,
    idleMs: remainingMs,
    onSettle: () => clearTimeout(timer),
  });
  return new Response(guarded, response);
}

async function errorFromResponse(
  config: ProviderConfig,
  apiKey: string,
  response: Response,
): Promise<ProviderError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  return httpError(config, apiKey, response, text, Date.now());
}

/** List models from the provider's native discovery endpoint. */
export async function discoverProviderModels(
  config: ProviderConfig,
  apiKey: string,
  options: ProbeOptions = {},
): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const style = apiStyleFor(config);
  const { url } = discoveryUrl(config);
  const headers = authHeadersFor(config, apiKey);

  const response = await requestWithTimeout(
    fetchImpl,
    url,
    { method: "GET", headers },
    options,
  );
  if (!response.ok) throw await errorFromResponse(config, apiKey, response);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProviderError(`Invalid model list from ${config.id}`, {
      provider: config.id,
      kind: "invalid_response",
      retryable: false,
    });
  }

  if (style === "ollama") {
    const tags = parseOllamaTags(body);
    const models: DiscoveredModel[] = await Promise.all(
      tags.map(async (tag): Promise<DiscoveredModel> => {
        try {
          const showResponse = await requestWithTimeout(
            fetchImpl,
            endpoint(baseUrlFor(config), "/api/show"),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ model: tag.id }),
            },
            options,
          );
          if (!showResponse.ok) return { id: tag.id };
          const showBody = await showResponse.json();
          const info = parseOllamaShow(showBody);
          return {
            id: tag.id,
            capabilities: info.capabilities,
            ...(info.contextWindow ? { contextWindow: info.contextWindow } : {}),
          };
        } catch {
          // One unreadable model must not fail the whole discovery sweep.
          return { id: tag.id };
        }
      }),
    );
    return { models: models.sort((a, b) => a.id.localeCompare(b.id)), endpoint: url };
  }

  const ids =
    style === "gemini"
      ? parseGeminiModels(body)
      : style === "anthropic"
        ? parseAnthropicModels(body)
        : parseOpenAIModels(body);
  return { models: ids.map((id) => ({ id })), endpoint: url };
}

/** Resolve the model to probe with: explicit, then configured tier, then list. */
export function probeModelFor(config: ProviderConfig, explicit?: string): string | undefined {
  if (explicit && explicit.trim()) return explicit.trim();
  const tier = config.models?.balanced ?? config.models?.fast ?? config.models?.deep;
  if (tier) return tier;
  return config.availableModels?.[0];
}

function probeRequest(
  config: ProviderConfig,
  model: string,
): { url: string; body: unknown } {
  const base = baseUrlFor(config);
  switch (apiStyleFor(config)) {
    case "anthropic":
      return {
        url: endpoint(base, "/v1/messages"),
        body: {
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "ping" }],
        },
      };
    case "openai-responses":
      return {
        url: endpoint(base, "/v1/responses"),
        body: { model, input: "ping", max_output_tokens: 16 },
      };
    case "gemini":
      return {
        url: endpoint(base, `/v1beta/models/${encodeURIComponent(model)}:generateContent`),
        body: {
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 16 },
        },
      };
    case "ollama":
      return {
        url: endpoint(base, "/api/chat"),
        body: {
          model,
          messages: [{ role: "user", content: "ping" }],
          stream: false,
          options: { num_predict: 16 },
        },
      };
    default:
      return {
        url: endpoint(base, "/v1/chat/completions"),
        body: {
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 16,
        },
      };
  }
}

/**
 * Send a tiny non-streaming completion and report a short, redacted preview.
 * Failures surface as typed ProviderErrors the API route can return safely.
 */
export async function testProviderConnection(
  config: ProviderConfig,
  apiKey: string,
  options: ProbeOptions & { model?: string } = {},
): Promise<TestConnectionResult> {
  const model = probeModelFor(config, options.model);
  if (!model) {
    throw new ProviderError("Choose a model before testing the connection.", {
      provider: config.id,
      kind: "bad_request",
      retryable: false,
    });
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const { url, body } = probeRequest(config, model);
  const started = Date.now();
  const response = await requestWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: authHeadersFor(config, apiKey),
      body: JSON.stringify(body),
    },
    options,
  );
  const latencyMs = Date.now() - started;
  if (!response.ok) throw await errorFromResponse(config, apiKey, response);

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ProviderError(`Invalid response from ${config.id}: body was not JSON`, {
      provider: config.id,
      kind: "invalid_response",
      retryable: false,
    });
  }

  let text = "";
  try {
    text = parseResponse(config, parsed, model).text;
  } catch {
    // A successful HTTP response with no text (e.g. a tool-only reply) still
    // proves the endpoint, auth and model work; the preview stays empty.
  }
  return {
    ok: true,
    model,
    text: redact(text.slice(0, 200), [apiKey]),
    latencyMs,
    endpoint: url,
  };
}
