import type { ProviderConfig } from "../types";
import { presetFor } from "../presets";
import { listAnthropicModels, streamAnthropic } from "./anthropic";
import { listOpenAIModels, streamOpenAI } from "./openai";
import { ProviderError, type ChatRequest, type StreamCallbacks } from "./types";

/** Resolve "{key}" placeholders in a connection's extra headers. */
export function resolveHeaders(p: Pick<ProviderConfig, "apiKey" | "headers">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.headers ?? {})) if (k.trim()) out[k.trim()] = String(v).split("{key}").join(p.apiKey ?? "");
  return out;
}

export const isAnthropic = (p: Pick<ProviderConfig, "kind">) => p.kind === "anthropic";

export type ModelInfo = { id: string; context?: number };

/** Live model list for any connection; throws the provider's error. */
export function listModels(p: ProviderConfig): Promise<ModelInfo[]> {
  return isAnthropic(p) ? listAnthropicModels(p) : listOpenAIModels(p);
}

/**
 * Prove a connection works. Lists models when the provider supports it; otherwise (or when listing is
 * unsupported and a model is chosen) sends a 1-token request so endpoints without /models can still be verified.
 */
export async function testProvider(p: ProviderConfig, signal?: AbortSignal): Promise<{ models: ModelInfo[]; via: "models" | "ping" }> {
  const preset = presetFor(p.preset ?? p.kind);
  if (!preset.noModelList) {
    try {
      return { models: await listModels(p), via: "models" };
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 404/405: the server simply has no /models route. Anything else (401, network) is a real failure.
      if (!(status === 404 || status === 405) || !p.model) throw e;
    }
  }
  if (!p.model) throw new Error("This provider can't list its models. Enter a model name, then Test.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  const noop = () => {};
  try {
    const req: ChatRequest = { system: "Reply with OK.", messages: [{ role: "user", blocks: [{ type: "text", text: "ping" }] }], tools: [], signal: ctrl.signal, maxTokens: 16 };
    const cb: StreamCallbacks = { onThinking: noop, onText: noop, onToolStart: noop, onToolInput: noop, onBlockEnd: noop };
    await (isAnthropic(p) ? streamAnthropic(p, req, cb) : streamOpenAI(p, req, cb));
    return { models: [{ id: p.model }], via: "ping" };
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "aborted") throw new Error("The provider did not answer within 45s.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
