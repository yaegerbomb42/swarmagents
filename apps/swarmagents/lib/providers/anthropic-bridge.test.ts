/**
 * Unit tests for the Anthropic <-> OpenAI wire-format bridge
 * (lib/providers/anthropic-bridge.ts): request translation, response
 * translation, SSE translation (incl. tool calls), and token estimation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  anthropicErrorBody,
  anthropicToOpenAI,
  BridgeValidationError,
  estimateInputTokens,
  jsonCompletionSuffix,
  normalizeToolArguments,
  mapStopReason,
  openAIToAnthropicResponse,
  OpenAIStreamTranslator,
  stripUnsignedThinking,
  type AnthropicSseEvent,
} from "./anthropic-bridge";

const TARGET_MODEL = "mock-openai-model";

test("anthropicToOpenAI: system + text/image blocks become OpenAI messages", () => {
  const out = anthropicToOpenAI(
    {
      system: "You are a terse assistant.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this image" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
            },
          ],
        },
      ],
      max_tokens: 512,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ["END"],
    },
    TARGET_MODEL,
  );

  assert.equal(out.model, TARGET_MODEL);
  assert.equal(out.max_tokens, 512);
  assert.equal(out.temperature, 0.5);
  assert.equal(out.top_p, 0.9);
  assert.deepEqual(out.stop, ["END"]);
  const messages = out.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { role: "system", content: "You are a terse assistant." });
  assert.deepEqual(messages[1], {
    role: "user",
    content: [
      { type: "text", text: "describe this image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ],
  });
});

test("anthropicToOpenAI: tools and tool_use/tool_result map to functions and tool messages", () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        {
          role: "user",
          content: "list the files",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "sure" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "app\nlib",
              is_error: false,
            },
            { type: "text", text: "and now summarize" },
          ],
        },
      ],
      tools: [
        {
          name: "Bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
      ],
    },
    TARGET_MODEL,
  );

  // Tools: anthropic shape -> OpenAI function shape.
  assert.deepEqual(out.tools, [
    {
      type: "function",
      function: {
        name: "Bash",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
  ]);

  const messages = out.messages as Array<Record<string, unknown>>;

  // Assistant: tool_use -> tool_calls with JSON-stringified arguments.
  assert.deepEqual(messages[0], { role: "user", content: "list the files" });
  assert.deepEqual(messages[1].role, "assistant");
  assert.equal(messages[1].content, "sure");
  assert.deepEqual(messages[1].tool_calls, [
    {
      id: "toolu_1",
      type: "function",
      function: { name: "Bash", arguments: '{"command":"ls"}' },
    },
  ]);

  // User: tool_result -> tool message, remaining text stays a user message.
  assert.deepEqual(messages[2], {
    role: "tool",
    tool_call_id: "toolu_1",
    content: "app\nlib",
  });
  assert.deepEqual(messages[3], { role: "user", content: "and now summarize" });
});

test("anthropicToOpenAI: pre-shaped OpenAI tools pass through", () => {
  const out = anthropicToOpenAI(
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "f", parameters: { type: "object" } } },
      ],
    },
    TARGET_MODEL,
  );
  assert.deepEqual(out.tools, [
    { type: "function", function: { name: "f", parameters: { type: "object" } } },
  ]);
});

test("anthropicToOpenAI: tool_use with non-string input stringifies", () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_9", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
      ],
    },
    TARGET_MODEL,
  );
  const messages = out.messages as Array<Record<string, unknown>>;
  const calls = messages[0].tool_calls as Array<Record<string, unknown>>;
  assert.equal(calls[0].id, "toolu_9");
  assert.equal((calls[0].function as Record<string, unknown>).arguments, '{"file_path":"a.ts"}');
});

test("anthropicToOpenAI: stream flag adds stream_options.include_usage", () => {
  const out = anthropicToOpenAI(
    { messages: [{ role: "user", content: "hi" }], stream: true },
    TARGET_MODEL,
  );
  assert.equal(out.stream, true);
  assert.deepEqual(out.stream_options, { include_usage: true });
});

test("anthropicToOpenAI: empty/absent messages throw BridgeValidationError", () => {
  assert.throws(() => anthropicToOpenAI({ messages: [] }, TARGET_MODEL), BridgeValidationError);
  assert.throws(() => anthropicToOpenAI({}, TARGET_MODEL), BridgeValidationError);
});

test("mapStopReason maps OpenAI finish reasons to Anthropic stop reasons", () => {
  assert.equal(mapStopReason("stop"), "end_turn");
  assert.equal(mapStopReason("length"), "max_tokens");
  assert.equal(mapStopReason("tool_calls"), "tool_use");
  assert.equal(mapStopReason("function_call"), "tool_use");
  assert.equal(mapStopReason("content_filter"), "end_turn");
  assert.equal(mapStopReason(undefined), null);
});

test("openAIToAnthropicResponse: text completion maps content, stop reason and usage", () => {
  const inBody = {
    id: "chatcmpl-123",
    object: "chat.completion",
    model: TARGET_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello, world!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
  };

  const out = openAIToAnthropicResponse(inBody, TARGET_MODEL);
  assert.equal(out.type, "message");
  assert.equal(out.role, "assistant");
  assert.equal(out.model, TARGET_MODEL);
  assert.equal(out.stop_reason, "end_turn");
  assert.equal(out.stop_sequence, null);
  assert.deepEqual(out.content, [{ type: "text", text: "Hello, world!" }]);
  assert.deepEqual(out.usage, { input_tokens: 11, output_tokens: 3 });
});

test("openAIToAnthropicResponse: cached tokens map to cache_read_input_tokens", () => {
  const out = openAIToAnthropicResponse({
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 40,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 25 },
    },
  }, TARGET_MODEL);
  assert.deepEqual(out.usage, {
    input_tokens: 40,
    output_tokens: 5,
    cache_read_input_tokens: 25,
  });
});

test("openAIToAnthropicResponse: provider without usage omits the usage object", () => {
  const out = openAIToAnthropicResponse({
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  }, TARGET_MODEL);
  assert.deepEqual(out.usage, {});
});

test("openAIToAnthropicResponse: tool_calls become tool_use blocks", () => {
  const inBody = {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_x1",
              type: "function",
              function: { name: "Bash", arguments: '{"command":"ls -la"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 5 },
  };

  const out = openAIToAnthropicResponse(inBody, TARGET_MODEL);
  assert.equal(out.stop_reason, "tool_use");
  assert.deepEqual(out.content, [
    { type: "tool_use", id: "call_x1", name: "Bash", input: { command: "ls -la" } },
  ]);
});

test("openAIToAnthropicResponse: a lowercased tool name is repaired to the declared name", () => {
  const inBody = {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_l", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
            { id: "call_r", type: "function", function: { name: "read", arguments: '{"file_path":"a.ts"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const declared = new Set(["Bash", "Read", "Write"]);
  const out = openAIToAnthropicResponse(inBody, TARGET_MODEL, declared);
  assert.deepEqual(out.content, [
    { type: "tool_use", id: "call_l", name: "Bash", input: { command: "ls" } },
    { type: "tool_use", id: "call_r", name: "Read", input: { file_path: "a.ts" } },
  ]);
});

test("openAIToAnthropicResponse: an exact or unknown tool name is left untouched", () => {
  const inBody = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "Bash", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "mystery_tool", arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const out = openAIToAnthropicResponse(inBody, TARGET_MODEL, new Set(["Bash", "Read"]));
  const names = (out.content as Array<{ name: string }>).map((b) => b.name);
  assert.deepEqual(names, ["Bash", "mystery_tool"]);
});

test("openAIToAnthropicResponse: without declared tools the name is unchanged", () => {
  const inBody = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "x", type: "function", function: { name: "bash", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
  const out = openAIToAnthropicResponse(inBody, TARGET_MODEL);
  assert.equal((out.content as Array<{ name: string }>)[0].name, "bash");
});

test("openAIToAnthropicResponse: length truncation maps to max_tokens", () => {
  const out = openAIToAnthropicResponse(
    {
      choices: [{ message: { content: "x".repeat(20) }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 20 },
    },
    TARGET_MODEL,
  );
  assert.equal(out.stop_reason, "max_tokens");
});

test("openAIToAnthropicResponse: upstream error body throws", () => {
  assert.throws(
    () => openAIToAnthropicResponse({ error: { message: "boom" } }, TARGET_MODEL),
    BridgeValidationError,
  );
});

test("OpenAIStreamTranslator: text deltas become message/content_block/delta/stop events", () => {
  const translator = new OpenAIStreamTranslator();
  const events: string[] = [];

  const first = translator.push({
    id: "chatcmpl-1",
    model: TARGET_MODEL,
    choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }],
  });
  for (const e of first) events.push(e.event ?? "data");

  assert.deepEqual(events, ["message_start", "content_block_start", "content_block_delta"]);
  const start = first[0];
  const startData = JSON.parse(start.data);
  assert.equal(startData.type, "message_start");
  assert.equal(startData.message.model, TARGET_MODEL);
  assert.equal(startData.message.role, "assistant");
  assert.equal(startData.message.content.length, 0);

  const blockStart = first[1];
  assert.deepEqual(JSON.parse(blockStart.data), {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  assert.deepEqual(JSON.parse(first[2].data), {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  });

  const more = translator.push({
    choices: [{ index: 0, delta: { content: " world" } }],
  });
  assert.equal(more[0].event, "content_block_delta");

  // finish_reason + usage arrive together: finalize immediately.
  const final = translator.push({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  });
  const kinds = final.map((e) => e.event);
  assert.deepEqual(kinds, ["content_block_stop", "message_delta", "message_stop"]);
  const delta = JSON.parse(final[1].data);
  assert.equal(delta.type, "message_delta");
  assert.equal(delta.delta.stop_reason, "end_turn");
  // Both directions of the mapping must survive: prompt_tokens -> input_tokens
  // and completion_tokens -> output_tokens.
  assert.deepEqual(delta.usage, { input_tokens: 4, output_tokens: 2 });

  // After message_stop, no further events.
  assert.deepEqual(translator.push({ choices: [{ delta: { content: "ignored" } }] }), []);
  assert.deepEqual(translator.finish(), []);
});

test("OpenAIStreamTranslator: tool_call deltas become tool_use blocks with input_json_delta", () => {
  const translator = new OpenAIStreamTranslator();
  const all: string[] = [];

  // First tool_call chunk: attributes split across frames.
  const c1 = translator.push({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: "call_a", function: { name: "Bash", arguments: "" } }],
        },
      },
    ],
  });
  all.push(...c1.map((e) => e.event ?? "data"));
  const start = c1.find((e) => e.event === "content_block_start")!;
  assert.equal(JSON.parse(start.data).content_block.type, "tool_use");
  assert.equal(JSON.parse(start.data).content_block.name, "Bash");

  const c2 = translator.push({
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"command" } }] } },
    ],
  });
  all.push(...c2.map((e) => e.event ?? "data"));
  // Arguments are buffered until the block closes: a prefix is never
  // committed downstream before it is known to be complete.
  assert.equal(c2.filter((e) => e.event === "content_block_delta").length, 0);

  const c3 = translator.push({
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\":\"ls\"}" } }] } },
    ],
  });
  const c4 = translator.push({
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  });
  const kinds = [...all, ...c3.map((e) => e.event ?? "data"), ...c4.map((e) => e.event ?? "data")];
  const argDelta = c4.find((e) => e.event === "content_block_delta")!;
  assert.equal(JSON.parse(argDelta.data).delta.type, "input_json_delta");
  assert.deepEqual(JSON.parse(JSON.parse(argDelta.data).delta.partial_json), { command: "ls" });
  assert.ok(kinds.includes("message_start"));
  assert.ok(kinds.includes("content_block_start"));
  assert.ok(kinds.includes("content_block_delta"));
  assert.ok(kinds.includes("content_block_stop"));
  assert.ok(kinds.includes("message_delta"));
  assert.ok(kinds.includes("message_stop"));
  const stop = c4.find((e) => e.event === "message_delta")!;
  assert.equal(JSON.parse(stop.data).delta.stop_reason, "tool_use");
});

test("OpenAIStreamTranslator: a lowercased streamed tool name is repaired to the declared name", () => {
  const translator = new OpenAIStreamTranslator(new Set(["Bash", "Read"]));
  const c1 = translator.push({
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "bash", arguments: "" } }] },
      },
    ],
  });
  const start = c1.find((e) => e.event === "content_block_start")!;
  assert.equal(JSON.parse(start.data).content_block.name, "Bash");
});

test("OpenAIStreamTranslator: usage-only trailing chunk still surfaces both token counts", () => {
  const translator = new OpenAIStreamTranslator();
  // Some providers send usage as a separate final chunk (no finish_reason,
  // no choices) right before [DONE]; it must still reach the final delta.
  translator.push({
    choices: [{ index: 0, delta: { content: "hi" } }],
  });
  translator.push({
    choices: [],
    usage: { prompt_tokens: 21, completion_tokens: 7 },
  });
  const final = translator.finish();
  const delta = final.find((e) => e.event === "message_delta")!;
  assert.deepEqual(JSON.parse(delta.data).usage, { input_tokens: 21, output_tokens: 7 });

  const stopped = final.find((e) => e.event === "message_stop")!;
  assert.equal(JSON.parse(stopped.data).type, "message_stop");
});

test("OpenAIStreamTranslator: cache tokens map to cache_read_input_tokens", () => {
  const translator = new OpenAIStreamTranslator();
  translator.push({
    choices: [{ index: 0, delta: { content: "hi" } }],
  });
  const final = translator.push({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 8,
      prompt_tokens_details: { cached_tokens: 30 },
    },
  });
  const delta = final.find((e) => e.event === "message_delta")!;
  assert.deepEqual(JSON.parse(delta.data).usage, {
    input_tokens: 50,
    output_tokens: 8,
    cache_read_input_tokens: 30,
  });
});

test("OpenAIStreamTranslator: provider without usage emits no fabricated counts", () => {
  const translator = new OpenAIStreamTranslator();
  const start = translator.push({
    choices: [{ index: 0, delta: { content: "hi" } }],
  });
  // message_start usage has no input count (nothing reported yet).
  const startData = JSON.parse(start[0].data);
  assert.deepEqual(startData.message.usage, {});
  translator.push({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const final = translator.finish();
  const delta = final.find((e) => e.event === "message_delta")!;
  // No upstream usage ever arrived: the usage object stays empty so Claude
  // never sees fabricated zeros.
  assert.deepEqual(JSON.parse(delta.data).usage, {});
});

test("anthropicErrorBody builds Anthropic-shaped error envelopes", () => {
  assert.equal(anthropicErrorBody(429, "slow down"), JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: "slow down" },
  }));
  assert.equal(anthropicErrorBody(404, "missing"), JSON.stringify({
    type: "error",
    error: { type: "not_found_error", message: "missing" },
  }));
  assert.equal(anthropicErrorBody(502, "boom"), JSON.stringify({
    type: "error",
    error: { type: "api_error", message: "boom" },
  }));
});

test("estimateInputTokens counts system, messages, tool blocks", () => {
  const body = {
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "hello world" },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", data: "x" } },
          { type: "tool_result", tool_use_id: "toolu_1", content: "output" },
          { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "pwd" } },
        ],
      },
    ],
    tools: [{ name: "Grep", description: "search", input_schema: { type: "object" } }],
  };
  const n = estimateInputTokens(body);
  assert.ok(n > 50, `expected a meaningful estimate, got ${n}`);
  const withoutTools = estimateInputTokens({ ...body, tools: undefined });
  assert.ok(withoutTools < n, "tools add tokens");
});

test("anthropicToOpenAI: tool_result is_error survives as an extension field", () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_err", content: "exit 1: boom", is_error: true },
            { type: "tool_result", tool_use_id: "toolu_ok", content: "done" },
          ],
        },
      ],
    },
    TARGET_MODEL,
  );
  const messages = out.messages as Array<Record<string, unknown>>;
  // Error results carry the flag; successful ones stay byte-identical.
  assert.deepEqual(messages[0], {
    role: "tool",
    tool_call_id: "toolu_err",
    content: "exit 1: boom",
    is_error: true,
  });
  assert.deepEqual(messages[1], {
    role: "tool",
    tool_call_id: "toolu_ok",
    content: "done",
  });
});

test("anthropicToOpenAI: tool_choice variants map to OpenAI shapes", () => {
  const tools = [{ name: "Bash", input_schema: { type: "object" } }];
  const base = { messages: [{ role: "user", content: "hi" }], tools };

  assert.equal(
    anthropicToOpenAI({ ...base, tool_choice: { type: "auto" } }, TARGET_MODEL).tool_choice,
    "auto",
  );
  assert.equal(
    anthropicToOpenAI({ ...base, tool_choice: { type: "any" } }, TARGET_MODEL).tool_choice,
    "required",
  );
  assert.equal(
    anthropicToOpenAI({ ...base, tool_choice: { type: "none" } }, TARGET_MODEL).tool_choice,
    "none",
  );
  assert.deepEqual(
    anthropicToOpenAI({ ...base, tool_choice: { type: "tool", name: "Bash" } }, TARGET_MODEL).tool_choice,
    { type: "function", function: { name: "Bash" } },
  );
  // disable_parallel_tool_use -> parallel_tool_calls: false.
  const noParallel = anthropicToOpenAI(
    { ...base, tool_choice: { type: "auto", disable_parallel_tool_use: true } },
    TARGET_MODEL,
  );
  assert.equal(noParallel.tool_choice, "auto");
  assert.equal(noParallel.parallel_tool_calls, false);
  // Pre-shaped OpenAI choices pass through.
  assert.equal(
    anthropicToOpenAI({ ...base, tool_choice: "required" }, TARGET_MODEL).tool_choice,
    "required",
  );
  assert.deepEqual(
    anthropicToOpenAI(
      { ...base, tool_choice: { type: "function", function: { name: "Bash" } } },
      TARGET_MODEL,
    ).tool_choice,
    { type: "function", function: { name: "Bash" } },
  );
  // Absent tool_choice stays absent; without tools it is dropped entirely.
  assert.equal("tool_choice" in anthropicToOpenAI(base, TARGET_MODEL), false);
  const noTools = anthropicToOpenAI(
    { messages: [{ role: "user", content: "hi" }], tool_choice: { type: "any" } },
    TARGET_MODEL,
  );
  assert.equal("tool_choice" in noTools, false);
});

test("anthropicToOpenAI: thinking blocks and cache_control are stripped by default", () => {
  const out = anthropicToOpenAI(
    {
      system: [
        { type: "text", text: "Be terse.", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "check the files first" },
            { type: "redacted_thinking", data: "encrypted" },
            { type: "text", text: "looking", cache_control: { type: "ephemeral" } },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "a.ts", cache_control: { type: "ephemeral" } }],
            },
          ],
        },
      ],
      // Extended-thinking budget: an Anthropic-only request parameter.
      thinking: { type: "enabled", budget_tokens: 1000 },
    },
    TARGET_MODEL,
  );

  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes("thinking"), "no thinking anywhere in the payload");
  assert.ok(!serialized.includes("cache_control"), "no cache_control anywhere in the payload");
  assert.ok(!serialized.includes("redacted_thinking"), "no redacted_thinking anywhere");

  const messages = out.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0], { role: "system", content: "Be terse." });
  assert.equal(messages[1].content, "looking");
  assert.ok(Array.isArray(messages[1].tool_calls));
  assert.deepEqual(messages[2], { role: "tool", tool_call_id: "toolu_1", content: "a.ts" });
});

test("anthropicToOpenAI: reasoningContent translates thinking blocks to reasoning_content", () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "list first, then summarize" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
        ],
      },
    ],
  };
  const out = anthropicToOpenAI(body, TARGET_MODEL, { reasoningContent: true });
  const messages = out.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0].reasoning_content, "list first, then summarize");
  assert.ok(Array.isArray(messages[0].tool_calls));

  // Without the flag the same body strips the thinking block.
  const stripped = anthropicToOpenAI(body, TARGET_MODEL);
  assert.equal("reasoning_content" in (stripped.messages as Array<Record<string, unknown>>)[0], false);
});

test("anthropicToOpenAI: a thinking-only assistant message is dropped, not emptied", () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm" }],
        },
        { role: "user", content: "and then?" },
      ],
    },
    TARGET_MODEL,
  );
  const messages = out.messages as Array<Record<string, unknown>>;
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "user"],
    "the empty assistant message must not reach a strict upstream",
  );
  assert.ok(!JSON.stringify(out).includes("thinking"));
});

test("anthropicToOpenAI: a string-content assistant message still passes through", () => {
  const out = anthropicToOpenAI(
    {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "on it" },
      ],
    },
    TARGET_MODEL,
  );
  const messages = out.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[1], { role: "assistant", content: "on it" });
});

test("openAIToAnthropicResponse: reasoning_content becomes a leading thinking block", () => {
  const out = openAIToAnthropicResponse(
    {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "done",
            reasoning_content: "checked the files",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "Bash", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 3 },
    },
    TARGET_MODEL,
  );
  assert.equal(out.stop_reason, "tool_use");
  assert.deepEqual(out.content, [
    { type: "thinking", thinking: "checked the files" },
    { type: "text", text: "done" },
    { type: "tool_use", id: "call_1", name: "Bash", input: {} },
  ]);

  // The `reasoning` field some gateways use maps the same way.
  const viaReasoning = openAIToAnthropicResponse(
    {
      choices: [
        { index: 0, message: { role: "assistant", content: "ok", reasoning: "why" }, finish_reason: "stop" },
      ],
    },
    TARGET_MODEL,
  );
  assert.deepEqual(viaReasoning.content, [
    { type: "thinking", thinking: "why" },
    { type: "text", text: "ok" },
  ]);

  // Absent reasoning stays absent: no fabricated thinking block.
  const plain = openAIToAnthropicResponse(
    {
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    },
    TARGET_MODEL,
  );
  assert.deepEqual(plain.content, [{ type: "text", text: "ok" }]);
});

test("OpenAIStreamTranslator: reasoning_content deltas become thinking blocks and deltas", () => {
  const translator = new OpenAIStreamTranslator();
  const events: Array<{ event?: string; data: Record<string, unknown> }> = [];
  const collect = (list: ReturnType<OpenAIStreamTranslator["push"]>) => {
    for (const e of list) events.push({ event: e.event, data: JSON.parse(e.data) });
  };

  collect(
    translator.push({
      choices: [{ index: 0, delta: { reasoning_content: "first, list" } }],
    }),
  );
  collect(
    translator.push({
      choices: [{ index: 0, delta: { reasoning_content: " the files" } }],
    }),
  );
  collect(
    translator.push({
      choices: [{ index: 0, delta: { content: "checking" } }],
    }),
  );
  collect(
    translator.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "call_a", function: { name: "Bash", arguments: "{}" } }],
          },
        },
      ],
    }),
  );
  collect(
    translator.push({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    }),
  );

  const kinds = events.map((e) => e.event);
  assert.deepEqual(kinds, [
    "message_start",
    "content_block_start", // thinking block 0
    "content_block_delta",
    "content_block_delta",
    "content_block_stop", // thinking closes before text starts
    "content_block_start", // text block 1
    "content_block_delta",
    "content_block_stop", // text closes before the tool block
    "content_block_start", // tool_use block 2
    "content_block_delta", // input_json_delta for the tool arguments
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);

  const thinkStart = events[1].data as { content_block: Record<string, unknown> };
  assert.equal(thinkStart.content_block.type, "thinking");
  assert.equal((events[2].data as { delta: Record<string, unknown> }).delta.type, "thinking_delta");
  assert.equal((events[2].data as { delta: Record<string, unknown> }).delta.thinking, "first, list");
  assert.equal((events[3].data as { delta: Record<string, unknown> }).delta.thinking, " the files");
  const delta = events.find((e) => e.event === "message_delta")!.data as {
    delta: Record<string, unknown>;
  };
  assert.equal(delta.delta.stop_reason, "tool_use");
});

test("OpenAIStreamTranslator: reasoning arriving after text started is dropped, not misplaced", () => {
  const translator = new OpenAIStreamTranslator();
  const events: Array<{ event?: string; data: Record<string, unknown> }> = [];
  const collect = (list: ReturnType<OpenAIStreamTranslator["push"]>) => {
    for (const e of list) events.push({ event: e.event, data: JSON.parse(e.data) });
  };

  collect(translator.push({ choices: [{ index: 0, delta: { content: "hi" } }] }));
  // Anthropic requires thinking blocks to precede all other blocks, so a
  // late reasoning delta has no valid place in the message.
  collect(translator.push({ choices: [{ index: 0, delta: { reasoning_content: "too late" } }] }));
  collect(
    translator.push({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
  );

  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("too late"), "late reasoning must not leak into the message");
  assert.ok(!serialized.includes("thinking_delta"));
  assert.equal(events[1].data.type, "content_block_start");
  assert.equal((events[1].data as { content_block: Record<string, unknown> }).content_block.type, "text");
});

test("multi-turn tool loop: thinking survives the round trip when the provider preserves reasoning", () => {
  // Turn 1 (streaming response from a reasoning provider): reasoning +
  // tool call. The translator must surface both to Claude Code.
  const translator = new OpenAIStreamTranslator();
  const streamed: Array<{ event?: string; data: Record<string, unknown> }> = [];
  for (const chunk of [
    { choices: [{ index: 0, delta: { reasoning_content: "run ls" } }] },
    { choices: [{ index: 0, delta: { content: "on it" } }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "Bash", arguments: '{"command":"ls"}' } }],
          },
        },
      ],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    },
  ]) {
    for (const e of translator.push(chunk)) streamed.push({ event: e.event, data: JSON.parse(e.data) });
  }
  const thinkDelta = streamed.find(
    (e) => (e.data as { delta?: Record<string, unknown> }).delta?.type === "thinking_delta",
  );
  assert.equal((thinkDelta!.data as { delta: Record<string, unknown> }).delta.thinking, "run ls");

  // Turn 2 (request back to the same provider): Claude Code sends the
  // thinking block it received plus the tool result. With reasoningContent
  // the bridge carries the reasoning as reasoning_content; without it the
  // block is stripped and the loop still works, just without the context.
  const turn2 = {
    messages: [
      { role: "user", content: "list the files" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "run ls" },
          { type: "text", text: "on it" },
          { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.ts\nb.ts" }],
      },
    ],
  };
  const preserved = anthropicToOpenAI(turn2, TARGET_MODEL, { reasoningContent: true });
  const preservedMessages = preserved.messages as Array<Record<string, unknown>>;
  assert.equal(preservedMessages[1].reasoning_content, "run ls");
  assert.equal(preservedMessages[1].content, "on it");
  assert.deepEqual(preservedMessages[2], {
    role: "tool",
    tool_call_id: "call_1",
    content: "a.ts\nb.ts",
  });

  const stripped = anthropicToOpenAI(turn2, TARGET_MODEL);
  const strippedMessages = stripped.messages as Array<Record<string, unknown>>;
  assert.equal("reasoning_content" in strippedMessages[1], false);
  assert.equal(strippedMessages[1].content, "on it");
  assert.deepEqual(strippedMessages[2], {
    role: "tool",
    tool_call_id: "call_1",
    content: "a.ts\nb.ts",
  });
});

test("anthropicToOpenAI: max_tokens clamps to the model's output cap", () => {
  const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 64_000 };
  // Above the cap: clamped. Below the cap: unchanged. No cap: unchanged.
  assert.equal(anthropicToOpenAI(body, TARGET_MODEL, { maxOutputTokens: 8_192 }).max_tokens, 8_192);
  assert.equal(
    anthropicToOpenAI({ ...body, max_tokens: 512 }, TARGET_MODEL, { maxOutputTokens: 8_192 }).max_tokens,
    512,
  );
  assert.equal(anthropicToOpenAI(body, TARGET_MODEL).max_tokens, 64_000);
  assert.equal(anthropicToOpenAI(body, TARGET_MODEL, { maxOutputTokens: 0 }).max_tokens, 64_000);
  // Absent max_tokens stays absent even with a cap.
  const noMax = anthropicToOpenAI({ messages: [{ role: "user", content: "hi" }] }, TARGET_MODEL, {
    maxOutputTokens: 8_192,
  });
  assert.equal("max_tokens" in noMax, false);
});

test("anthropicToOpenAI: vision=false replaces user and tool_result images with text placeholders", () => {
  const b64 = "iVBORw0KGgo=";
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "screenshot", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "Captured." },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
            ],
          },
        ],
      },
    ],
  };

  // Default / vision=true preserves image_url parts.
  const withVision = anthropicToOpenAI(body, TARGET_MODEL) as {
    messages: { role: string; content: unknown }[];
  };
  assert.ok(Array.isArray(withVision.messages[0].content));
  assert.equal((withVision.messages[0].content as { type: string }[])[1].type, "image_url");

  // vision=false strips both user images and tool_result images into text placeholders.
  const withoutVision = anthropicToOpenAI(body, TARGET_MODEL, { vision: false }) as {
    messages: { role: string; content: unknown }[];
  };
  assert.equal(typeof withoutVision.messages[0].content, "string");
  assert.match(withoutVision.messages[0].content as string, /\[image omitted: model lacks vision; mediaType=image\/png; bytes=9\]/);
  assert.equal(typeof withoutVision.messages[2].content, "string");
  assert.match(withoutVision.messages[2].content as string, /Captured\./);
  assert.match(withoutVision.messages[2].content as string, /mediaType=image\/jpeg/);
  // Original input body was not mutated.
  assert.equal((body.messages[0].content[1] as { type: string }).type, "image");
});

// ---------------------------------------------------------------------------
// Streaming tool-call repair (core-05): malformed/truncated JSON, missing ids,
// out-of-order choices and arbitrary junk must never break the SSE stream.
// ---------------------------------------------------------------------------

interface CollectedTool {
  id: string;
  name: string;
  json: string;
}

/** Replay the tool_use blocks a client would reconstruct from Anthropic SSE. */
function toolBlocksFrom(events: AnthropicSseEvent[]): CollectedTool[] {
  const byIndex = new Map<number, CollectedTool>();
  for (const event of events) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      assert.fail(`invalid SSE data: ${event.data}`);
    }
    const block = data.content_block as Record<string, unknown> | undefined;
    if (data.type === "content_block_start" && block?.type === "tool_use") {
      byIndex.set(data.index as number, {
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        json: "",
      });
    } else if (data.type === "content_block_delta") {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (delta?.type === "input_json_delta") {
        const tool = byIndex.get(data.index as number);
        if (tool) tool.json += String(delta.partial_json ?? "");
      }
    }
  }
  return [...byIndex.values()];
}

function runStream(chunks: unknown[]): AnthropicSseEvent[] {
  const translator = new OpenAIStreamTranslator();
  const events: AnthropicSseEvent[] = [];
  for (const chunk of chunks) events.push(...translator.push(chunk));
  events.push(...translator.finish());
  return events;
}

test("jsonCompletionSuffix completes truncated JSON and rejects garbage", () => {
  assert.equal(jsonCompletionSuffix('{"a":1'), "}");
  assert.equal(jsonCompletionSuffix('{"a":"bc'), '"}');
  assert.equal(jsonCompletionSuffix("[1,2"), "]");
  assert.equal(jsonCompletionSuffix('{"a":'), "null}");
  assert.equal(jsonCompletionSuffix(""), "{}");
  assert.equal(jsonCompletionSuffix("not json"), null);
  assert.equal(jsonCompletionSuffix('{"a":1} trailing'), null);
  for (const prefix of ['{"a":"bc', '{"a":1', "[1,2", '{"a":', "", '{"a": tru', '{"x\\"y":"z', "1e", "-"]) {
    const suffix = jsonCompletionSuffix(prefix);
    assert.notEqual(suffix, null, `no suffix for ${JSON.stringify(prefix)}`);
    assert.doesNotThrow(() => JSON.parse(prefix + suffix), `${prefix} + ${suffix} is not JSON`);
  }
});

test("OpenAIStreamTranslator synthesizes stable ids and indices for missing tool_call fields", () => {
  const events = runStream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ function: { name: "Bash", arguments: '{"a"' } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ function: { arguments: ":1}" } }],
          },
        },
      ],
    },
  ]);
  const tools = toolBlocksFrom(events);
  assert.equal(tools.length, 1, "fragments without index must form one tool block");
  assert.match(tools[0].id, /^call_[0-9a-f-]+$/);
  assert.equal(tools[0].name, "Bash");
  assert.deepEqual(JSON.parse(tools[0].json), { a: 1 });
});

test("OpenAIStreamTranslator picks the primary choice and ignores padding", () => {
  const events = runStream([
    {
      choices: [
        { index: 1, delta: { content: "wrong" } },
        { index: 0, delta: { content: "right" } },
      ],
    },
    { choices: [null, { delta: { content: " - second" } }] },
    { choices: [] }, // usage-only chunk
  ]);
  const texts = events
    .map((event) => JSON.parse(event.data) as Record<string, unknown>)
    .filter((data) => {
      const delta = data.delta as Record<string, unknown> | undefined;
      return data.type === "content_block_delta" && delta?.type === "text_delta";
    })
    .map((data) => String((data.delta as Record<string, unknown>).text));
  assert.deepEqual(texts, ["right", " - second"]);
  assert.equal(events.filter((e) => JSON.parse(e.data).type === "message_stop").length, 1);
});

test("OpenAIStreamTranslator survives empty and malformed chunks without throwing", () => {
  let events: AnthropicSseEvent[] = [];
  assert.doesNotThrow(() => {
    events = runStream([
      null,
      42,
      [],
      {},
      { choices: null },
      { choices: [null] },
      { choices: [{ delta: null }] },
      { choices: [{ delta: { tool_calls: [null, 7] } }] },
    ]);
  });
  const kinds = events.map((event) => JSON.parse(event.data).type);
  assert.ok(kinds.includes("message_start"));
  assert.ok(kinds.includes("message_stop"));
  for (const tool of toolBlocksFrom(events)) {
    assert.ok(tool.id.length > 0, "synthesized tool ids are never empty");
    // A tool with no arguments keeps the `{}` input from content_block_start.
    if (tool.json.length > 0) assert.doesNotThrow(() => JSON.parse(tool.json));
  }
});

/** The text the model sees in-band (notices about neutralized calls). */
function textFrom(events: AnthropicSseEvent[]): string {
  return events
    .map((event) => JSON.parse(event.data) as Record<string, unknown>)
    .filter((data) => (data.delta as Record<string, unknown> | undefined)?.type === "text_delta")
    .map((data) => String((data.delta as Record<string, unknown>).text))
    .join("");
}

test("OpenAIStreamTranslator never runs a tool with a truncated string argument", () => {
  // A stream cut off by the length cap mid-command must not become a
  // different, shorter command.
  const events = runStream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_rm", function: { name: "Bash", arguments: '{"command":"rm -rf /home/user/old-bu' } },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 9 } },
  ]);
  const tools = toolBlocksFrom(events);
  assert.equal(tools[0].id, "call_rm");
  assert.deepEqual(JSON.parse(tools[0].json), {}, "truncated input is neutralized, not completed");
  assert.match(textFrom(events), /Bash \(call_rm\) was not run with its arguments: the provider cut the arguments off/);
  const stop = events.map((e) => JSON.parse(e.data)).find((d) => d.type === "message_delta");
  assert.equal(stop.delta.stop_reason, "max_tokens");
});

test("OpenAIStreamTranslator neutralizes a Write whose content was cut off", () => {
  const events = runStream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "Write", arguments: '{"path":"/tmp/a","content":"hi' } },
            ],
          },
        },
      ],
    },
  ]);
  const tools = toolBlocksFrom(events);
  assert.deepEqual(JSON.parse(tools[0].json), {});
  assert.match(textFrom(events), /Write \(call_1\)/);
});

test("OpenAIStreamTranslator closes a prefix that only lacks closing braces", () => {
  const events = runStream([
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "c", function: { name: "Read", arguments: '{"file_path":"/a.ts","opts":{"x":true}' } }] },
        },
      ],
    },
  ]);
  assert.deepEqual(JSON.parse(toolBlocksFrom(events)[0].json), { file_path: "/a.ts", opts: { x: true } });
  assert.equal(textFrom(events), "", "a lossless repair needs no notice");
});

test("OpenAIStreamTranslator escapes raw newlines inside strings losslessly", () => {
  const events = runStream([
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "Write", arguments: '{"content":"a\nb"}' } }] } },
      ],
    },
  ]);
  assert.deepEqual(JSON.parse(toolBlocksFrom(events)[0].json), { content: "a\nb" });
});

test("normalizeToolArguments: only lossless repairs are applied", () => {
  assert.deepEqual(normalizeToolArguments('{"a":1}'), { json: '{"a":1}' });
  assert.deepEqual(normalizeToolArguments('{"a":[1,2]'), { json: '{"a":[1,2]}' });
  assert.deepEqual(normalizeToolArguments('{"a":"x"'), { json: '{"a":"x"}' });
  assert.deepEqual(normalizeToolArguments('{"timeout":12'), { json: "{}", problem: "truncated" });
  assert.deepEqual(normalizeToolArguments('{"a":"bc'), { json: "{}", problem: "truncated" });
  assert.deepEqual(normalizeToolArguments('{"a": tru'), { json: "{}", problem: "truncated" });
  assert.deepEqual(normalizeToolArguments('{"a":'), { json: "{}", problem: "truncated" });
  assert.deepEqual(normalizeToolArguments("garbage"), { json: "{}", problem: "malformed" });
  assert.deepEqual(normalizeToolArguments(""), { json: "{}" });
  assert.deepEqual(normalizeToolArguments({ a: 1 }), { json: '{"a":1}' });
});

test("OpenAIStreamTranslator emits a ping while a long tool call is buffered", () => {
  const translator = new OpenAIStreamTranslator();
  translator.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "w", function: { name: "Write", arguments: "" } }] } }] });
  (translator as unknown as { lastEventAt: number }).lastEventAt = 0;
  const quiet = translator.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"content":"' } }] } }] });
  assert.deepEqual(quiet.map((e) => e.event), ["ping"]);
  const next = translator.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "more" } }] } }] });
  assert.deepEqual(next, [], "pings are paced, not sent per chunk");
});

test("OpenAIStreamTranslator falls back to safe JSON for unusable tool arguments", () => {
  const events = runStream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_2", function: { name: "Bash", arguments: "not json at all" } },
            ],
          },
        },
      ],
    },
  ]);
  const tools = toolBlocksFrom(events);
  assert.deepEqual(JSON.parse(tools[0].json), {});
});

test("OpenAIStreamTranslator fuzz: random tool argument fragments always yield parseable SSE", () => {
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = ["{", "}", "[", "]", '"', ":", ",", "\\", "a", "1", " ", "t", "r", "u", "e", "n", "f", "/", "x", "\n"];
  for (let run = 0; run < 250; run += 1) {
    const translator = new OpenAIStreamTranslator();
    const events: AnthropicSseEvent[] = [];
    const fragments: string[] = [];
    const count = 1 + (rand() % 4);
    for (let k = 0; k < count; k += 1) {
      let fragment = "";
      const length = 1 + (rand() % 12);
      for (let j = 0; j < length; j += 1) fragment += alphabet[rand() % alphabet.length]!;
      fragments.push(fragment);
      events.push(
        ...translator.push({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: "call_fuzz", function: { name: "Fuzz", arguments: fragment } },
                ],
              },
            },
          ],
        }),
      );
    }
    events.push(...translator.finish());
    for (const event of events) {
      assert.doesNotThrow(() => JSON.parse(event.data), `invalid SSE data: ${event.data}`);
    }
    const tools = toolBlocksFrom(events);
    assert.equal(tools.length, 1, `run ${run}: expected one tool block`);
    assert.equal(tools[0].id, "call_fuzz");
    assert.doesNotThrow(
      () => JSON.parse(tools[0].json),
      `run ${run}: bad args ${JSON.stringify(fragments)} -> ${tools[0].json}`,
    );
  }
});

test("openAIToAnthropicResponse: malformed tool arguments fall back to objects, missing ids are synthesized", () => {
  const out = openAIToAnthropicResponse(
    {
      choices: [
        {
          index: 0,
          message: {
            content: null,
            tool_calls: [
              { function: { name: "Bash", arguments: '{"a":' } },
              { id: "call_z", function: { name: "Read", arguments: "garbage" } },
            ],
          },
        },
      ],
    },
    TARGET_MODEL,
  );
  const tools = (out.content as Record<string, unknown>[]).filter((block) => block.type === "tool_use");
  assert.equal(tools.length, 2);
  assert.match(tools[0].id as string, /^call_[0-9a-f-]+$/);
  assert.equal(tools[1].id, "call_z");
  // '{"a":' is truncated: neutralized rather than guessed as { a: null }.
  assert.deepEqual(tools[0].input, {});
  assert.deepEqual(tools[1].input, {});
});

test("reasoning_content is only carried for the current turn, never earlier turns", () => {
  const body = {
    messages: [
      { role: "user", content: "first task" },
      { role: "assistant", content: [{ type: "thinking", thinking: "old reasoning" }, { type: "text", text: "done" }] },
      { role: "user", content: "second task" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "current reasoning" },
          { type: "tool_use", id: "call_9", name: "Bash", input: { command: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "a.ts" }] },
    ],
  };
  const out = anthropicToOpenAI(body, TARGET_MODEL, { reasoningContent: true });
  const assistants = (out.messages as Array<Record<string, unknown>>).filter((m) => m.role === "assistant");
  assert.equal("reasoning_content" in assistants[0], false, "earlier turn's reasoning is dropped");
  assert.equal(assistants[1].reasoning_content, "current reasoning", "current tool loop keeps it");
});

test("stripUnsignedThinking: bridged (unsigned) thinking is dropped for the Anthropic wire, signed is kept", () => {
  const body = {
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "from deepseek" },
          { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "x" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "genuine", signature: "sig-abc" }, { type: "text", text: "ok" }],
      },
      { role: "assistant", content: [{ type: "thinking", thinking: "only unsigned" }] },
    ],
  };
  const out = stripUnsignedThinking(body) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  assert.deepEqual(out.messages[1].content.map((b) => b.type), ["tool_use"]);
  assert.deepEqual(out.messages[3].content.map((b) => b.type), ["thinking", "text"]);
  assert.deepEqual(out.messages[4].content, [{ type: "text", text: "" }]);
  // Nothing to drop -> same object back.
  const clean = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(stripUnsignedThinking(clean), clean);
});

test("OpenAIStreamTranslator: reasoning after a tool block started never targets the closed thinking block", () => {
  const translator = new OpenAIStreamTranslator();
  const events: Array<Record<string, unknown>> = [];
  for (const chunk of [
    { choices: [{ index: 0, delta: { reasoning_content: "plan" } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Bash", arguments: "{}" } }] } }] },
    { choices: [{ index: 0, delta: { reasoning_content: "late" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ]) {
    for (const e of translator.push(chunk)) events.push(JSON.parse(e.data) as Record<string, unknown>);
  }
  const thinkingDeltas = events.filter((e) => (e.delta as { type?: string } | undefined)?.type === "thinking_delta");
  assert.equal(thinkingDeltas.length, 1);
  assert.equal((thinkingDeltas[0].delta as { thinking: string }).thinking, "plan");
});
