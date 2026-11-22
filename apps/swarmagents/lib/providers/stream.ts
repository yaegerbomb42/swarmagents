import { ProviderError } from "./errors";
import type { ProviderConfig, TokenUsage } from "./types";

/** A single decoded Server-Sent Events frame. */
export interface SseFrame {
  /** The optional `event:` name. Anthropic uses this; OpenAI mostly does not. */
  event?: string;
  /** Joined `data:` payload lines. */
  data: string;
}

const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

function parseFrame(raw: string): SseFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];

  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (data.length === 0) return undefined;
  return { ...(event !== undefined ? { event } : {}), data: data.join("\n") };
}

/**
 * Incrementally decode an SSE byte stream into frames. Cancelling `signal`
 * cancels the underlying reader so a race loser stops consuming promptly.
 */
export async function* readSseFrames(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseFrame, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) cancelReader();
    else signal.addEventListener("abort", cancelReader, { once: true });
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let match = FRAME_SEPARATOR.exec(buffer);
      while (match) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseFrame(raw);
        if (frame) yield frame;
        match = FRAME_SEPARATOR.exec(buffer);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const frame = parseFrame(buffer);
      if (frame) yield frame;
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released after cancellation.
    }
  }
}

/** A guarded stream exceeded its first-byte or inter-chunk idle deadline. */
export class StreamTimeoutError extends Error {
  readonly phase: "first-byte" | "idle";
  readonly timeoutMs: number;
  constructor(phase: "first-byte" | "idle", timeoutMs: number) {
    super(
      phase === "first-byte"
        ? `Stream produced no data within ${timeoutMs}ms.`
        : `Stream stalled for ${timeoutMs}ms without data.`,
    );
    this.name = "StreamTimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export interface StreamTimeoutOptions {
  /** Max wait for the first chunk. <= 0 disables the first-byte deadline. */
  firstByteMs: number;
  /** Max gap between chunks after the first. <= 0 disables the idle deadline. */
  idleMs: number;
  /** Called once when the guarded stream settles (done, error, or cancel). */
  onSettle?: () => void;
}

/**
 * Wrap a byte stream with first-byte and idle deadlines (FIX-06). Total
 * duration is NOT capped: a long stream that keeps producing chunks flows
 * indefinitely. On a deadline the source reader is cancelled and the
 * guarded stream errors with StreamTimeoutError, so consumers see a typed
 * failure instead of hanging on a stalled provider.
 */
export function guardStreamTimeouts(
  source: ReadableStream<Uint8Array>,
  options: StreamTimeoutOptions,
): ReadableStream<Uint8Array> {
  const { firstByteMs, idleMs, onSettle } = options;
  if (!(firstByteMs > 0) && !(idleMs > 0)) return source;
  const reader = source.getReader();
  let sawFirst = false;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    onSettle?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const phase = sawFirst ? "idle" : "first-byte";
      const limit = sawFirst ? idleMs : firstByteMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            if (limit > 0) {
              timer = setTimeout(() => reject(new StreamTimeoutError(phase, limit)), limit);
              timer.unref?.();
            }
          }),
        ]);
        if (result.done) {
          settle();
          controller.close();
          return;
        }
        sawFirst = true;
        controller.enqueue(result.value);
      } catch (err) {
        settle();
        void reader.cancel().catch(() => {});
        controller.error(err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    cancel() {
      settle();
      return reader.cancel().catch(() => {});
    },
  });
}

/** Normalized piece extracted from one provider-specific stream frame. */
export interface StreamPiece {
  text?: string;
  model?: string;
  usage?: Partial<TokenUsage>;
  done?: boolean;
}

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

function streamError(config: ProviderConfig, detail: string): ProviderError {
  return new ProviderError(`Stream error from ${config.id}: ${detail}`, {
    provider: config.id,
    kind: "invalid_response",
    retryable: false,
  });
}

function parseJsonFrame(config: ProviderConfig, frame: SseFrame): unknown {
  try {
    return JSON.parse(frame.data);
  } catch {
    throw streamError(config, "invalid JSON in event stream");
  }
}

function errorDetail(root: Record<string, unknown>): string {
  const error = asRecord(root.error);
  return (
    asString(error?.message) ??
    asString(root.message) ??
    asString(error?.type) ??
    "upstream stream error"
  );
}

function openaiText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value
    .map((part) => asString(asRecord(part)?.text) ?? "")
    .join("");
}

function anthropicPiece(
  config: ProviderConfig,
  frame: SseFrame,
  root: Record<string, unknown>
): StreamPiece {
  if (frame.event === "ping") return {};
  if (frame.event === "error" || root.type === "error") {
    throw streamError(config, errorDetail(root));
  }

  const piece: StreamPiece = {};
  const usage = asRecord(root.usage);
  const message = asRecord(root.message);
  const messageUsage = asRecord(message?.usage);

  switch (root.type) {
    case "message_start": {
      piece.model = asString(message?.model);
      piece.usage = {
        inputTokens: asNumber(messageUsage?.input_tokens) ?? 0,
        outputTokens: asNumber(messageUsage?.output_tokens) ?? 0,
      };
      break;
    }
    case "content_block_start": {
      const block = asRecord(root.content_block);
      if (block?.type === "text") {
        const text = asString(block.text);
        if (text) piece.text = text;
      }
      break;
    }
    case "content_block_delta": {
      const delta = asRecord(root.delta);
      if (delta?.type === "text_delta") {
        const text = asString(delta.text);
        if (text) piece.text = text;
      }
      break;
    }
    case "message_delta": {
      piece.usage = { outputTokens: asNumber(usage?.output_tokens) ?? 0 };
      break;
    }
    case "message_stop":
      piece.done = true;
      break;
    default:
      break;
  }

  return piece;
}

function openaiPiece(
  config: ProviderConfig,
  frame: SseFrame,
  root: Record<string, unknown>
): StreamPiece {
  if (root.type === "error" || root.error !== undefined) {
    throw streamError(config, errorDetail(root));
  }

  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const delta = asRecord(first?.delta);
  const text = openaiText(delta?.content);
  const usage = asRecord(root.usage);

  return {
    ...(text ? { text } : {}),
    ...(asString(root.model) ? { model: asString(root.model) } : {}),
    ...(usage
      ? {
          usage: {
            inputTokens: asNumber(usage.prompt_tokens) ?? 0,
            outputTokens: asNumber(usage.completion_tokens) ?? 0,
          },
        }
      : {}),
  };
}

function geminiPiece(
  config: ProviderConfig,
  root: Record<string, unknown>
): StreamPiece {
  if (root.error !== undefined) {
    throw streamError(config, errorDetail(root));
  }

  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const first = asRecord(candidates[0]);
  const content = asRecord(first?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts
    .map((part) => asString(asRecord(part)?.text) ?? "")
    .join("");
  const usage = asRecord(root.usageMetadata);

  return {
    ...(text ? { text } : {}),
    ...(asString(root.modelVersion) ? { model: asString(root.modelVersion) } : {}),
    ...(usage
      ? {
          usage: {
            inputTokens: asNumber(usage.promptTokenCount) ?? 0,
            outputTokens: asNumber(usage.candidatesTokenCount) ?? 0,
          },
        }
      : {}),
    ...(first?.finishReason ? { done: true } : {}),
  };
}

/**
 * Convert one provider SSE frame into a provider-independent piece. Supports
 * Anthropic (`event:` + typed events), OpenAI-compatible (`data:` chunks and
 * `[DONE]`) and Gemini (`:streamGenerateContent?alt=sse`) wire formats.
 */
export function parseStreamFrame(
  config: ProviderConfig,
  frame: SseFrame
): StreamPiece {
  if (frame.data.trim() === "[DONE]") return { done: true };

  const parsed = parseJsonFrame(config, frame);
  const root = asRecord(parsed);
  if (!root) throw streamError(config, "stream event was not an object");

  if (config.kind === "anthropic") return anthropicPiece(config, frame, root);
  if (config.kind === "openai") return openaiPiece(config, frame, root);
  return geminiPiece(config, root);
}
