import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIStreamTranslator } from "./anthropic-bridge";
import {
  anthropicToGemini,
  anthropicToOllama,
  anthropicToResponses,
  gateAnthropicRequestBody,
  geminiChunkToChunks,
  geminiFinalChunk,
  geminiToOpenAIResponse,
  newGeminiStreamState,
  newOllamaStreamState,
  newResponsesStreamState,
  ollamaLineToChunks,
  ollamaToOpenAIResponse,
  responsesEventToChunks,
  responsesToOpenAIResponse,
} from "./wire-shims";

const anthropicBody = () => ({
  model: "claude-test",
  system: "You are a helper.",
  max_tokens: 128,
  temperature: 0.3,
  stream: true,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "read this" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "tool-1", name: "shell", input: { cmd: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file.txt" }],
    },
  ],
  tools: [
    {
      name: "shell",
      description: "Run a shell command.",
      input_schema: { type: "object", properties: { cmd: { type: "string" } } },
    },
  ],
});

test("anthropicToResponses maps system, tools, images and tool results", () => {
  const out = anthropicToResponses(anthropicBody(), "gpt-5");
  assert.equal(out.model, "gpt-5");
  assert.equal(out.instructions, "You are a helper.");
  assert.equal(out.max_output_tokens, 128);
  assert.equal(out.temperature, 0.3);
  assert.equal(out.stream, true);
  const input = out.input as Record<string, unknown>[];
  const user = input.find((item) => item.role === "user") as {
    content: Record<string, unknown>[];
  };
  assert.deepEqual(user.content[1], { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" });
  assert.ok(input.some((item) => item.type === "function_call" && item.name === "shell"));
  assert.deepEqual(
    input.find((item) => item.type === "function_call_output"),
    { type: "function_call_output", call_id: "tool-1", output: "file.txt" },
  );
  const tools = out.tools as Record<string, unknown>[];
  assert.equal(tools[0]?.name, "shell");
  assert.equal(tools[0]?.type, "function");
});

test("responsesToOpenAIResponse preserves text, tools and usage", () => {
  const out = responsesToOpenAIResponse(
    {
      id: "resp_1",
      model: "gpt-5",
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":"ls"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    "fallback",
  );
  const choice = (out.choices as Record<string, unknown>[])[0] as {
    message: Record<string, unknown>;
    finish_reason: string;
  };
  assert.equal(choice.message.content, "hello");
  assert.equal(choice.finish_reason, "tool_calls");
  const calls = choice.message.tool_calls as Record<string, unknown>[];
  assert.equal(calls[0]?.id, "call_1");
  assert.deepEqual(calls[0]?.function, { name: "shell", arguments: '{"cmd":"ls"}' });
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 4 });
});

test("responsesEventToChunks streams text, arguments and a final chunk", () => {
  const state = newResponsesStreamState("gpt-5");
  const text = responsesEventToChunks(
    { type: "response.output_text.delta", delta: "hi" },
    state,
  );
  assert.deepEqual(text[0]?.choices[0]?.delta, { content: "hi" });

  const added = responsesEventToChunks(
    { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "shell" } },
    state,
  );
  assert.equal(added[0]?.choices[0]?.delta.tool_calls instanceof Array, true);

  const args = responsesEventToChunks(
    { type: "response.function_call_arguments.delta", item_id: "c1", delta: '{"cmd"' },
    state,
  );
  assert.equal(args.length, 1);

  const done = responsesEventToChunks(
    {
      type: "response.completed",
      response: { usage: { input_tokens: 3, output_tokens: 2 } },
    },
    state,
  );
  assert.equal(done[0]?.choices[0]?.finish_reason, "tool_calls");
  assert.deepEqual(done[0]?.usage, { prompt_tokens: 3, completion_tokens: 2 });
});

test("responsesEventToChunks surfaces upstream failures", () => {
  const state = newResponsesStreamState("gpt-5");
  assert.throws(
    () => responsesEventToChunks({ type: "error", error: { message: "upstream exploded" } }, state),
    /upstream exploded/,
  );
});

test("anthropicToOllama flattens messages, images and tools", () => {
  const out = anthropicToOllama(anthropicBody(), "llava:13b");
  assert.equal(out.model, "llava:13b");
  assert.equal(out.stream, true);
  const messages = out.messages as Record<string, unknown>[];
  assert.deepEqual(messages[0], { role: "system", content: "You are a helper." });
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[1]?.content, "read this");
  assert.deepEqual(messages[1]?.images, ["aGVsbG8="]);
  const assistant = messages.find((m) => m.role === "assistant") as {
    tool_calls: Record<string, unknown>[];
  };
  assert.deepEqual(assistant.tool_calls[0]?.function, { name: "shell", arguments: { cmd: "ls" } });
  assert.deepEqual(out.options, { num_predict: 128, temperature: 0.3 });
  assert.equal((out.tools as unknown[]).length, 1);
});

test("ollamaToOpenAIResponse and stream lines map text, tools and usage", () => {
  const body = ollamaToOpenAIResponse(
    {
      model: "llama3.2:3b",
      message: {
        content: "done",
        tool_calls: [{ function: { name: "shell", arguments: { cmd: "ls" } } }],
      },
      prompt_eval_count: 12,
      eval_count: 5,
    },
    "fallback",
  );
  const choice = (body.choices as Record<string, unknown>[])[0] as {
    message: Record<string, unknown>;
    finish_reason: string;
  };
  assert.equal(choice.message.content, "done");
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(body.usage, { prompt_tokens: 12, completion_tokens: 5 });

  const state = newOllamaStreamState("llama3.2:3b");
  const first = ollamaLineToChunks({ message: { content: "hel" }, done: false }, state);
  assert.deepEqual(first[0]?.choices[0]?.delta, { content: "hel" });
  const last = ollamaLineToChunks(
    { message: { content: "lo" }, done: true, done_reason: "stop", prompt_eval_count: 2, eval_count: 1 },
    state,
  );
  assert.equal(last[last.length - 1]?.choices[0]?.finish_reason, "stop");
  assert.deepEqual(last[last.length - 1]?.usage, { prompt_tokens: 2, completion_tokens: 1 });
  assert.equal(state.finished, true);
});

test("anthropicToGemini maps system, images, tool calls and responses", () => {
  const out = anthropicToGemini(anthropicBody(), "ignored-for-url");
  assert.deepEqual(out.systemInstruction, { parts: [{ text: "You are a helper." }] });
  const contents = out.contents as Record<string, unknown>[];
  assert.equal(contents[0]?.role, "user");
  const firstParts = contents[0]?.parts as Record<string, unknown>[];
  assert.deepEqual(firstParts[1], { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } });
  assert.ok(contents.some((c) => c.role === "model" && JSON.stringify(c.parts).includes('"functionCall"')));
  assert.ok(contents.some((c) => JSON.stringify(c.parts).includes('"functionResponse"')));
  const tools = (out.tools as Record<string, unknown>[])[0] as {
    functionDeclarations: Record<string, unknown>[];
  };
  assert.equal(tools.functionDeclarations[0]?.name, "shell");
  assert.deepEqual(out.generationConfig, { maxOutputTokens: 128, temperature: 0.3 });
});

test("Gemini responses and stream chunks map to OpenAI chat shapes", () => {
  const body = geminiToOpenAIResponse(
    {
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          content: {
            parts: [{ text: "hi" }, { functionCall: { name: "shell", args: { cmd: "ls" } } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
    },
    "fallback",
  );
  const choice = (body.choices as Record<string, unknown>[])[0] as {
    message: Record<string, unknown>;
    finish_reason: string;
  };
  assert.equal(choice.message.content, "hi");
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(body.usage, { prompt_tokens: 7, completion_tokens: 3 });

  const state = newGeminiStreamState("gemini-2.5-pro");
  const chunks = geminiChunkToChunks(
    {
      candidates: [{ content: { parts: [{ text: "he" }] } }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
    },
    state,
  );
  assert.deepEqual(chunks[0]?.choices[0]?.delta, { content: "he" });
  const final = geminiFinalChunk("MAX_TOKENS", state);
  assert.equal(final.choices[0]?.finish_reason, "length");
  assert.deepEqual(final.usage, { prompt_tokens: 4, completion_tokens: 1 });
});

test("gateAnthropicRequestBody drops tools and images without mutating the input", () => {
  const body = anthropicBody();
  const snapshot = JSON.stringify(body);
  const gated = gateAnthropicRequestBody(body, { vision: false, tools: false });
  assert.equal(gated.tools, undefined);
  assert.equal(gated.tool_choice, undefined);
  const messages = gated.messages as Record<string, unknown>[];
  const userContent = messages[0]?.content as Record<string, unknown>[];
  assert.deepEqual(userContent[1], {
    type: "text",
    text: "[image omitted: this model has no vision]",
  });
  assert.equal(JSON.stringify(body), snapshot, "input body must not be mutated");

  const visionOnly = gateAnthropicRequestBody(body, { vision: true, tools: false });
  assert.equal(visionOnly.tools, undefined);
  const kept = (visionOnly.messages as Record<string, unknown>[])[0]?.content as Record<string, unknown>[];
  assert.equal(kept[1]?.type, "image");

  const toolsOnly = gateAnthropicRequestBody(body, { vision: false, tools: true });
  assert.ok(Array.isArray(toolsOnly.tools));
  const dropped = (toolsOnly.messages as Record<string, unknown>[])[0]?.content as Record<string, unknown>[];
  assert.equal(dropped[1]?.type, "text");
});

test("gateAnthropicRequestBody strips images nested inside tool results", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "shot:" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "eA==" } },
            ],
          },
        ],
      },
    ],
  };
  const gated = gateAnthropicRequestBody(body, { vision: false, tools: true });
  const message = (gated.messages as Record<string, unknown>[])[0];
  const result = (message.content as Record<string, unknown>[])[0];
  const content = result.content as Record<string, unknown>[];
  assert.equal(content[1]?.type, "text");
  assert.equal(content[1]?.text, "[image omitted: this model has no vision]");
  // The caller's body is untouched.
  assert.equal(
    ((body.messages[0].content[0].content as Record<string, unknown>[])[1].type),
    "image",
  );
});

test("anthropicToResponses: tool_choice, is_error and max_tokens clamp pass through", () => {
  const body = anthropicBody();
  (body.messages[2]!.content as Record<string, unknown>[])[0]!.is_error = true;
  const out = anthropicToResponses(
    { ...body, max_tokens: 64_000, tool_choice: { type: "tool", name: "shell" } },
    "gpt-5",
    { maxOutputTokens: 16_384 },
  );
  assert.equal(out.max_output_tokens, 16_384);
  // Responses named-tool choice is flat: {type:"function", name}.
  assert.deepEqual(out.tool_choice, { type: "function", name: "shell" });
  const input = out.input as Record<string, unknown>[];
  assert.deepEqual(input.find((item) => item.type === "function_call_output"), {
    type: "function_call_output",
    call_id: "tool-1",
    output: "file.txt",
    is_error: true,
  });

  // "any" becomes "required"; disable_parallel_tool_use becomes parallel_tool_calls:false.
  const anyOut = anthropicToResponses(
    { ...anthropicBody(), tool_choice: { type: "any", disable_parallel_tool_use: true } },
    "gpt-5",
  );
  assert.equal(anyOut.tool_choice, "required");
  assert.equal(anyOut.parallel_tool_calls, false);
});

test("anthropicToOllama: is_error passes through and max_tokens clamps to num_predict", () => {
  const body = anthropicBody();
  (body.messages[2]!.content as Record<string, unknown>[])[0]!.is_error = true;
  const out = anthropicToOllama({ ...body, max_tokens: 64_000 }, "llama3.2", {
    maxOutputTokens: 4_096,
  });
  const messages = out.messages as Record<string, unknown>[];
  const tool = messages.find((m) => m.role === "tool")!;
  assert.equal(tool.is_error, true);
  assert.equal((out.options as Record<string, unknown>).num_predict, 4_096);
});

test("anthropicToGemini: is_error, tool_choice and max_tokens clamp map natively", () => {
  const body = anthropicBody();
  (body.messages[2]!.content as Record<string, unknown>[])[0]!.is_error = true;
  const out = anthropicToGemini(
    { ...body, max_tokens: 64_000, tool_choice: { type: "tool", name: "shell" } },
    "gemini-2.5-pro",
    { maxOutputTokens: 8_192 },
  );
  assert.equal((out.generationConfig as Record<string, unknown>).maxOutputTokens, 8_192);
  assert.deepEqual(out.toolConfig, {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["shell"] },
  });
  const contents = out.contents as Record<string, unknown>[];
  const allParts = contents.flatMap((c) => c.parts as Record<string, unknown>[]);
  const fnResponse = allParts.find((p) => p.functionResponse)!.functionResponse as Record<string, unknown>;
  // Gemini's native error convention: response.error, not response.result.
  assert.deepEqual(fnResponse.response, { error: "file.txt" });

  // Non-error results and "any" map to result / ANY without allowed names.
  const okOut = anthropicToGemini(
    { ...anthropicBody(), tool_choice: { type: "any" } },
    "gemini-2.5-pro",
  );
  assert.deepEqual(okOut.toolConfig, { functionCallingConfig: { mode: "ANY" } });
  const okParts = (okOut.contents as Record<string, unknown>[]).flatMap(
    (c) => c.parts as Record<string, unknown>[],
  );
  const okResponse = okParts.find((p) => p.functionResponse)!.functionResponse as Record<string, unknown>;
  assert.deepEqual(okResponse.response, { result: "file.txt" });
});

test("Responses stream: out-of-order deltas, missing ids and malformed arguments stay streamable", () => {
  const state = newResponsesStreamState("gpt-5");
  // An argument delta can arrive before output_item.added; neither carries an
  // id. Both must map to the same non-empty tool call.
  const deltaChunks = responsesEventToChunks(
    { type: "response.function_call_arguments.delta", delta: '{"cmd":"ls' },
    state,
  );
  const addedChunks = responsesEventToChunks(
    { type: "response.output_item.added", item: { type: "function_call", name: "shell" } },
    state,
  );
  const translator = new OpenAIStreamTranslator();
  const events = [
    ...deltaChunks.flatMap((chunk) => translator.push(chunk)),
    ...addedChunks.flatMap((chunk) => translator.push(chunk)),
    ...translator.finish(),
  ];
  const starts = events.filter((event) => {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    return data.type === "content_block_start";
  });
  assert.equal(starts.length, 1);
  const block = (JSON.parse(starts[0]!.data) as { content_block: Record<string, unknown> }).content_block;
  assert.ok(String(block.id).length > 0);
  assert.equal(block.name, "shell");
  const args = events
    .map((event) => JSON.parse(event.data) as Record<string, unknown>)
    .filter((data) => (data.delta as Record<string, unknown> | undefined)?.type === "input_json_delta")
    .map((data) => String((data.delta as Record<string, unknown>).partial_json))
    .join("");
  assert.deepEqual(JSON.parse(args), { cmd: "ls" });

  // A complete-but-malformed argument object at output_item.done is repaired.
  const doneState = newResponsesStreamState("gpt-5");
  const done = responsesEventToChunks(
    {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":1' },
    },
    doneState,
  );
  const call = (done[0]!.choices[0]!.delta.tool_calls as unknown[])[0] as Record<string, unknown>;
  assert.equal(call.id, "call_1");
  assert.deepEqual(JSON.parse(String((call.function as Record<string, unknown>).arguments)), { cmd: 1 });
});

test("Ollama and Gemini stream chunks synthesize ids and repair malformed tool arguments", () => {
  const ollamaState = newOllamaStreamState("llama");
  const ollama = ollamaLineToChunks(
    {
      message: { tool_calls: [{ function: { name: "shell", arguments: '{"cmd":' } }] },
      done: false,
    },
    ollamaState,
  );
  const ollamaCall = (ollama[0]!.choices[0]!.delta.tool_calls as unknown[])[0] as Record<string, unknown>;
  assert.ok(String(ollamaCall.id).length > 0);
  assert.deepEqual(JSON.parse(String((ollamaCall.function as Record<string, unknown>).arguments)), {
    cmd: null,
  });

  const geminiState = newGeminiStreamState("gemini");
  const gemini = geminiChunkToChunks(
    { candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: "nope" } }] } }] },
    geminiState,
  );
  const geminiCall = (gemini[0]!.choices[0]!.delta.tool_calls as unknown[])[0] as Record<string, unknown>;
  assert.ok(String(geminiCall.id).length > 0);
  assert.deepEqual(JSON.parse(String((geminiCall.function as Record<string, unknown>).arguments)), {});
});

test("Responses non-streaming body repairs arguments and synthesizes a missing call id", () => {
  const out = responsesToOpenAIResponse(
    { output: [{ type: "function_call", name: "shell", arguments: '{"cmd":1' }] },
    "fallback",
  );
  const call = ((out.choices as Record<string, unknown>[])[0] as {
    message: { tool_calls: Record<string, unknown>[] };
  }).message.tool_calls[0]!;
  assert.match(String(call.id), /^call_[0-9a-f-]+$/);
  assert.deepEqual(JSON.parse(String((call.function as Record<string, unknown>).arguments)), { cmd: 1 });
});
