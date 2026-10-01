import type { Block, Msg } from "../types";

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface StreamCallbacks {
  onThinking(delta: string): void;
  onText(delta: string): void;
  onToolStart(id: string, name: string): void;
  onToolInput(id: string, partialJson: string): void;
  onBlockEnd(): void;
}

export interface ChatRequest {
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
  maxTokens?: number;
}

export interface TurnResult {
  blocks: Block[];
  stop: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: { input: number; output: number; cached: number };
  headers?: Record<string, string>;
}

export type ProviderErrorKind = "rate_limit" | "auth" | "context" | "transient" | "fatal" | "aborted";

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Parse retry hints from any provider's response headers. */
export function retryAfterFrom(headers: Headers | Record<string, string> | undefined | null): number | undefined {
  if (!headers) return;
  const get = (k: string) => (headers instanceof Headers ? headers.get(k) : (headers as Record<string, string>)[k]) ?? undefined;
  const ms = get("retry-after-ms");
  if (ms && !isNaN(+ms)) return +ms;
  const ra = get("retry-after");
  if (ra) {
    if (!isNaN(+ra)) return +ra * 1000;
    const t = Date.parse(ra);
    if (!isNaN(t)) return Math.max(0, t - Date.now());
  }
  // OpenAI-style reset hints: "6m0s", "1.5s", "20ms"
  for (const k of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const v = get(k);
    if (v) {
      let total = 0;
      for (const [, n, u] of v.matchAll(/([\d.]+)(ms|s|m|h)/g)) total += +n * ({ ms: 1, s: 1e3, m: 6e4, h: 3.6e6 } as Record<string, number>)[u];
      if (total) return total;
    }
  }
}

export function classifyHttp(status: number | undefined, message: string, headers?: Headers | Record<string, string> | null): ProviderError {
  const m = message.toLowerCase();
  if (status === 429 || status === 529 || /rate.?limit|overloaded|quota|too many requests/.test(m))
    return new ProviderError("rate_limit", message, retryAfterFrom(headers));
  if (status === 401 || status === 403) return new ProviderError("auth", message);
  if (/context.{0,20}(length|window)|too many tokens|prompt is too long|maximum context|token limit|input.{0,10}too long/.test(m))
    return new ProviderError("context", message);
  if (!status || status >= 500 || status === 408 || status === 409) return new ProviderError("transient", message, retryAfterFrom(headers));
  return new ProviderError("fatal", message);
}
