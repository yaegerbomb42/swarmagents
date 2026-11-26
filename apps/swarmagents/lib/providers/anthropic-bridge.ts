/**
 * Wire-format translation between the Anthropic Messages API and the OpenAI
 * Chat Completions API.
 *
 * The agent inside a user's VM speaks only the Anthropic Messages API. Most
 * non-Anthropic providers (Inception Mercury, Mistral, Groq, OpenAI, ...)
 * speak the OpenAI Chat Completions wire format instead. This module
 * translates in both directions:
 *
 *   request:  Anthropic -> OpenAI   (system, content blocks text/image,
 *            tools <-> functions, tool_use/tool_result <-> tool_calls/tool role,
 *            tool_choice, tool_result is_error, max_tokens clamped to the
 *            target model's known output cap)
 *   response: OpenAI -> Anthropic    (content blocks, tool_use from
 *            tool_calls, stop_reason mapping, usage mapping)
 *   SSE:     OpenAI chunks -> Anthropic events (message_start /
 *            content_block_start / content_block_delta / content_block_stop /
 *            message_delta / message_stop)
 *
 * It is pure: no I/O, no provider keys, no platform imports. See
 * llm-gateway.ts for the failover/forwarding layer that uses it.
 */

import { randomUUID } from "node:crypto";

/** Thrown when an Anthropic request cannot be translated. */
export class BridgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeValidationError";
  }
}

/** Optional translation limits resolved by the caller (the gateway). */
export interface BridgeOptions {
  /**
   * Hard cap on output tokens for the target model, when known. A request
   * asking for more is clamped down to the cap so the upstream provider
   * never rejects it as oversized. Undefined, zero, negative, or
   * non-finite = no clamp; the request value passes through unchanged.
   */
  maxOutputTokens?: number;
  /**
   * Whether the target model supports vision/image inputs. When explicitly
   * `false`, raw image blocks (in user messages or tool_result payloads) are
   * replaced with structured text placeholders before wire translation so
   * text-only upstreams never reject the turn with HTTP 400.
   */
  vision?: boolean;
}

function imagePlaceholderText(block: Record<string, unknown>): string {
  const source = isRecord(block.source) ? block.source : {};
  const sourceType = asString(source.type) ?? "unknown";
  if (sourceType === "base64") {
    const mediaType = asString(source.media_type) ?? "image/png";
    const data = asString(source.data) ?? "";
    const approxBytes = Math.floor((data.length * 3) / 4);
    return `[image omitted: model lacks vision; mediaType=${mediaType}; bytes=${approxBytes}]`;
  }
  if (sourceType === "url") {
    return "[image omitted: model lacks vision; source=url]";
  }
  return `[image omitted: model lacks vision; source=${sourceType}]`;
}

function stripImagesFromBlocks(blocks: unknown[]): { blocks: unknown[]; changed: boolean } {
  let changed = false;
  const next = blocks.map((rawBlock) => {
    if (!isRecord(rawBlock)) return rawBlock;
    if (rawBlock.type === "image") {
      changed = true;
      return { type: "text", text: imagePlaceholderText(rawBlock) };
    }
    if (rawBlock.type === "tool_result" && Array.isArray(rawBlock.content)) {
      const inner = stripImagesFromBlocks(rawBlock.content);
      if (inner.changed) {
        changed = true;
        return { ...rawBlock, content: inner.blocks };
      }
    }
    return rawBlock;
  });
  return changed ? { blocks: next, changed: true } : { blocks, changed: false };
}

/**
 * Replace Anthropic `image` content blocks (including nested `tool_result`
 * images) with structured text placeholders for non-vision models.
 * Pure and non-mutating: returns `body` unchanged when no images are present.
 */
export function stripAnthropicImages(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((rawMsg) => {
    if (!isRecord(rawMsg) || !Array.isArray(rawMsg.content)) return rawMsg;
    const stripped = stripImagesFromBlocks(rawMsg.content);
    if (!stripped.changed) return rawMsg;
    changed = true;
    return { ...rawMsg, content: stripped.blocks };
  });
  return changed ? { ...body, messages } : body;
}

/**
 * Clamp a requested max_tokens to the target model's output cap.
 * The value is floored first (matching the previous pass-through behavior);
 * an unknown cap leaves it untouched.
 */
export function clampMaxTokens(maxTokens: number, cap: number | undefined): number {
  const floored = Math.floor(maxTokens);
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return floored;
  return Math.min(floored, Math.floor(cap));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Map an OpenAI finish_reason to an Anthropic stop_reason. */
export function mapStopReason(finishReason: unknown): string | null {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return null;
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const block = isRecord(part) ? part : {};
        const text = asString(block.text);
        if (text !== undefined) return text;
        return "";
      })
      .join("");
  }
  return "";
}

/** OpenAI content parts for Anthropic text/image blocks. */
function openaiContentParts(blocks: unknown[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const b = isRecord(block) ? block : {};
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image" && isRecord(b.source) && b.source.type === "base64") {
      const mediaType = asString(b.source.media_type) ?? "image/png";
      const data = asString(b.source.data) ?? "";
      parts.push({ type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } });
    }
    // Unknown block types are dropped: they carry no OpenAI equivalent.
  }
  return parts;
}

/** One Anthropic content block -> OpenAI content (string or parts array). */
function openaiUserContent(content: unknown): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = openaiContentParts(content);
    if (parts.length === 0) return "";
    if (parts.every((part) => part.type === "text")) {
      return (parts as { text: string }[]).map((part) => part.text).join("");
    }
    return parts;
  }
  return "";
}

/** Anthropic tool_result block -> OpenAI tool message content. */
function openaiToolContent(content: unknown): string | Record<string, unknown>[] {
  return openaiUserContent(content);
}

/** Anthropic tools array -> OpenAI tools (functions). */
function anthropicToolsToOpenAI(tools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const tool of tools) {
    const t = isRecord(tool) ? tool : {};
    // Anthropic tools: {name, description?, input_schema}. Custom providers may
    // already use the OpenAI shape {type:"function", function:{...}}.
    if (t.type === "function" && isRecord(t.function)) {
      out.push(t);
      continue;
    }
    const name = asString(t.name);
    if (!name) continue;
    const fn: Record<string, unknown> = { name };
    if (asString(t.description) !== undefined) fn.description = t.description;
    if (t.input_schema !== undefined) fn.parameters = t.input_schema;
    out.push({ type: "function", function: fn });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Anthropic tool_choice -> OpenAI tool_choice (+ parallel_tool_calls).
 *
 * Anthropic: {type:"auto"|"any"|"none"} or {type:"tool", name}, each
 * optionally with disable_parallel_tool_use. OpenAI: "auto"|"required"|
 * "none" or {type:"function", function:{name}}, plus parallel_tool_calls.
 * Custom providers may already send the OpenAI shape; it passes through.
 * Unknown shapes yield nothing (never emit an invalid upstream payload).
 */
function anthropicToolChoiceToOpenAI(toolChoice: unknown): {
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
} {
  if (toolChoice === undefined || toolChoice === null) return {};
  if (typeof toolChoice === "string") {
    return ["auto", "none", "required"].includes(toolChoice) ? { toolChoice } : {};
  }
  const tc = isRecord(toolChoice) ? toolChoice : {};
  const parallel = tc.disable_parallel_tool_use === true ? false : undefined;
  switch (tc.type) {
    case "auto":
      return { toolChoice: "auto", parallelToolCalls: parallel };
    case "any":
      return { toolChoice: "required", parallelToolCalls: parallel };
    case "none":
      return { toolChoice: "none" };
    case "tool": {
      const name = asString(tc.name);
      return name
        ? { toolChoice: { type: "function", function: { name } }, parallelToolCalls: parallel }
        : {};
    }
    case "function": {
      // Pre-shaped OpenAI named-tool choice.
      const fn = isRecord(tc.function) ? tc.function : {};
      return asString(fn.name) ? { toolChoice: tc } : {};
    }
    default:
      return {};
  }
}

/** Anthropic assistant message -> OpenAI assistant message (with tool_calls). */
function anthropicAssistantMessage(message: Record<string, unknown>): Record<string, unknown> {
  const content = message.content;
  const blocks = Array.isArray(content) ? content : [];
  const texts = blocks.filter((b) => isRecord(b) && (b as Record<string, unknown>).type === "text");
  const toolUses = blocks.filter((b) => isRecord(b) && (b as Record<string, unknown>).type === "tool_use");

  const out: Record<string, unknown> = { role: "assistant" };
  if (texts.length > 0) {
    const parts = openaiContentParts(texts);
    out.content = parts.length === 1 ? parts[0].text : parts;
  } else if (typeof content === "string" && content.length > 0) {
    out.content = content;
  }

  if (toolUses.length > 0) {
    const toolCalls: Record<string, unknown>[] = [];
    for (const block of toolUses) {
      const b = block as Record<string, unknown>;
      let input = "";
      try {
        input = typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {});
      } catch {
        input = "{}";
      }
      toolCalls.push({
        id: asString(b.id) ?? `call_${randomUUID().slice(0, 8)}`,
        type: "function",
        function: { name: asString(b.name) ?? "", arguments: input },
      });
    }
    out.tool_calls = toolCalls;
  }
  return out;
}

/**
 * Translate an Anthropic Messages request into an OpenAI Chat Completions
 * request for `targetModel` (the provider's own model id).
 */
export function anthropicToOpenAI(
  body: unknown,
  targetModel: string,
  options: BridgeOptions = {},
): Record<string, unknown> {
  const normalized = options.vision === false ? stripAnthropicImages(body) : body;
  const root = isRecord(normalized) ? normalized : {};
  const rawMessages = root.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new BridgeValidationError("messages must be a non-empty array.");
  }

  const messages: Record<string, unknown>[] = [];
  const system = root.system;

  if (system !== undefined) {
    messages.push({ role: "system", content: openaiUserContent(system) });
  }

  for (const raw of rawMessages) {
    const message = isRecord(raw) ? raw : {};
    const role = asString(message.role) ?? "user";
    if (role === "user") {
      const content = message.content;
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (b) => isRecord(b) && (b as Record<string, unknown>).type === "tool_result",
        );
        const others = content.filter(
          (b) => !(isRecord(b) && (b as Record<string, unknown>).type === "tool_result"),
        );
        // OpenAI requires tool-result messages to follow the assistant message
        // that declared the tool_calls; emit them before the rest of the user
        // content so ordering stays valid.
        for (const block of toolResults) {
          const b = block as Record<string, unknown>;
          const toolCallId = asString(b.tool_use_id);
          if (!toolCallId) continue;
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: openaiToolContent(b.content),
            // OpenAI chat has no standard error flag on tool messages.
            // Carry Anthropic's is_error as an extension field (servers
            // that don't know it ignore it) so the failure semantics
            // survive translation instead of being silently dropped.
            // Only emitted when true: the common case stays byte-identical.
            ...(b.is_error === true ? { is_error: true } : {}),
          });
        }
        if (others.length > 0) {
          messages.push({ role: "user", content: openaiUserContent(others) });
        }
      } else if (content !== undefined) {
        messages.push({ role: "user", content: openaiUserContent(content) });
      }
    } else if (role === "assistant") {
      messages.push(anthropicAssistantMessage(message));
    } else {
      messages.push({ role, content: message.content ?? "" });
    }
  }

  const out: Record<string, unknown> = {
    model: targetModel,
    messages,
  };
  const maxTokens = asNumber(root.max_tokens);
  if (maxTokens !== undefined) out.max_tokens = clampMaxTokens(maxTokens, options.maxOutputTokens);
  const temperature = asNumber(root.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = asNumber(root.top_p);
  if (topP !== undefined) out.top_p = topP;
  if (Array.isArray(root.stop_sequences) && root.stop_sequences.length > 0) {
    out.stop = root.stop_sequences;
  }
  const tools = anthropicToolsToOpenAI(root.tools);
  if (tools !== undefined) {
    out.tools = tools;
    // tool_choice is only meaningful alongside tools; without them there
    // is nothing to force, and strict upstreams reject a bare tool_choice.
    const { toolChoice, parallelToolCalls } = anthropicToolChoiceToOpenAI(root.tool_choice);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
    if (parallelToolCalls !== undefined) out.parallel_tool_calls = parallelToolCalls;
  }
  if (root.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** OpenAI tool_calls -> Anthropic tool_use content blocks. */
function openaiToolCallsToBlocks(toolCalls: unknown): Record<string, unknown>[] {
  if (!Array.isArray(toolCalls)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const raw of toolCalls) {
    const call = isRecord(raw) ? raw : {};
    const fn = isRecord(call.function) ? call.function : {};
    let input: unknown = {};
    const args = asString(fn.arguments);
    if (args !== undefined) {
      try {
        input = JSON.parse(args);
      } catch {
        input = {};
      }
    }
    blocks.push({
      type: "tool_use",
      id: asString(call.id) ?? `call_${randomUUID().slice(0, 8)}`,
      name: asString(fn.name) ?? "",
      input,
    });
  }
  return blocks;
}

/**
 * Translate an OpenAI Chat Completions response into an Anthropic Messages
 * response.
 */
export function openAIToAnthropicResponse(body: unknown, requestedModel: string): Record<string, unknown> {
  const root = isRecord(body) ? body : {};
  if (root.error !== undefined) {
    throw new BridgeValidationError(`upstream provider error: ${JSON.stringify(root.error)}`);
  }
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(first.message) ? first.message : {};

  const content: Record<string, unknown>[] = [];
  const rawContent = message.content;
  if (typeof rawContent === "string") {
    if (rawContent.length > 0) content.push({ type: "text", text: rawContent });
  } else if (Array.isArray(rawContent)) {
    for (const part of rawContent) {
      const p = isRecord(part) ? part : {};
      const text = asString(p.text);
      if (text !== undefined) content.push({ type: "text", text });
      const url = isRecord(p.image_url) ? asString(p.image_url.url) : undefined;
      if (url !== undefined) content.push({ type: "text", text: url });
    }
  }
  for (const block of openaiToolCallsToBlocks(message.tool_calls)) {
    content.push(block);
  }

  // Translate OpenAI usage counts to the Anthropic wire names, mapping cache
  // hits (prompt_tokens_details.cached_tokens) to cache_read_input_tokens.
  // Fields the provider did not report are omitted, never fabricated as 0.
  const usage = isRecord(root.usage) ? root.usage : {};
  const inputTokens = asNumber(usage.prompt_tokens);
  const outputTokens = asNumber(usage.completion_tokens);
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cachedTokens = asNumber(details.cached_tokens);
  const cacheCreation = asNumber(usage.cache_creation_input_tokens);
  const mappedUsage: Record<string, unknown> = {};
  if (inputTokens !== undefined) mappedUsage.input_tokens = inputTokens;
  if (outputTokens !== undefined) mappedUsage.output_tokens = outputTokens;
  if (cachedTokens !== undefined) mappedUsage.cache_read_input_tokens = cachedTokens;
  if (cacheCreation !== undefined) mappedUsage.cache_creation_input_tokens = cacheCreation;

  const stopReason = mapStopReason(first.finish_reason);

  return {
    id: `msg_${asString(root.id) ?? randomUUID()}`,
    type: "message",
    role: "assistant",
    model: asString(root.model) ?? requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mappedUsage,
  };
}

/** Anthropic-style error body, close to the real API's shape. */
export function anthropicErrorBody(status: number, message: string): string {
  let type = "api_error";
  if (status === 400) type = "invalid_request_error";
  else if (status === 401) type = "authentication_error";
  else if (status === 403) type = "permission_error";
  else if (status === 404) type = "not_found_error";
  else if (status === 429) type = "rate_limit_error";
  return JSON.stringify({ type: "error", error: { type, message } });
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE chunks -> Anthropic SSE events.
// ---------------------------------------------------------------------------

export interface AnthropicSseEvent {
  /** Optional `event:` field (Anthropic names events). */
  event?: string;
  data: string;
}

function sseLine(event: AnthropicSseEvent): string {
  const out = [];
  if (event.event) out.push(`event: ${event.event}`);
  out.push(`data: ${event.data}`);
  return `${out.join("\n")}\n\n`;
}

/**
 * Build the initial message_start event. `usage` is the input-side usage
 * known at stream start (empty when the provider has not reported any yet —
 * OpenAI-style streams usually surface usage only in the final chunk).
 */
function messageStartEvent(id: string, model: string, usage: Record<string, unknown> = {}): AnthropicSseEvent {
  return {
    event: "message_start",
    data: JSON.stringify({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    }),
  };
}

/**
 * Incremental translator from OpenAI SSE chunks to Anthropic SSE events.
 *
 * Usage: call `push(chunkJson)` for every OpenAI SSE `data:` frame (except
 * `[DONE]`), then `finish()` once the stream ends. Returns the Anthropic
 * event lines to relay. One instance per upstream stream.
 */
export class OpenAIStreamTranslator {
  private readonly id: string;
  private model = "";
  private started = false;
  private done = false;
  private blockIndex = -1;
  private textIndex = -1;
  /** OpenAI tool_call index -> Anthropic content block index. */
  private readonly toolBlocks = new Map<number, number>();
  /** Input/cache totals from upstream usage chunks; undefined until seen. */
  private inputTokens?: number;
  private cacheReadTokens?: number;
  private cacheCreationTokens?: number;
  private outputTokens = 0;
  /** True once the upstream reported completion_tokens at least once. */
  private sawOutputTokens = false;
  private pendingStop: string | null = null;

  constructor() {
    this.id = `msg_${randomUUID()}`;
  }

  /** Feed one parsed OpenAI stream chunk. Returns Anthropic event lines. */
  push(chunk: unknown): AnthropicSseEvent[] {
    if (this.done) return [];
    const root = isRecord(chunk) ? chunk : {};
    if (root.error !== undefined) {
      throw new Error(`upstream stream error: ${JSON.stringify(root.error)}`);
    }
    const lines: AnthropicSseEvent[] = [];

    // Capture usage before emitting message_start so a provider that includes
    // usage in its first chunk seeds the start event with real input tokens.
    const usage = isRecord(root.usage) ? root.usage : {};
    const promptTokens = asNumber(usage.prompt_tokens);
    const completionTokens = asNumber(usage.completion_tokens);
    if (promptTokens !== undefined) this.inputTokens = promptTokens;
    if (completionTokens !== undefined) {
      this.outputTokens = completionTokens;
      this.sawOutputTokens = true;
    }
    const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
    const cachedTokens = asNumber(details.cached_tokens);
    if (cachedTokens !== undefined) this.cacheReadTokens = cachedTokens;
    const cacheCreation = asNumber(usage.cache_creation_input_tokens);
    if (cacheCreation !== undefined) this.cacheCreationTokens = cacheCreation;

    if (!this.started) {
      this.model = asString(root.model) ?? "";
      const startUsage: Record<string, unknown> = {};
      if (this.inputTokens !== undefined) startUsage.input_tokens = this.inputTokens;
      if (this.cacheReadTokens !== undefined) startUsage.cache_read_input_tokens = this.cacheReadTokens;
      if (this.cacheCreationTokens !== undefined) startUsage.cache_creation_input_tokens = this.cacheCreationTokens;
      lines.push(messageStartEvent(this.id, this.model, startUsage));
      this.started = true;
    }

    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = isRecord(choices[0]) ? choices[0] : {};
    const delta = isRecord(first.delta) ? first.delta : {};

    const text = asString(delta.content);
    if (text !== undefined && text.length > 0) {
      if (this.textIndex === -1) {
        this.blockIndex += 1;
        this.textIndex = this.blockIndex;
        lines.push({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: this.textIndex,
            content_block: { type: "text", text: "" },
          }),
        });
      }
      lines.push({
        event: "content_block_delta",
        data: JSON.stringify({
          type: "content_block_delta",
          index: this.textIndex,
          delta: { type: "text_delta", text },
        }),
      });
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const raw of toolCalls) {
      const call = isRecord(raw) ? raw : {};
      const oaiIndex = asNumber(call.index) ?? this.blockIndex + 1;
      const fn = isRecord(call.function) ? call.function : {};
      const args = asString(fn.arguments);

      if (!this.toolBlocks.has(oaiIndex)) {
        // Close any open text block before starting a tool block: Anthropic
        // content blocks are sequential, text then tool_use.
        if (this.textIndex !== -1) {
          lines.push({
            event: "content_block_stop",
            data: JSON.stringify({ type: "content_block_stop", index: this.textIndex }),
          });
          this.textIndex = -1;
        }
        this.blockIndex += 1;
        this.toolBlocks.set(oaiIndex, this.blockIndex);
        const blockIndex = this.blockIndex;
        lines.push({
          event: "content_block_start",
          data: JSON.stringify({
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: asString(call.id) ?? "",
              name: asString(fn.name) ?? "",
              input: {},
            },
          }),
        });
        if (args !== undefined && args.length > 0) {
          lines.push({
            event: "content_block_delta",
            data: JSON.stringify({
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: args },
            }),
          });
        }
      } else if (args !== undefined && args.length > 0) {
        const blockIndex = this.toolBlocks.get(oaiIndex)!;
        lines.push({
          event: "content_block_delta",
          data: JSON.stringify({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: args },
          }),
        });
      }
    }

    const finishReason = asString(first.finish_reason);
    if (finishReason !== undefined && finishReason !== null && this.pendingStop === null) {
      this.pendingStop = mapStopReason(finishReason);
      // If usage already arrived (or the provider never sends a usage chunk),
      // finalize immediately; otherwise wait for the usage chunk.
      if (this.pendingStop !== null && (completionTokens !== undefined || promptTokens !== undefined)) {
        lines.push(...this.finalize());
      }
    }

    return lines;
  }

  /** Close the stream (call on [DONE] / EOF). Returns any final events. */
  finish(): AnthropicSseEvent[] {
    if (this.done) return [];
    return this.finalize();
  }

  private finalize(): AnthropicSseEvent[] {
    const lines: AnthropicSseEvent[] = [];
    if (this.textIndex !== -1) {
      lines.push({
        event: "content_block_stop",
        data: JSON.stringify({ type: "content_block_stop", index: this.textIndex }),
      });
      this.textIndex = -1;
    }
    // Close any open tool blocks in ascending content-block order.
    const openBlocks = Array.from(this.toolBlocks.values()).sort((a, b) => a - b);
    for (const index of openBlocks) {
      if (!this.closedToolBlocks.has(index)) {
        this.closedToolBlocks.add(index);
        lines.push({
          event: "content_block_stop",
          data: JSON.stringify({ type: "content_block_stop", index }),
        });
      }
    }
    // Cumulative whole-message totals; only fields the upstream actually
    // reported are emitted. The Anthropic SDK overwrites message_start counts
    // with these when present, so input tokens surface even though OpenAI
    // streams typically report usage only at the very end. When the provider
    // reported nothing at all the usage object stays empty, so Claude never
    // sees fabricated zeros.
    const usage: Record<string, unknown> = {};
    if (this.sawOutputTokens) usage.output_tokens = this.outputTokens;
    if (this.inputTokens !== undefined) usage.input_tokens = this.inputTokens;
    if (this.cacheReadTokens !== undefined) usage.cache_read_input_tokens = this.cacheReadTokens;
    if (this.cacheCreationTokens !== undefined) usage.cache_creation_input_tokens = this.cacheCreationTokens;
    lines.push({
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: this.pendingStop ?? "end_turn",
          stop_sequence: null,
        },
        usage,
      }),
    });
    lines.push({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) });
    this.done = true;
    return lines;
  }

  private readonly closedToolBlocks = new Set<number>();
}

// ---------------------------------------------------------------------------
// Token estimation for /v1/messages/count_tokens.
// ---------------------------------------------------------------------------

function estimateTokens(text: unknown): number {
  if (typeof text !== "string") return 0;
  // Rough heuristic: ~4 chars per token, matching typical BPE tokenizers.
  return Math.ceil(text.length / 4);
}

/** Estimate input tokens for an Anthropic Messages request. */
export function estimateInputTokens(body: unknown): number {
  const root = isRecord(body) ? body : {};
  let total = 0;

  const system = root.system;
  if (typeof system === "string") total += estimateTokens(system);
  else if (Array.isArray(system)) {
    for (const block of system) {
      total += estimateTokens(isRecord(block) ? block.text : "");
    }
  }

  const messages = Array.isArray(root.messages) ? root.messages : [];
  for (const raw of messages) {
    const message = isRecord(raw) ? raw : {};
    total += 4; // role + framing overhead
    const content = message.content;
    if (typeof content === "string") {
      total += estimateTokens(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const b = isRecord(block) ? block : {};
        if (b.type === "text") total += estimateTokens(b.text);
        else if (b.type === "image") total += 100; // fixed image approximation
        else if (b.type === "tool_result") {
          total += estimateTokens(b.content);
          total += estimateTokens(b.tool_use_id);
        } else if (b.type === "tool_use") {
          total += estimateTokens(b.id);
          total += estimateTokens(b.name);
          total += estimateTokens(JSON.stringify(b.input ?? {}));
        }
      }
    }
  }

  const tools = Array.isArray(root.tools) ? root.tools : [];
  for (const raw of tools) {
    const tool = isRecord(raw) ? raw : {};
    total += 6;
    total += estimateTokens(tool.name);
    total += estimateTokens(tool.description);
    total += estimateTokens(tool.input_schema === undefined ? "" : JSON.stringify(tool.input_schema));
    if (tool.type === "function" && isRecord(tool.function)) {
      const fn = tool.function;
      total += estimateTokens(fn.name);
      total += estimateTokens(fn.description);
      total += estimateTokens(fn.parameters === undefined ? "" : JSON.stringify(fn.parameters));
    }
  }

  return total;
}
