/**
 * Provider router — single source of truth for where user LLM calls go.
 *
 * All chat traffic routes through the engine gateway:
 *   browser → POST /api/engine/llm/chat (Next rewrite → engine /llm/chat)
 *   → Azure AI Foundry (single key, deployment name = model in request body)
 *
 * There is no secondary LLM path. If the gateway/Azure is down, the request
 * fails — the dashboard surfaces the gateway's error to the user.
 */

export const GATEWAY_CHAT_PATH = '/api/engine/llm/chat';

/**
 * Resolve the chat completions endpoint for a configured provider.
 * Azure-provider traffic always goes through the gateway; explicit custom
 * endpoints (local Ollama, MLX, etc.) are preserved as-is.
 */
export function resolveChatEndpoint(endpoint: string | undefined | null): string {
  const ep = (endpoint || '').trim();
  if (!ep) return gatewayChatUrl();
  return ep;
}

export function gatewayChatUrl(): string {
  const base = (process.env.NEXT_PUBLIC_ENGINE_URL || '').replace(/\/$/, '');
  return base ? `${base}/llm/chat` : GATEWAY_CHAT_PATH;
}
