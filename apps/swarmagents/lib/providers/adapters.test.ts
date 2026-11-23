import test from "node:test";
import assert from "node:assert/strict";
import {
  apiStyleFor,
  authFor,
  authHeadersFor,
  buildRequest,
  parseResponse,
  requestUrl,
} from "./adapters";
import { CacheAwarePromptBuilder } from "./cache-aware-prompt";
import type { CompleteRequest, ProviderConfig } from "./types";

const base = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "custom",
  kind: "openai",
  ...overrides,
});

test("bearer auth sets Authorization and keeps extra static headers", () => {
  const headers = authHeadersFor(
    base({ auth: { scheme: "bearer" }, headers: { "x-gateway": "yes" } }),
    "sk-123",
  );
  assert.equal(headers.authorization, "Bearer sk-123");
  assert.equal(headers["x-gateway"], "yes");
  assert.equal(headers["content-type"], "application/json");
});

test("x-api-key auth adds anthropic-version only for the Anthropic style", () => {
  const anthropic = authHeadersFor(
    base({ kind: "anthropic", apiStyle: "anthropic", auth: { scheme: "x-api-key" } }),
    "sk-ant",
  );
  assert.equal(anthropic["x-api-key"], "sk-ant");
  assert.equal(anthropic["anthropic-version"], "2023-06-01");

  const custom = authHeadersFor(base({ auth: { scheme: "x-api-key" } }), "key");
  assert.equal(custom["x-api-key"], "key");
  assert.equal(custom["anthropic-version"], undefined);
});

test("x-goog-api-key, basic and custom-header auth place the credential correctly", () => {
  const goog = authHeadersFor(
    base({ apiStyle: "gemini", auth: { scheme: "x-goog-api-key" } }),
    "google-key",
  );
  assert.equal(goog["x-goog-api-key"], "google-key");

  const basic = authHeadersFor(base({ auth: { scheme: "basic" } }), "user:pass");
  assert.equal(basic.authorization, `Basic ${Buffer.from("user:pass").toString("base64")}`);

  const custom = authHeadersFor(
    base({ auth: { scheme: "custom-header", headerName: "api-key" } }),
    "azure-key",
  );
  assert.equal(custom["api-key"], "azure-key");
  assert.equal(custom.authorization, undefined);
});

test("none auth sends no credential even when a key is supplied", () => {
  const headers = authHeadersFor(base({ auth: { scheme: "none" } }), "should-not-appear");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-api-key"], undefined);
  assert.ok(!JSON.stringify(headers).includes("should-not-appear"));
});

test("catalog defaults choose the right auth and base URL", () => {
  assert.deepEqual(authFor({ id: "anthropic", kind: "anthropic" }), { scheme: "x-api-key" });
  assert.deepEqual(authFor({ id: "gemini", kind: "gemini" }), { scheme: "x-goog-api-key" });
  assert.deepEqual(authFor({ id: "azure-openai", kind: "openai" }), {
    scheme: "custom-header",
    headerName: "api-key",
  });
  assert.equal(authFor({ id: "openai", kind: "openai" }).scheme, "bearer");
});

test("requestUrl maps each API style to its wire endpoint", () => {
  assert.equal(
    requestUrl(base({ apiStyle: "openai-chat", baseUrl: "https://api.example.com/v1" }), "m"),
    "https://api.example.com/v1/chat/completions",
  );
  assert.equal(
    requestUrl(base({ apiStyle: "openai-responses", baseUrl: "https://api.example.com/v1" }), "m"),
    "https://api.example.com/v1/responses",
  );
  assert.equal(
    requestUrl(base({ apiStyle: "anthropic", baseUrl: "https://api.example.com" }), "m"),
    "https://api.example.com/v1/messages",
  );
  assert.equal(
    requestUrl(base({ apiStyle: "ollama", baseUrl: "http://127.0.0.1:11434" }), "m"),
    "http://127.0.0.1:11434/api/chat",
  );
  assert.equal(
    requestUrl(base({ apiStyle: "gemini", baseUrl: "https://api.example.com" }), "gemini-2.5-pro", true),
    "https://api.example.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
  );
  assert.equal(
    requestUrl(base({ apiStyle: "gemini", baseUrl: "https://api.example.com" }), "gemini-2.5-pro"),
    "https://api.example.com/v1beta/models/gemini-2.5-pro:generateContent",
  );
});

test("legacy configs derive a style from kind", () => {
  assert.equal(apiStyleFor({ id: "x", kind: "anthropic" }), "anthropic");
  assert.equal(apiStyleFor({ id: "x", kind: "gemini" }), "gemini");
  assert.equal(apiStyleFor({ id: "x", kind: "openai" }), "openai-chat");
  assert.equal(apiStyleFor({ id: "x", kind: "openai", apiStyle: "ollama" }), "ollama");
});

const complete: CompleteRequest = {
  messages: [{ role: "user", content: "hello" }],
  system: "be brief",
  maxTokens: 32,
  temperature: 0.2,
};

function built(config: ProviderConfig, request = complete, stream = false) {
  const { url, init } = buildRequest(config, "sk-test", "test-model", request, undefined, stream);
  return { url, headers: init.headers ?? {}, body: JSON.parse(init.body ?? "{}") };
}

test("openai-chat buildRequest translates the Anthropic-shaped request", () => {
  const { url, headers, body } = built(base({ apiStyle: "openai-chat", baseUrl: "https://api.example.com/v1" }));
  assert.equal(url, "https://api.example.com/v1/chat/completions");
  assert.equal(headers.authorization, "Bearer sk-test");
  assert.deepEqual(body.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ]);
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 32);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, undefined);
});

test("anthropic buildRequest keeps system top-level and streams on request", () => {
  const { url, headers, body } = built(
    base({ kind: "anthropic", apiStyle: "anthropic", baseUrl: "https://api.anthropic.com" }),
    complete,
    true,
  );
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["x-api-key"], "sk-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(body.system, "be brief");
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  assert.equal(body.stream, true);
});

test("openai-responses buildRequest maps input, instructions and max_output_tokens", () => {
  const { url, body } = built(
    base({ apiStyle: "openai-responses", baseUrl: "https://api.example.com/v1" }),
  );
  assert.equal(url, "https://api.example.com/v1/responses");
  assert.equal(body.instructions, "be brief");
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  assert.equal(body.max_output_tokens, 32);
});

test("gemini buildRequest maps contents and generationConfig", () => {
  const { url, headers, body } = built(
    base({ kind: "gemini", apiStyle: "gemini", baseUrl: "https://generativelanguage.googleapis.com" }),
  );
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent");
  assert.equal(headers["x-goog-api-key"], "sk-test");
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hello" }] }]);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "be brief" }] });
  assert.equal(body.generationConfig.maxOutputTokens, 32);
});

test("ollama buildRequest maps options and the stream flag", () => {
  const { url, headers, body } = built(
    base({ apiStyle: "ollama", baseUrl: "http://127.0.0.1:11434" }),
    complete,
    true,
  );
  assert.equal(url, "http://127.0.0.1:11434/api/chat");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.accept, "application/x-ndjson");
  assert.deepEqual(body.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ]);
  assert.equal(body.options.num_predict, 32);
  assert.equal(body.stream, true);
});

test("parseResponse reads text and usage from every API style", () => {
  const openai = parseResponse(
    base({ apiStyle: "openai-chat" }),
    {
      model: "gpt-x",
      choices: [{ message: { content: "pong" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
    "requested",
  );
  assert.deepEqual(openai, {
    text: "pong",
    model: "gpt-x",
    usage: { inputTokens: 3, outputTokens: 2 },
  });

  const anthropic = parseResponse(
    base({ kind: "anthropic", apiStyle: "anthropic" }),
    {
      model: "claude-x",
      content: [{ type: "text", text: "hello " }, { type: "text", text: "there" }],
      usage: { input_tokens: 4, output_tokens: 5 },
    },
    "requested",
  );
  assert.deepEqual(anthropic, {
    text: "hello there",
    model: "claude-x",
    usage: { inputTokens: 4, outputTokens: 5 },
  });

  const responses = parseResponse(
    base({ apiStyle: "openai-responses" }),
    {
      model: "resp-x",
      output: [{ type: "message", content: [{ type: "output_text", text: "responses" }] }],
      usage: { input_tokens: 6, output_tokens: 7 },
    },
    "requested",
  );
  assert.equal(responses.text, "responses");
  assert.deepEqual(responses.usage, { inputTokens: 6, outputTokens: 7 });

  const gemini = parseResponse(
    base({ kind: "gemini", apiStyle: "gemini" }),
    {
      candidates: [{ content: { parts: [{ text: "gemini" }] } }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 9 },
    },
    "requested",
  );
  assert.equal(gemini.text, "gemini");
  assert.deepEqual(gemini.usage, { inputTokens: 8, outputTokens: 9 });

  const ollama = parseResponse(
    base({ apiStyle: "ollama" }),
    {
      model: "llama",
      message: { content: "local" },
      prompt_eval_count: 10,
      eval_count: 11,
    },
    "requested",
  );
  assert.equal(ollama.text, "local");
  assert.deepEqual(ollama.usage, { inputTokens: 10, outputTokens: 11 });
});

test("parseResponse refuses an empty completion", () => {
  assert.throws(
    () => parseResponse(base({ apiStyle: "openai-chat" }), { choices: [{ message: {} }] }, "m"),
    /no text content/,
  );
});

test("anthropic buildRequest injects cache_control breakpoints at the zone boundaries", () => {
  const builder = new CacheAwarePromptBuilder({
    zone0: "You are a senior engineer.",
    zone1: "## Repo skeleton\nsrc/a.ts",
  });
  const { request } = builder.build({
    trajectory: [
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "did turn 1" },
    ],
    zone3: "Budget: 100 tokens.",
  });
  const { body } = built(
    base({ kind: "anthropic", apiStyle: "anthropic", baseUrl: "https://api.anthropic.com" }),
    request,
  );
  // System (Zone 0) becomes a single block with a breakpoint.
  assert.deepEqual(body.system, [
    { type: "text", text: "You are a senior engineer.", cache_control: { type: "ephemeral" } },
  ]);
  // Messages: [Zone 1, turn 1, did turn 1, Zone 3]. Breakpoints land on the
  // first message (Zone 1) and the second-to-last (last trajectory turn).
  assert.equal(body.messages.length, 4);
  const marked = (index: number) => body.messages[index].content.at(-1).cache_control;
  assert.deepEqual(marked(0), { type: "ephemeral" });
  assert.equal(marked(1), undefined);
  assert.deepEqual(marked(2), { type: "ephemeral" });
  assert.equal(marked(3), undefined);
  assert.equal(JSON.stringify(body).split("cache_control").length - 1, 3, "exactly 3 breakpoints");
});

test("openai-chat, gemini and responses strip cache breakpoints cleanly", () => {
  const builder = new CacheAwarePromptBuilder({
    zone0: "You are a senior engineer.",
    zone1: "## Repo skeleton\nsrc/a.ts",
  });
  const { request } = builder.build({
    trajectory: [{ role: "user", content: "turn 1" }],
    zone3: "Budget: 100 tokens.",
  });
  for (const style of ["openai-chat", "openai-responses", "gemini", "ollama"] as const) {
    const config = base({
      kind: style === "gemini" ? "gemini" : "openai",
      apiStyle: style,
      baseUrl: "https://api.example.com/v1",
    });
    const { body } = built(config, request);
    assert.ok(!JSON.stringify(body).includes("cache_control"), `${style} must not carry breakpoints`);
  }
  // …but the zone order survives: system first, Zone 1 first message, Zone 3 last.
  const { body } = built(base({ apiStyle: "openai-chat", baseUrl: "https://api.example.com/v1" }), request);
  assert.deepEqual(body.messages, [
    { role: "system", content: "You are a senior engineer." },
    { role: "user", content: "## Repo skeleton\nsrc/a.ts" },
    { role: "user", content: "turn 1" },
    { role: "user", content: "Budget: 100 tokens." },
  ]);
});

test("parseResponse reads prompt-cache usage fields per provider", () => {
  const anthropic = parseResponse(
    base({ kind: "anthropic", apiStyle: "anthropic" }),
    {
      model: "claude-x",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 1000,
        output_tokens: 10,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
      },
    },
    "requested",
  );
  assert.deepEqual(anthropic.usage, {
    inputTokens: 1000,
    outputTokens: 10,
    cachedInputTokens: 800,
    cacheWriteTokens: 200,
  });

  const openai = parseResponse(
    base({ apiStyle: "openai-chat" }),
    {
      model: "gpt-x",
      choices: [{ message: { content: "pong" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 750 } },
    },
    "requested",
  );
  assert.equal(openai.usage.cachedInputTokens, 750);

  const responses = parseResponse(
    base({ apiStyle: "openai-responses" }),
    {
      model: "resp-x",
      output: [{ type: "message", content: [{ type: "output_text", text: "responses" }] }],
      usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 600 } },
    },
    "requested",
  );
  assert.equal(responses.usage.cachedInputTokens, 600);

  const gemini = parseResponse(
    base({ kind: "gemini", apiStyle: "gemini" }),
    {
      candidates: [{ content: { parts: [{ text: "gemini" }] } }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 10, cachedContentTokenCount: 900 },
    },
    "requested",
  );
  assert.equal(gemini.usage.cachedInputTokens, 900);
});
