import OpenAI from "openai";
import type { Block, Msg, ProviderConfig } from "../types";
import { classifyHttp, ProviderError, type ChatRequest, type StreamCallbacks, type TurnResult } from "./types";

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toParams(system: string, messages: Msg[]): ChatMsg[] {
  const out: ChatMsg[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const calls = m.blocks.filter((b) => b.type === "tool_call") as Extract<Block, { type: "tool_call" }>[];
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      });
      continue;
    }
    // Tool results must directly follow the assistant tool_calls; images ride in a following user message.
    const pendingImages: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const b of m.blocks) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.id, content: (b.isError ? "ERROR: " : "") + (b.content || "(no output)") });
        for (const i of b.images ?? []) pendingImages.push({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } });
      } else if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.image.mediaType};base64,${b.image.data}` } });
    }
    const all = [...pendingImages, ...parts];
    if (pendingImages.length && !parts.length) all.unshift({ type: "text", text: "(images returned by the tool calls above)" });
    if (all.length) out.push({ role: "user", content: all.length === 1 && all[0].type === "text" ? all[0].text : all });
  }
  return out;
}

export async function streamOpenAI(p: ProviderConfig, req: ChatRequest, cb: StreamCallbacks): Promise<TurnResult> {
  const client = new OpenAI({ apiKey: p.apiKey || "none", baseURL: p.baseUrl || "https://api.openai.com/v1", maxRetries: 0, timeout: 15 * 60_000 });
  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: p.model,
    messages: toParams(req.system, req.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length)
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));

  let text = "";
  let thinking = "";
  let finish = "";
  let usage = { input: 0, output: 0, cached: 0 };
  const calls: { id: string; name: string; args: string }[] = [];
  let mode: "none" | "text" | "thinking" = "none";
  const switchMode = (next: typeof mode) => {
    if (mode !== next && mode !== "none") cb.onBlockEnd();
    mode = next;
  };

  try {
    const stream = await client.chat.completions.create(body, { signal: req.signal });
    for await (const chunk of stream) {
      if (chunk.usage) {
        const cached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens ?? 0;
        usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens, cached };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta as typeof choice.delta & { reasoning_content?: string; reasoning?: string };
      const r = d.reasoning_content ?? d.reasoning;
      if (r) {
        switchMode("thinking");
        thinking += r;
        cb.onThinking(r);
      }
      if (d.content) {
        switchMode("text");
        text += d.content;
        cb.onText(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        let c = calls[tc.index];
        if (!c) {
          switchMode("none");
          c = calls[tc.index] = { id: tc.id || `call_${Date.now()}_${tc.index}`, name: tc.function?.name ?? "", args: "" };
          cb.onToolStart(c.id, c.name);
        }
        if (tc.function?.arguments) {
          c.args += tc.function.arguments;
          cb.onToolInput(c.id, tc.function.arguments);
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    switchMode("none");
  } catch (e) {
    if (req.signal.aborted) throw new ProviderError("aborted", "stopped");
    if (e instanceof OpenAI.APIError) throw classifyHttp(e.status, e.message, e.headers as unknown as Headers);
    throw classifyHttp(undefined, (e as Error).message ?? String(e));
  }

  const blocks: Block[] = [];
  if (thinking) blocks.push({ type: "thinking", thinking });
  if (text) blocks.push({ type: "text", text });
  for (const c of calls.filter(Boolean)) {
    let input: unknown;
    try {
      input = c.args ? JSON.parse(c.args) : {};
    } catch {
      input = { __invalid_json: c.args };
    }
    blocks.push({ type: "tool_call", id: c.id, name: c.name, input });
  }
  const hasCalls = calls.length > 0;
  return {
    blocks,
    stop: finish === "length" ? "max_tokens" : hasCalls ? "tool_use" : finish === "content_filter" ? "refusal" : "end",
    usage,
  };
}

export async function listOpenAIModels(p: ProviderConfig) {
  const client = new OpenAI({ apiKey: p.apiKey || "none", baseURL: p.baseUrl || "https://api.openai.com/v1", maxRetries: 1 });
  const out: { id: string; context?: number }[] = [];
  for await (const m of client.models.list()) {
    const ctx = (m as unknown as { context_length?: number }).context_length;
    out.push({ id: m.id.replace(/^models\//, ""), context: ctx });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
