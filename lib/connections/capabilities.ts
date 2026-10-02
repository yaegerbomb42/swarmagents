import type { ProviderConfig } from "../types";

/** Resolve "{key}" placeholders in a connection's extra headers. */
export function resolveHeaders(p: Pick<ProviderConfig, "apiKey" | "headers">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.headers ?? {})) if (k.trim()) out[k.trim()] = String(v).split("{key}").join(p.apiKey ?? "");
  return out;
}

/**
 * Capability Detection & Model Discovery for Custom / BYOK Endpoints.
 * Probes endpoints for:
 * 1. Model discovery via GET /v1/models (with fallback to manual models)
 * 2. Streaming SSE support
 * 3. Tool / function calling capability
 * 4. Vision (multimodal image_url) capability
 */

export interface EndpointCapabilities {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  discoveredModels: string[];
  latencyMs: number;
}

export interface FriendlyError {
  type: "wrong_key" | "no_credits" | "bad_url" | "cors_ssl" | "model_not_found" | "rate_limited" | "timeout" | "ssrf_blocked" | "unknown";
  message: string;
  suggestedFix: string;
  statusCode?: number;
}

/** Map HTTP status codes and response bodies to actionable user messages with suggested fixes. */
export function mapProviderError(status: number | undefined, text: string, url: string): FriendlyError {
  const lower = text.toLowerCase();

  if (status === 401 || lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
    return {
      type: "wrong_key",
      message: "Authentication failed: the provided API key was rejected.",
      suggestedFix: "Double-check that the API key was copied correctly and has not been revoked or expired.",
      statusCode: status,
    };
  }

  if (status === 402 || lower.includes("insufficient_quota") || lower.includes("exceeded your current quota") || lower.includes("credit balance")) {
    return {
      type: "no_credits",
      message: "Insufficient quota or credits on this provider account.",
      suggestedFix: "Check your billing settings and add funds or credits to your provider balance.",
      statusCode: status,
    };
  }

  if (status === 404 || lower.includes("model_not_found") || lower.includes("does not exist")) {
    return {
      type: "model_not_found",
      message: "Model or endpoint path not found.",
      suggestedFix: "Verify the endpoint URL (ensure /v1 is included if required) and confirm the model name exists on this provider.",
      statusCode: status,
    };
  }

  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return {
      type: "rate_limited",
      message: "Rate limit exceeded on this provider.",
      suggestedFix: "Wait a moment for rate limits to reset, or request higher tier limits from the provider.",
      statusCode: status,
    };
  }

  if (lower.includes("enotfound") || lower.includes("econnrefused") || lower.includes("fetch failed") || status === 502 || status === 503) {
    return {
      type: "bad_url",
      message: "Unable to reach the provider host.",
      suggestedFix: "Ensure the base URL hostname and port are accessible and any local or proxy service is running.",
      statusCode: status,
    };
  }

  if (lower.includes("cert") || lower.includes("ssl") || lower.includes("tls") || lower.includes("cors")) {
    return {
      type: "cors_ssl",
      message: "SSL/TLS certificate or CORS handshake failure.",
      suggestedFix: "Check that the server's TLS certificate is valid and issued by a trusted CA.",
      statusCode: status,
    };
  }

  return {
    type: "unknown",
    message: text.slice(0, 180) || `Request failed with HTTP status ${status || "unknown"}.`,
    suggestedFix: "Check server logs or provider status dashboard for more details.",
    statusCode: status,
  };
}

/**
 * Discover models from an OpenAI-compatible /v1/models endpoint.
 */
export async function discoverModels(baseUrl: string, apiKey: string, headers: Record<string, string> = {}): Promise<string[]> {
  const normBase = baseUrl.replace(/\/+$/, "");
  const targetUrl = normBase.endsWith("/models") ? normBase : `${normBase}/models`;

  const reqHeaders: Record<string, string> = {
    ...headers,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const res = await fetch(targetUrl, {
    method: "GET",
    headers: reqHeaders,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Model discovery failed (${res.status}): ${txt.slice(0, 100)}`);
  }

  const json = (await res.json()) as { data?: Array<{ id: string }> };
  if (Array.isArray(json.data)) {
    return json.data.map((m) => m.id).filter(Boolean);
  }
  return [];
}

/**
 * Probe an endpoint for streaming, tool calling, and vision support.
 */
export async function probeCapabilities(p: ProviderConfig): Promise<EndpointCapabilities> {
  const start = Date.now();
  const headers = resolveHeaders(p);
  const normBase = (p.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const chatUrl = `${normBase}/chat/completions`;

  let supportsStreaming = false;
  let supportsTools = false;
  let supportsVision = false;
  let discoveredModels: string[] = [];

  // 1. Try model discovery
  try {
    discoveredModels = await discoverModels(p.baseUrl || "https://api.openai.com/v1", p.apiKey || "", headers);
  } catch {
    if (p.model) discoveredModels = [p.model];
  }

  const testModel = p.model || discoveredModels[0] || "gpt-4o-mini";

  // 2. Test streaming + basic completion
  try {
    const streamRes = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
        ...headers,
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        max_tokens: 2,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (streamRes.ok && streamRes.headers.get("content-type")?.includes("text/event-stream")) {
      supportsStreaming = true;
    }
  } catch {}

  // 3. Test tool/function calling support
  try {
    const toolRes = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
        ...headers,
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: "user", content: "What is the time?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_time",
              description: "Returns the current time",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (toolRes.ok) {
      const data = (await toolRes.json()) as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
      if (data.choices?.[0]?.message) {
        supportsTools = true;
      }
    }
  } catch {}

  // 4. Test vision capability support (with a tiny 1x1 transparent GIF base64)
  try {
    const tinyGif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const visionRes = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
        ...headers,
      },
      body: JSON.stringify({
        model: testModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: tinyGif } },
            ],
          },
        ],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (visionRes.ok) {
      supportsVision = true;
    }
  } catch {}

  const latencyMs = Date.now() - start;

  return {
    supportsStreaming,
    supportsTools,
    supportsVision,
    discoveredModels,
    latencyMs,
  };
}
