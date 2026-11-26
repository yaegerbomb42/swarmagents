/**
 * Pure wire-format shims for the LLM gateway.
 *
 * Claude Code speaks Anthropic Messages. The gateway already translates the
 * OpenAI Chat Completions wire format (anthropic-bridge.ts). This module covers
 * the other API styles by translating them to/from OpenAI Chat Completions
 * shapes, so the battle-tested bridge does the Anthropic side exactly once:
 *
 *   Anthropic  -> OpenAI Responses / Ollama native / Gemini generateContent
 *   OpenAI chat <- their response and streaming event shapes
 *
 * It is pure: no I/O, no keys, no platform imports.
 */

import { randomUUID } from "node:crypto";
import {
  anthropicToOpenAI,
  clampMaxTokens,
  ensureToolCallId,
  repairToolArguments,
  stripAnthropicImages,
  type BridgeOptions,
} from "./anthropic-bridge";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Responses gateways may omit `call_id`/`item.id` on tool events. A missing
 * id falls back to the event's `output_index` (every Responses output event
 * carries it), scoped to this stream, so the added / arguments.delta / done
 * events of one call share a key while two parallel id-less calls stay two
 * separate tool_use blocks. Only an event with neither an id nor an
 * output_index lands on the shared sentinel.
 */
function responsesToolId(value: unknown, outputIndex: unknown, state: ResponsesStreamState): string {
  const id = asString(value);
  if (id && id.length > 0) return id;
  const index = asNumber(outputIndex);
  if (index !== undefined) return `call_${state.idSeed}_${index}`;
  return `call_${state.idSeed}_unknown`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = isRecord(part) ? part : {};
        return asString(p.text) ?? "";
      })
      .join("");
  }
  return "";
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function jsonString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

/** Content parts for an OpenAI chat message (string or multimodal array). */
function openAiParts(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .map((part): Record<string, unknown> | null => {
      const p = isRecord(part) ? part : {};
      const text = asString(p.text);
      if (text !== undefined) return { type: "text", text };
      const url = isRecord(p.image_url) ? asString(p.image_url.url) : undefined;
      if (url !== undefined) return { type: "image_url", image_url: { url } };
      return null;
    })
    .filter((p): p is Record<string, unknown> => p !== null);
}

// ---------------------------------------------------------------------------
// OpenAI Responses request/response
// ---------------------------------------------------------------------------

/**
 * Anthropic Messages body -> OpenAI Responses request. Built on the OpenAI chat
 * translation so tool calls/results keep their exact semantics.
 *
 * `effort` is the Perplexity Agent API effort level (top-level `effort`
 * field); the caller decides whether the target provider takes one. Omit it
 * for every other Responses provider so their request shape is unchanged.
 */
export function anthropicToResponses(
  body: unknown,
  targetModel: string,
  options: BridgeOptions = {},
  effort?: string,
): Record<string, unknown> {
  const chat = anthropicToOpenAI(body, targetModel, options);
  const rawMessages = Array.isArray(chat.messages) ? chat.messages : [];
  const input: Record<string, unknown>[] = [];
  const instructions: string[] = [];

  for (const raw of rawMessages) {
    const message = isRecord(raw) ? raw : {};
    const role = asString(message.role) ?? "user";
    if (role === "system") {
      const text = contentText(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: asString(message.tool_call_id) ?? "call_unknown",
        output: contentText(message.content),
        // Preserve the bridge's is_error extension field (see
        // anthropic-bridge.ts) so failure semantics survive this hop too.
        ...(message.is_error === true ? { is_error: true } : {}),
      });
      continue;
    }
    if (role === "assistant") {
      const text = contentText(message.content);
      if (text) {
        input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const rawCall of calls) {
        const call = isRecord(rawCall) ? rawCall : {};
        const fn = isRecord(call.function) ? call.function : {};
        input.push({
          type: "function_call",
          call_id: asString(call.id) ?? `call_${input.length}`,
          name: asString(fn.name) ?? "",
          arguments: jsonString(fn.arguments),
        });
      }
      continue;
    }
    // user
    const content = openAiParts(message.content).map((part) =>
      part.type === "image_url"
        ? { type: "input_image", image_url: isRecord(part.image_url) ? part.image_url.url : "" }
        : { type: "input_text", text: asString(part.text) ?? "" }
    );
    input.push({ role: "user", content });
  }

  const tools = Array.isArray(chat.tools)
    ? chat.tools.map((raw) => {
        const t = isRecord(raw) ? raw : {};
        const fn = isRecord(t.function) ? t.function : t;
        return {
          type: "function",
          name: asString(fn.name) ?? "",
          ...(asString(fn.description) !== undefined ? { description: fn.description } : {}),
          ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
        };
      })
    : undefined;

  const out: Record<string, unknown> = {
    model: targetModel,
    input,
  };
  if (instructions.length > 0) out.instructions = instructions.join("\n\n");
  const maxTokens = asNumber(chat.max_tokens);
  if (maxTokens !== undefined) out.max_output_tokens = maxTokens;
  const temperature = asNumber(chat.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  if (tools !== undefined && tools.length > 0) {
    out.tools = tools;
    // Responses tool_choice mirrors chat's, except the named-tool form is
    // flat ({type:"function", name}) instead of nested under `function`.
    const chatChoice = chat.tool_choice;
    if (typeof chatChoice === "string") {
      out.tool_choice = chatChoice;
    } else if (isRecord(chatChoice) && chatChoice.type === "function") {
      const fn = isRecord(chatChoice.function) ? chatChoice.function : {};
      const name = asString(fn.name) ?? asString(chatChoice.name);
      if (name) out.tool_choice = { type: "function", name };
    }
    if (chat.parallel_tool_calls === false) out.parallel_tool_calls = false;
  }
  if (effort) out.effort = effort;
  if (chat.stream === true) out.stream = true;
  return out;
}

/**
 * Provider-reported cost in USD from a provider `usage` object, when the
 * provider included one. Two documented shapes are recognized:
 *
 *   - Perplexity Agent API: `usage.cost = { currency: "USD", total_cost, … }`
 *     (docs.perplexity.ai/api-reference/agent-post). A bare numeric `cost`
 *     is also accepted defensively (some gateways flatten the object).
 *   - xAI: `usage.cost_in_usd_ticks`, where 1 USD = 10^10 ticks
 *     (docs.x.ai/developers/cost-tracking).
 *
 * Anything else — absent, malformed, negative, non-finite, or denominated
 * in a currency other than USD — returns undefined (fail-open: the caller
 * falls back to the price-table estimate). A reported $0 is a real cost
 * and is preserved. When both shapes are present, `cost` wins.
 */
export function parseReportedCostUsd(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const cost = usage.cost;
  if (isRecord(cost)) {
    const currency = asString(cost.currency);
    if (currency === undefined || currency.toUpperCase() === "USD") {
      const total = asNumber(cost.total_cost);
      if (total !== undefined && total >= 0) return total;
    }
    return undefined;
  }
  const flat = asNumber(cost);
  if (flat !== undefined && flat >= 0) return flat;
  const ticks = asNumber(usage.cost_in_usd_ticks);
  if (ticks !== undefined && ticks >= 0) return ticks / 10_000_000_000;
  return undefined;
}

/** Responses API non-streaming body -> OpenAI chat completion body. */
export function responsesToOpenAIResponse(body: unknown, requestedModel: string): Record<string, unknown> {
  const root = isRecord(body) ? body : {};
  const output = Array.isArray(root.output) ? root.output : [];
  let text = asString(root.output_text) ?? "";
  const toolCalls: Record<string, unknown>[] = [];
  for (const raw of output) {
    const item = isRecord(raw) ? raw : {};
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        const p = isRecord(part) ? part : {};
        if (p.type === "output_text" || p.type === "text") text += asString(p.text) ?? "";
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: ensureToolCallId(asString(item.call_id) ?? asString(item.id) ?? `call_${toolCalls.length}`),
        type: "function",
        function: { name: asString(item.name) ?? "", arguments: repairToolArguments(item.arguments) },
      });
    }
  }
  const usage = isRecord(root.usage) ? root.usage : {};
  const reportedCost = parseReportedCostUsd(usage);
  const status = asString(root.status);
  const finishReason = toolCalls.length > 0 ? "tool_calls" : status === "incomplete" ? "length" : "stop";
  return {
    id: asString(root.id) ?? "resp",
    model: asString(root.model) ?? requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          ...(text ? { content: text } : { content: "" }),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: asNumber(usage.input_tokens) ?? 0,
      completion_tokens: asNumber(usage.output_tokens) ?? 0,
      // Provider-reported cost rides along when present; the Anthropic
      // bridge ignores unknown usage fields, so relayed bodies are
      // unchanged. The gateway reads it for llm.call accounting.
      ...(reportedCost !== undefined ? { cost_usd: reportedCost } : {}),
    },
  };
}

export interface OpenAIChunk {
  model?: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason?: string | null;
  }>;
  usage?: Record<string, number>;
}

export interface ResponsesStreamState {
  model: string;
  toolIndex: Map<string, number>;
  nextToolIndex: number;
  emittedArgs: Set<string>;
  /** Argument fragments that arrived before their output_item.added event. */
  pendingArgs: Map<string, string[]>;
  sawTools: boolean;
  usage?: Record<string, number>;
  finished: boolean;
  /** Per-stream prefix for ids synthesized from output_index. */
  idSeed: string;
}

export function newResponsesStreamState(model: string): ResponsesStreamState {
  return {
    model,
    idSeed: randomUUID().slice(0, 8),
    toolIndex: new Map(),
    nextToolIndex: 0,
    emittedArgs: new Set(),
    pendingArgs: new Map(),
    sawTools: false,
    finished: false,
  };
}

/** Map a tool id to one stable chunk index, even when events arrive out of order. */
function toolIndexFor(id: string, state: ResponsesStreamState): number {
  let index = state.toolIndex.get(id);
  if (index === undefined) {
    index = state.nextToolIndex++;
    state.toolIndex.set(id, index);
  }
  return index;
}

function toolChunk(
  model: string,
  index: number,
  call: { id?: string; name?: string; arguments?: string },
): OpenAIChunk {
  return {
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              // Always emit a non-empty id and type: downstream translators
              // cannot key a tool_result on an empty id.
              id: ensureToolCallId(call.id),
              type: "function",
              function: {
                ...(call.name ? { name: call.name } : {}),
                ...(call.arguments !== undefined ? { arguments: call.arguments } : {}),
              },
            },
          ],
        },
      },
    ],
  };
}

/** One Responses SSE event -> zero or more OpenAI chat chunks. */
export function responsesEventToChunks(event: unknown, state: ResponsesStreamState): OpenAIChunk[] {
  const root = isRecord(event) ? event : {};
  const type = asString(root.type) ?? "";
  const out: OpenAIChunk[] = [];

  if (type === "response.output_text.delta") {
    const delta = asString(root.delta) ?? "";
    if (delta) {
      out.push({
        model: state.model,
        choices: [{ index: 0, delta: { content: delta } }],
      });
    }
    return out;
  }

  if (type === "response.output_item.added") {
    const item = isRecord(root.item) ? root.item : {};
    if (item.type === "function_call") {
      const id = responsesToolId(item.call_id ?? item.id, root.output_index, state);
      // Reuse the index if an argument delta arrived before this event.
      const index = toolIndexFor(id, state);
      state.sawTools = true;
      out.push(toolChunk(state.model, index, { id, name: asString(item.name) ?? "" }));
      // Flush fragments buffered ahead of the added event now that the tool's
      // name and id are known — a tool_use block's name cannot be changed
      // after content_block_start has been emitted downstream.
      for (const args of state.pendingArgs.get(id) ?? []) {
        out.push(toolChunk(state.model, index, { id, arguments: args }));
      }
      state.pendingArgs.delete(id);
    }
    return out;
  }

  if (type === "response.function_call_arguments.delta") {
    const id = responsesToolId(root.item_id ?? root.call_id, root.output_index, state);
    const delta = asString(root.delta) ?? "";
    state.emittedArgs.add(id);
    if (delta) {
      if (!state.toolIndex.has(id)) {
        const pending = state.pendingArgs.get(id) ?? [];
        pending.push(delta);
        state.pendingArgs.set(id, pending);
      } else {
        const index = toolIndexFor(id, state);
        out.push(toolChunk(state.model, index, { id, arguments: delta }));
      }
    }
    return out;
  }

  if (type === "response.output_item.done") {
    const item = isRecord(root.item) ? root.item : {};
    if (item.type === "function_call") {
      const id = responsesToolId(item.call_id ?? item.id, root.output_index, state);
      const buffered = state.pendingArgs.get(id);
      if (buffered) {
        const index = toolIndexFor(id, state);
        state.sawTools = true;
        out.push(toolChunk(state.model, index, { id, name: asString(item.name) ?? "" }));
        for (const args of buffered) out.push(toolChunk(state.model, index, { id, arguments: args }));
        state.pendingArgs.delete(id);
      }
      const index = toolIndexFor(id, state);
      // Some gateways never stream argument deltas; emit the complete call.
      // Repair truncated/malformed arguments here so the downstream
      // Anthropic translator never sees broken JSON.
      if (!state.emittedArgs.has(id) && item.arguments !== undefined) {
        state.emittedArgs.add(id);
        out.push(toolChunk(state.model, index, { id, arguments: repairToolArguments(item.arguments) }));
      }
    }
    return out;
  }

  if (type === "response.completed" || type === "response.incomplete") {
    const response = isRecord(root.response) ? root.response : {};
    const usage = isRecord(response.usage) ? response.usage : {};
    const reportedCost = parseReportedCostUsd(usage);
    state.usage = {
      prompt_tokens: asNumber(usage.input_tokens) ?? 0,
      completion_tokens: asNumber(usage.output_tokens) ?? 0,
      ...(reportedCost !== undefined ? { cost_usd: reportedCost } : {}),
    };
    state.finished = true;
    out.push({
      model: state.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: state.sawTools ? "tool_calls" : type === "response.incomplete" ? "length" : "stop",
        },
      ],
      usage: state.usage,
    });
    return out;
  }

  if (type === "response.failed" || type === "error") {
    const response = isRecord(root.response) ? root.response : {};
    const error = isRecord(response.error) ? response.error : isRecord(root.error) ? root.error : {};
    throw new Error(asString(error.message) ?? "Responses stream failed.");
  }

  return out;
}

/**
 * Stamp the provider-reported cost onto an OpenAI chat streaming chunk's
 * usage as `cost_usd`, mirroring what the Responses shim does on its
 * terminal chunk. xAI chat streams carry `usage.cost_in_usd_ticks` on the
 * final chunk when usage is requested (the bridge sends
 * `stream_options: { include_usage: true }`; docs.x.ai/developers/
 * cost-tracking). The Anthropic bridge drops unknown usage fields, so
 * relayed SSE stays byte-identical; the gateway taps `cost_usd` for
 * llm.call accounting. Chunks without a parseable reported cost are
 * returned unchanged (same reference).
 */
export function chatChunkWithReportedCost(chunk: unknown): OpenAIChunk {
  if (!isRecord(chunk)) return chunk as OpenAIChunk;
  const usage = isRecord(chunk.usage) ? chunk.usage : undefined;
  if (!usage) return chunk as unknown as OpenAIChunk;
  const reportedCost = parseReportedCostUsd(usage);
  if (reportedCost === undefined) return chunk as unknown as OpenAIChunk;
  return { ...chunk, usage: { ...usage, cost_usd: reportedCost } } as unknown as OpenAIChunk;
}

// ---------------------------------------------------------------------------
// Ollama native request/response
// ---------------------------------------------------------------------------

/** Anthropic Messages body -> Ollama /api/chat request. */
export function anthropicToOllama(
  body: unknown,
  targetModel: string,
  bridgeOptions: BridgeOptions = {},
): Record<string, unknown> {
  const chat = anthropicToOpenAI(body, targetModel, bridgeOptions);
  const rawMessages = Array.isArray(chat.messages) ? chat.messages : [];
  const messages: Record<string, unknown>[] = [];

  for (const raw of rawMessages) {
    const message = isRecord(raw) ? raw : {};
    const role = asString(message.role) ?? "user";
    if (role === "tool") {
      messages.push({
        role: "tool",
        content: contentText(message.content),
        // Ollama has no tool_choice and no native error flag; carry the
        // bridge's is_error extension field through (Ollama ignores
        // unknown fields) so the semantics aren't lost at this hop.
        ...(message.is_error === true ? { is_error: true } : {}),
      });
      continue;
    }
    if (role === "assistant") {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      messages.push({
        role: "assistant",
        content: contentText(message.content),
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((rawCall) => {
                const call = isRecord(rawCall) ? rawCall : {};
                const fn = isRecord(call.function) ? call.function : {};
                return {
                  function: {
                    name: asString(fn.name) ?? "",
                    arguments: parseJson(fn.arguments),
                  },
                };
              }),
            }
          : {}),
      });
      continue;
    }
    if (role === "system") {
      messages.push({ role: "system", content: contentText(message.content) });
      continue;
    }
    const parts = openAiParts(message.content);
    const text = parts.map((p) => asString(p.text) ?? "").join("");
    const images = parts
      .filter((p) => p.type === "image_url")
      .map((p) => {
        const url = isRecord(p.image_url) ? asString(p.image_url.url) ?? "" : "";
        const comma = url.indexOf(",");
        return comma >= 0 ? url.slice(comma + 1) : url;
      });
    messages.push({
      role: "user",
      content: text,
      ...(images.length > 0 ? { images } : {}),
    });
  }

  const tools = Array.isArray(chat.tools)
    ? chat.tools.map((raw) => {
        const t = isRecord(raw) ? raw : {};
        const fn = isRecord(t.function) ? t.function : t;
        return {
          type: "function",
          function: {
            name: asString(fn.name) ?? "",
            ...(asString(fn.description) !== undefined ? { description: fn.description } : {}),
            ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
          },
        };
      })
    : undefined;

  const options: Record<string, unknown> = {};
  const maxTokens = asNumber(chat.max_tokens);
  if (maxTokens !== undefined) options.num_predict = maxTokens;
  const temperature = asNumber(chat.temperature);
  if (temperature !== undefined) options.temperature = temperature;

  return {
    model: targetModel,
    messages,
    stream: chat.stream === true,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

/** Ollama non-streaming /api/chat body -> OpenAI chat completion body. */
export function ollamaToOpenAIResponse(body: unknown, requestedModel: string): Record<string, unknown> {
  const root = isRecord(body) ? body : {};
  const message = isRecord(root.message) ? root.message : {};
  const text = asString(message.content) ?? "";
  const toolCalls: Record<string, unknown>[] = [];
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((raw, index) => {
      const call = isRecord(raw) ? raw : {};
      const fn = isRecord(call.function) ? call.function : call;
      toolCalls.push({
        id: ensureToolCallId(asString(call.id) ?? `call_${index}`),
        type: "function",
        function: { name: asString(fn.name) ?? "", arguments: repairToolArguments(fn.arguments) },
      });
    });
  }
  return {
    id: "ollama",
    model: asString(root.model) ?? requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: asNumber(root.prompt_eval_count) ?? 0,
      completion_tokens: asNumber(root.eval_count) ?? 0,
    },
  };
}

export interface OllamaStreamState {
  model: string;
  nextToolIndex: number;
  sawTools: boolean;
  finished: boolean;
}

export function newOllamaStreamState(model: string): OllamaStreamState {
  return { model, nextToolIndex: 0, sawTools: false, finished: false };
}

/** One NDJSON line from Ollama -> OpenAI chat chunks (final line carries usage). */
export function ollamaLineToChunks(line: unknown, state: OllamaStreamState): OpenAIChunk[] {
  const root = isRecord(line) ? line : {};
  if (isRecord(root.error)) throw new Error(asString(root.error.message) ?? "Ollama stream failed.");
  const message = isRecord(root.message) ? root.message : {};
  const out: OpenAIChunk[] = [];

  const text = asString(message.content) ?? "";
  if (text) out.push({ model: state.model, choices: [{ index: 0, delta: { content: text } }] });

  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      const call = isRecord(raw) ? raw : {};
      const fn = isRecord(call.function) ? call.function : call;
      const index = state.nextToolIndex++;
      state.sawTools = true;
      out.push(
        toolChunk(state.model, index, {
          id: ensureToolCallId(asString(call.id) ?? `call_${index}`),
          name: asString(fn.name) ?? "",
          arguments: repairToolArguments(fn.arguments),
        }),
      );
    }
  }

  if (root.done === true) {
    state.finished = true;
    const doneReason = asString(root.done_reason);
    out.push({
      model: state.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: state.sawTools ? "tool_calls" : doneReason === "length" ? "length" : "stop",
        },
      ],
      usage: {
        prompt_tokens: asNumber(root.prompt_eval_count) ?? 0,
        completion_tokens: asNumber(root.eval_count) ?? 0,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gemini generateContent request/response (tools included)
// ---------------------------------------------------------------------------

/** Anthropic Messages body -> Gemini generateContent request, tools included. */
export function anthropicToGemini(
  body: unknown,
  targetModel: string,
  options: BridgeOptions = {},
): Record<string, unknown> {
  void targetModel;
  const normalized = options.vision === false ? stripAnthropicImages(body) : body;
  const root = isRecord(normalized) ? normalized : {};
  const rawMessages = Array.isArray(root.messages) ? root.messages : [];
  const contents: Record<string, unknown>[] = [];
  const toolNames = new Map<string, string>();

  for (const raw of rawMessages) {
    const message = isRecord(raw) ? raw : {};
    const role = asString(message.role) ?? "user";
    const blocks = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: String(message.content ?? "") }];
    const parts: Record<string, unknown>[] = [];
    for (const rawBlock of blocks) {
      const block = isRecord(rawBlock) ? rawBlock : {};
      if (block.type === "text") {
        parts.push({ text: asString(block.text) ?? "" });
      } else if (block.type === "image" && isRecord(block.source)) {
        parts.push({
          inlineData: {
            mimeType: asString(block.source.media_type) ?? "image/png",
            data: asString(block.source.data) ?? "",
          },
        });
      } else if (block.type === "tool_use") {
        const name = asString(block.name) ?? "";
        const id = asString(block.id) ?? "";
        if (id) toolNames.set(id, name);
        parts.push({ functionCall: { name, args: isRecord(block.input) ? block.input : {} } });
      } else if (block.type === "tool_result") {
        const id = asString(block.tool_use_id) ?? "";
        const text = contentText(block.content);
        parts.push({
          functionResponse: {
            name: toolNames.get(id) ?? "tool",
            // Gemini's native error convention: response.error instead of
            // response.result, so the model sees the call failed.
            response: block.is_error === true ? { error: text } : { result: text },
          },
        });
      }
    }
    if (parts.length > 0) {
      contents.push({ role: role === "assistant" ? "model" : "user", parts });
    }
  }

  const system = root.system;
  const systemText =
    typeof system === "string"
      ? system
      : Array.isArray(system)
        ? system.map((b) => asString(isRecord(b) ? b.text : undefined) ?? "").join("\n")
        : "";

  const functionDeclarations = Array.isArray(root.tools)
    ? root.tools
        .map((raw) => {
          const tool = isRecord(raw) ? raw : {};
          if (tool.type === "function" && isRecord(tool.function)) {
            const fn = tool.function;
            return {
              name: asString(fn.name) ?? "",
              ...(asString(fn.description) !== undefined ? { description: fn.description } : {}),
              ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
            };
          }
          return {
            name: asString(tool.name) ?? "",
            ...(asString(tool.description) !== undefined ? { description: tool.description } : {}),
            ...(tool.input_schema !== undefined ? { parameters: tool.input_schema } : {}),
          };
        })
        .filter((fn) => fn.name)
    : [];

  const generationConfig: Record<string, unknown> = {};
  const maxTokens = asNumber(root.max_tokens);
  if (maxTokens !== undefined) {
    generationConfig.maxOutputTokens = clampMaxTokens(maxTokens, options.maxOutputTokens);
  }
  const temperature = asNumber(root.temperature);
  if (temperature !== undefined) generationConfig.temperature = temperature;

  // Anthropic tool_choice -> Gemini toolConfig.functionCallingConfig.
  // Only meaningful alongside function declarations; disable_parallel_tool_use
  // has no Gemini equivalent and is dropped.
  let toolConfig: Record<string, unknown> | undefined;
  if (functionDeclarations.length > 0) {
    const tc = root.tool_choice;
    if (typeof tc === "string") {
      const mode = tc === "required" ? "ANY" : tc === "none" ? "NONE" : tc === "auto" ? "AUTO" : undefined;
      if (mode) toolConfig = { functionCallingConfig: { mode } };
    } else if (isRecord(tc)) {
      if (tc.type === "auto") {
        toolConfig = { functionCallingConfig: { mode: "AUTO" } };
      } else if (tc.type === "any") {
        toolConfig = { functionCallingConfig: { mode: "ANY" } };
      } else if (tc.type === "none") {
        toolConfig = { functionCallingConfig: { mode: "NONE" } };
      } else if (tc.type === "tool" && asString(tc.name)) {
        toolConfig = {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tc.name] },
        };
      } else if (tc.type === "function") {
        const fn = isRecord(tc.function) ? tc.function : {};
        const name = asString(fn.name) ?? asString(tc.name);
        if (name) {
          toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
        }
      }
    }
  }

  return {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
    ...(toolConfig ? { toolConfig } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

/** Gemini non-streaming response -> OpenAI chat completion body. */
export function geminiToOpenAIResponse(body: unknown, requestedModel: string): Record<string, unknown> {
  const root = isRecord(body) ? body : {};
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const first = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(first.content) ? first.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  let text = "";
  const toolCalls: Record<string, unknown>[] = [];
  for (const raw of parts) {
    const part = isRecord(raw) ? raw : {};
    if (typeof part.text === "string") text += part.text;
    if (isRecord(part.functionCall)) {
      const fn = part.functionCall;
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        type: "function",
        function: { name: asString(fn.name) ?? "", arguments: repairToolArguments(fn.args) },
      });
    }
  }
  const usage = isRecord(root.usageMetadata) ? root.usageMetadata : {};
  const finish = asString(first.finishReason);
  return {
    id: "gemini",
    model: asString(root.modelVersion) ?? requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          toolCalls.length > 0 ? "tool_calls" : finish === "MAX_TOKENS" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: asNumber(usage.promptTokenCount) ?? 0,
      completion_tokens: asNumber(usage.candidatesTokenCount) ?? 0,
    },
  };
}

export interface GeminiStreamState {
  model: string;
  nextToolIndex: number;
  sawTools: boolean;
  usage?: Record<string, number>;
}

export function newGeminiStreamState(model: string): GeminiStreamState {
  return { model, nextToolIndex: 0, sawTools: false };
}

/** One Gemini stream chunk -> OpenAI chat chunks. Caller emits a final chunk. */
export function geminiChunkToChunks(chunk: unknown, state: GeminiStreamState): OpenAIChunk[] {
  const root = isRecord(chunk) ? chunk : {};
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const first = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(first.content) ? first.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const out: OpenAIChunk[] = [];
  for (const raw of parts) {
    const part = isRecord(raw) ? raw : {};
    if (typeof part.text === "string" && part.text) {
      out.push({ model: state.model, choices: [{ index: 0, delta: { content: part.text } }] });
    }
    if (isRecord(part.functionCall)) {
      const index = state.nextToolIndex++;
      state.sawTools = true;
      out.push(
        toolChunk(state.model, index, {
          id: ensureToolCallId(asString(part.functionCall.id) ?? `call_${index}`),
          name: asString(part.functionCall.name) ?? "",
          arguments: repairToolArguments(part.functionCall.args),
        }),
      );
    }
  }
  const usage = isRecord(root.usageMetadata) ? root.usageMetadata : undefined;
  if (usage) {
    state.usage = {
      prompt_tokens: asNumber(usage.promptTokenCount) ?? 0,
      completion_tokens: asNumber(usage.candidatesTokenCount) ?? 0,
    };
  }
  return out;
}

/** Final Gemini chunk from the last candidate's finishReason. */
export function geminiFinalChunk(finishReason: string | undefined, state: GeminiStreamState): OpenAIChunk {
  return {
    model: state.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: state.sawTools ? "tool_calls" : finishReason === "MAX_TOKENS" ? "length" : "stop",
      },
    ],
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Capability gating (runs without vision/tools)
// ---------------------------------------------------------------------------

/**
 * Remove tool definitions and/or image blocks from an Anthropic Messages body
 * before it reaches a model that cannot use them. Deep-enough clone: the input
 * body is never mutated.
 */
/** Replace image blocks with a text marker, including inside tool results. */
function withoutImages(blocks: unknown[]): unknown[] {
  return blocks.map((rawBlock) => {
    const block = isRecord(rawBlock) ? { ...rawBlock } : rawBlock;
    if (!isRecord(block)) return block;
    if (block.type === "image") {
      return { type: "text", text: "[image omitted: this model has no vision]" };
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      block.content = withoutImages(block.content);
    }
    return block;
  });
}

export function gateAnthropicRequestBody(
  body: unknown,
  capabilities: { vision: boolean; tools: boolean },
): Record<string, unknown> {
  const root = isRecord(body) ? { ...body } : {};
  if (!capabilities.tools) {
    delete root.tools;
    delete root.tool_choice;
  }
  if (!capabilities.vision && Array.isArray(root.messages)) {
    root.messages = root.messages.map((raw) => {
      const message = isRecord(raw) ? { ...raw } : raw;
      if (!isRecord(message) || !Array.isArray(message.content)) return message;
      message.content = withoutImages(message.content);
      return message;
    });
  }
  return root;
}
