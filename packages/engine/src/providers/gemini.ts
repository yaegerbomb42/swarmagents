import { ProviderError } from '../errors.js';
import type { GeminiCacheManager } from './gemini-cache.js';
import { geminiThinking } from './turn-effort.js';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Provider,
  StopReason,
} from './types.js';

export interface GeminiOptions {
  apiKey: string | undefined;
  /** e.g. https://generativelanguage.googleapis.com (tests inject a loopback URL). */
  baseUrl?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  headers?: Readonly<Record<string, string>> | undefined;
  cacheManager?: GeminiCacheManager;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
  inlineData?: { mimeType: string; data: string };
}
interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}
interface GeminiResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { message?: string };
}

function toContents(req: CompletionRequest): GeminiContent[] {
  const nameForId = new Map<string, string>();
  for (const m of req.messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') nameForId.set(b.id, b.name);
    }
  }
  const out: GeminiContent[] = [];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use')
          parts.push({ functionCall: { name: b.name, args: b.input ?? {} } });
      }
      if (parts.length) out.push({ role: 'model', parts });
      continue;
    }
    const parts: GeminiPart[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result')
        parts.push({
          functionResponse: {
            name: nameForId.get(b.toolUseId) ?? b.toolUseId,
            response: { result: b.content },
          },
        });
      else if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'image')
        parts.push({ inlineData: { mimeType: b.mediaType, data: b.data } });
    }
    if (parts.length) out.push({ role: 'user', parts });
  }
  return out;
}

function mapStop(r: string | undefined, hasCalls: boolean): StopReason {
  if (hasCalls || r === 'TOOL_CALL' || r === 'FUNCTION_CALL') return 'tool_use';
  if (r === 'STOP') return 'end_turn';
  if (r === 'MAX_TOKENS') return 'max_tokens';
  if (r === 'SAFETY' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT') return 'refusal';
  return 'other';
}

/**
 * Native Gemini provider: `generateContent` with function calling and usage
 * metadata. Plain `fetch`, no SDK. Implements the Provider interface in types.ts.
 */
export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  constructor(private readonly opts: GeminiOptions) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const base = (this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
      /\/+$/,
      '',
    );

    let totalEstimated = 0;
    for (const s of req.system) totalEstimated += Math.ceil(s.text.length / 4);
    for (const t of req.tools) {
      totalEstimated += Math.ceil(
        (t.name.length + t.description.length + JSON.stringify(t.inputSchema).length) / 4,
      );
    }

    const cacheEntry = this.opts.cacheManager
      ? await this.opts.cacheManager.getOrCreateCache({
          model: req.model,
          system: req.system,
          tools: req.tools,
          estimatedTokens: totalEstimated,
        })
      : undefined;

    const tools =
      req.tools.length && !cacheEntry
        ? [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
              })),
            },
          ]
        : [];
    const body: Record<string, unknown> = {
      ...(cacheEntry ? { cachedContent: cacheEntry.name } : {}),
      ...(!cacheEntry && req.system.length
        ? { system_instruction: { parts: req.system.map((b) => ({ text: b.text })) } }
        : {}),
      contents: toContents(req),
      ...(tools.length ? { tools } : {}),
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        ...(geminiThinking(req) ? { thinkingConfig: geminiThinking(req) } : {}),
      },
    };
    const signals = [AbortSignal.timeout(this.opts.timeoutMs), ...(req.signal ? [req.signal] : [])];
    const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.headers ?? {}),
          ...(this.opts.apiKey ? { 'x-goog-api-key': this.opts.apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      if (req.signal?.aborted)
        throw new ProviderError('request aborted', { retryable: false, cause: err });
      throw new ProviderError(`network error talking to gemini: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    }
    let data: GeminiResponse;
    try {
      data = (await res.json()) as GeminiResponse;
    } catch (err) {
      const isAbort =
        err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');
      if (isAbort)
        throw new ProviderError('gemini timed out reading the response', {
          retryable: true,
          cause: err,
        });
      throw new ProviderError(`gemini returned non-JSON (HTTP ${res.status})`, {
        retryable: res.status >= 500,
        status: res.status,
        cause: err,
      });
    }
    if (!res.ok) {
      const s = res.status;
      if (s === 404 && cacheEntry) {
        this.opts.cacheManager?.invalidate(cacheEntry.name);
      }
      throw new ProviderError(`gemini error ${s}: ${data.error?.message ?? 'request failed'}`, {
        retryable: s === 408 || s === 409 || s === 429 || s >= 500,
        status: s,
        ...(s === 401 || s === 403 ? { hint: 'check the key for gemini' } : {}),
      });
    }
    const cand = data.candidates?.[0];
    const content: ContentBlock[] = [];
    let call = 0;
    for (const p of cand?.content?.parts ?? []) {
      if (typeof p.text === 'string' && p.text) content.push({ type: 'text', text: p.text });
      if (p.functionCall)
        content.push({
          type: 'tool_use',
          id: `call_${call++}`,
          name: p.functionCall.name ?? '',
          input: p.functionCall.args ?? {},
        });
    }
    const cachedTokens = data.usageMetadata?.cachedContentTokenCount ?? 0;
    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const uncached = Math.max(0, promptTokens - cachedTokens);
    return {
      model: req.model,
      stopReason: mapStop(
        cand?.finishReason,
        content.some((b) => b.type === 'tool_use'),
      ),
      content,
      usage: {
        uncached,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: cachedTokens,
        output: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
