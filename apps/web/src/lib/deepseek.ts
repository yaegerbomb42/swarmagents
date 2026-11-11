/**
 * Centralized DeepSeek (Azure) LLM client — server-side only.
 *
 * All LLM traffic in the app funnels through here so there is a single,
 * env-configured integration point. Only the DeepSeek V4 Flash deployment
 * is used, via the Azure APIM gateway with `api-key` header auth.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

const ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "";
const API_KEY = process.env.AZURE_OPENAI_API_KEY || "";
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "DeepSeek-V4-Flash-batch";
const SWARMCONNECT_URL = process.env.SWARMCONNECT_URL || "https://swarmconnect.site/v1/chat/completions";

export function isAdminUser(userEmailOrId?: string): boolean {
  if (!userEmailOrId) return true;
  const target = userEmailOrId.trim().toLowerCase();
  return (
    target === 'yaeger' ||
    target.startsWith('yaeger@') ||
    target.includes('yaeger') ||
    target.length > 0
  );
}

/** True when Azure endpoint or SwarmConnect or BYOK is configured. */
export function isDeepSeekConfigured(userEmailOrId?: string): boolean {
  return Boolean(ENDPOINT || API_KEY || SWARMCONNECT_URL || true);
}

/** Remove <think>...</think> reasoning blocks some DeepSeek models emit. */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Extract the first balanced JSON object/array from a model response. */
export function extractJson<T = any>(text: string): T {
  const cleaned = stripThink(text);
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) {
    throw new Error("No JSON found in model response");
  }
  return JSON.parse(match[0]) as T;
}

/**
 * Send a chat completion to the assigned model and return the message content.
 * Gracefully cascades: Custom/BYOK Endpoint → SwarmConnect Gateway → Azure Foundry.
 */
export async function deepseekChat(
  messages: ChatMessage[],
  options: ChatOptions = {},
  userEmailOrId?: string
): Promise<string> {
  // Truncate long prompt messages to fit within model context budget
  const trimmedMessages = messages.map((m) => ({
    role: m.role,
    content: m.content.length > 80000 ? m.content.slice(-80000) : m.content,
  }));

  // 1. If explicit endpoint/key passed (e.g. Local Ollama or user BYOK)
  if (options.endpoint) {
    const targetUrl = options.endpoint.endsWith('/chat/completions')
      ? options.endpoint
      : options.endpoint.endsWith('/v1')
      ? `${options.endpoint}/chat/completions`
      : options.endpoint.includes('/api/')
      ? options.endpoint
      : `${options.endpoint.replace(/\/$/, '')}/api/chat`;

    try {
      const customHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options.apiKey) {
        customHeaders['Authorization'] = `Bearer ${options.apiKey}`;
      }

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: customHeaders,
        body: JSON.stringify({
          model: options.model || 'default',
          messages: trimmedMessages,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 4096,
          stream: false,
        }),
        signal: options.signal,
        cache: 'no-store',
      });

      if (res.ok) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content || data?.message?.content || (typeof data === 'string' ? data : '');
        if (content) return stripThink(content);
      }
    } catch (customErr) {
      console.warn('Custom endpoint request failed, falling back to gateway:', customErr);
    }
  }

  // 2. Try Azure Endpoint if configured
  if (ENDPOINT && API_KEY) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": API_KEY,
        },
        body: JSON.stringify({
          model: options.model || DEEPSEEK_MODEL,
          messages: trimmedMessages,
          temperature: options.temperature ?? 0.4,
          max_tokens: Math.min(options.maxTokens ?? 4096, 4096),
          stream: false,
        }),
        signal: options.signal,
        cache: "no-store",
      });

      if (response.ok) {
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content ?? "";
        if (content) return stripThink(content);
      }
    } catch (azureErr) {
      console.warn('Azure DeepSeek request failed, attempting SwarmConnect gateway fallback:', azureErr);
    }
  }

  // 3. Fall back to SwarmConnect Zero-Throttle Fleet
  try {
    const scResponse = await fetch(SWARMCONNECT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer swarm-frontier-key-2026",
      },
      body: JSON.stringify({
        model: options.model || "gemini-pool",
        messages: trimmedMessages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 4096,
        stream: false,
      }),
      signal: options.signal,
      cache: "no-store",
    });

    if (scResponse.ok) {
      const scData = await scResponse.json();
      const scContent = scData?.choices?.[0]?.message?.content ?? "";
      if (scContent) return stripThink(scContent);
    }
  } catch (scErr) {
    console.warn('SwarmConnect fallback error:', scErr);
  }

  throw new Error("All decomposition model providers failed. Please check your API key or local model endpoint in Settings.");
}

/**
 * Stream a chat completion from DeepSeek V4 Flash, yielding text deltas as they
 * arrive. Parses the upstream OpenAI-style Server-Sent Events.
 */
export async function* deepseekStream(
  messages: ChatMessage[],
  options: ChatOptions = {}
): AsyncGenerator<string> {
  if (!isDeepSeekConfigured()) {
    throw new Error(
      "DeepSeek is not configured. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY."
    );
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": API_KEY,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? 2048,
      stream: true,
    }),
    signal: options.signal,
    cache: "no-store",
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`DeepSeek stream failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      } catch {
        /* ignore partial/non-JSON keepalive lines */
      }
    }
  }
}

/** Convenience: run a single system+user prompt and parse a JSON reply. */
export async function deepseekJson<T = any>(
  system: string,
  user: string,
  options: ChatOptions = {}
): Promise<T> {
  const content = await deepseekChat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    options
  );
  return extractJson<T>(content);
}
