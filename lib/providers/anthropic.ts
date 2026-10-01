import Anthropic from "@anthropic-ai/sdk";
import type { Block, Msg, ProviderConfig } from "../types";
import { classifyHttp, ProviderError, type ChatRequest, type StreamCallbacks, type TurnResult } from "./types";

// Adaptive thinking exists on the 4.6+ families; older models take no thinking config here.
const ADAPTIVE = /claude-(opus|sonnet|fable|mythos)-(5|4-[678])/;

function toParams(messages: Msg[], model: string): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.blocks.flatMap((b): Anthropic.ContentBlockParam[] => {
      switch (b.type) {
        case "text":
          return b.text ? [{ type: "text", text: b.text }] : [];
        case "image":
          return [{ type: "image", source: { type: "base64", media_type: b.image.mediaType as "image/png", data: b.image.data } }];
        case "thinking":
          // Thinking blocks are bound to the model that produced them; replay only there, unchanged.
          if (b.model !== model) return [];
          if (b.redacted) return [{ type: "redacted_thinking", data: b.redacted }];
          return b.signature ? [{ type: "thinking", thinking: b.thinking, signature: b.signature }] : [];
        case "tool_call":
          return [{ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} }];
        case "tool_result":
          return [
            {
              type: "tool_result",
              tool_use_id: b.id,
              is_error: b.isError || undefined,
              content: [
                { type: "text", text: b.content || "(no output)" },
                ...(b.images ?? []).map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType as "image/png", data: i.data } })),
              ],
            },
          ];
      }
    }),
  }));
}

export async function streamAnthropic(p: ProviderConfig, req: ChatRequest, cb: StreamCallbacks): Promise<TurnResult> {
  const client = new Anthropic({ apiKey: p.apiKey, baseURL: p.baseUrl || "https://api.anthropic.com", maxRetries: 0, timeout: 15 * 60_000 });
  const params: Record<string, unknown> = {
    model: p.model,
    max_tokens: req.maxTokens ?? 64000,
    system: [{ type: "text", text: req.system }],
    messages: toParams(req.messages, p.model),
    cache_control: { type: "ephemeral" },
  };
  if (req.tools.length)
    params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, eager_input_streaming: true }));
  if (ADAPTIVE.test(p.model)) {
    params.thinking = { type: "adaptive", display: "summarized" };
    params.output_config = { effort: "high" };
  }

  try {
    return await run(client, params, req, cb, p.model);
  } catch (e) {
    // Gateways/proxies can re-bind the conversation, invalidating replayed thinking signatures.
    // The API's own guidance is to drop the blocks; do that once and retry.
    if (e instanceof ProviderError && e.kind === "fatal" && /signature/i.test(e.message)) {
      const msgs = params.messages as Anthropic.MessageParam[];
      params.messages = msgs.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.filter((c) => c.type !== "thinking" && c.type !== "redacted_thinking") : m.content }));
      return run(client, params, req, cb, p.model);
    }
    throw e;
  }
}

async function run(client: Anthropic, params: Record<string, unknown>, req: ChatRequest, cb: StreamCallbacks, model: string): Promise<TurnResult> {
  const toolIds: Record<number, string> = {};
  try {
    const stream = client.messages.stream(params as unknown as Anthropic.MessageStreamParams, { signal: req.signal });
    for await (const ev of stream) {
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
        toolIds[ev.index] = ev.content_block.id;
        cb.onToolStart(ev.content_block.id, ev.content_block.name);
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "thinking_delta") cb.onThinking(ev.delta.thinking);
        else if (ev.delta.type === "text_delta") cb.onText(ev.delta.text);
        else if (ev.delta.type === "input_json_delta") cb.onToolInput(toolIds[ev.index], ev.delta.partial_json);
      } else if (ev.type === "content_block_stop") cb.onBlockEnd();
    }
    const msg = await stream.finalMessage();
    const blocks: Block[] = msg.content.flatMap((c): Block[] => {
      if (c.type === "text") return [{ type: "text", text: c.text }];
      if (c.type === "thinking") return [{ type: "thinking", thinking: c.thinking, signature: c.signature, model }];
      if (c.type === "redacted_thinking") return [{ type: "thinking", thinking: "", redacted: c.data, model }];
      if (c.type === "tool_use") return [{ type: "tool_call", id: c.id, name: c.name, input: c.input }];
      return [];
    });
    const sr = msg.stop_reason as string;
    const u = msg.usage;
    return {
      blocks,
      stop: sr === "tool_use" ? "tool_use" : sr === "end_turn" ? "end" : sr === "max_tokens" ? "max_tokens" : sr === "refusal" ? "refusal" : "other",
      usage: { input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens, cached: u.cache_read_input_tokens ?? 0 },
    };
  } catch (e) {
    if (req.signal.aborted) throw new ProviderError("aborted", "stopped");
    if (e instanceof Anthropic.APIError) throw classifyHttp(e.status, e.message, e.headers as unknown as Headers);
    const err = e as Error;
    // Unparseable streamed tool JSON surfaces here; a retry re-issues the turn.
    if (err instanceof SyntaxError) throw new ProviderError("transient", `invalid tool input JSON: ${err.message}`);
    throw classifyHttp(undefined, err.message ?? String(e));
  }
}

export async function listAnthropicModels(p: ProviderConfig) {
  const client = new Anthropic({ apiKey: p.apiKey, baseURL: p.baseUrl || "https://api.anthropic.com", maxRetries: 1 });
  const out: { id: string; context?: number }[] = [];
  for await (const m of client.models.list({ limit: 100 })) out.push({ id: m.id, context: (m as unknown as { max_input_tokens?: number }).max_input_tokens });
  return out;
}
