import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverProviderModels,
  parseAnthropicModels,
  parseGeminiModels,
  parseOllamaShow,
  parseOllamaTags,
  parseOpenAIModels,
  testProviderConnection,
} from "./discovery";
import type { ProviderConfig } from "./types";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("parseOpenAIModels sorts and dedupes ids", () => {
  assert.deepEqual(
    parseOpenAIModels({
      data: [{ id: "zeta" }, { id: "alpha" }, { id: "alpha" }, { nope: true }, { id: "" }],
    }),
    ["alpha", "zeta"],
  );
  assert.deepEqual(parseOpenAIModels({ data: "nope" }), []);
});

test("parseAnthropicModels reads the OpenAI-shaped model list", () => {
  assert.deepEqual(
    parseAnthropicModels({
      data: [{ id: "claude-haiku-4-5" }, { id: "claude-sonnet-4-5" }, { id: "claude-opus-4-1" }],
    }),
    ["claude-haiku-4-5", "claude-opus-4-1", "claude-sonnet-4-5"],
  );
});

test("parseGeminiModels strips the models/ prefix and keeps generateContent models", () => {
  assert.deepEqual(
    parseGeminiModels({
      models: [
        { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        { name: "models/imagen-3" },
        { name: "gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
        { notAName: true },
      ],
    }),
    ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  );
});

test("parseOllamaTags reads installed model names and sizes", () => {
  assert.deepEqual(
    parseOllamaTags({
      models: [
        { name: "llava:13b", size: 8_000_000_000 },
        { name: "llama3.2:3b", size: 2_000_000_000 },
        { name: "" },
      ],
    }),
    [
      { id: "llama3.2:3b", size: 2_000_000_000 },
      { id: "llava:13b", size: 8_000_000_000 },
    ],
  );
});

test("parseOllamaShow prefers declared capabilities and reads context length", () => {
  const show = parseOllamaShow({
    capabilities: ["completion", "tools", "vision"],
    details: { family: "llama" },
    model_info: { "llama.context_length": 131_072 },
  });
  assert.equal(show.capabilities.vision, true);
  assert.equal(show.capabilities.tools, true);
  assert.equal(show.capabilities.computerUse, true);
  assert.equal(show.capabilities.source, "discovery");
  assert.equal(show.contextWindow, 131_072);

  const embedding = parseOllamaShow({ capabilities: ["embedding"], details: { family: "bert" } });
  assert.equal(embedding.capabilities.vision, false);
  assert.equal(embedding.capabilities.tools, false);
});

test("parseOllamaShow falls back to the family and num_ctx on older servers", () => {
  const vision = parseOllamaShow({ details: { family: "llava" }, parameters: { num_ctx: 8192 } });
  assert.equal(vision.capabilities.vision, true);
  assert.equal(vision.capabilities.tools, true);
  assert.equal(vision.contextWindow, 8192);

  const plain = parseOllamaShow({ details: { family: "llama" } });
  assert.equal(plain.capabilities.vision, false);
  assert.equal(plain.capabilities.tools, true);

  const embed = parseOllamaShow({ details: { family: "nomic-embed-text" } });
  assert.equal(embed.capabilities.tools, false);
});

test("discoverProviderModels calls /v1/models with the key and never leaks it", async () => {
  const seen: { url: string; auth?: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), auth: headers.get("authorization") ?? undefined });
    return jsonResponse({ data: [{ id: "model-b" }, { id: "model-a" }] });
  }) as typeof fetch;

  const config: ProviderConfig = {
    id: "custom",
    kind: "openai",
    apiStyle: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    models: { fast: "model-a" },
  };
  const result = await discoverProviderModels(config, "sk-secret-value", { fetchImpl });
  assert.deepEqual(result.models.map((m) => m.id), ["model-a", "model-b"]);
  assert.equal(result.endpoint, "https://api.example.com/v1/models");
  assert.equal(seen[0]?.auth, "Bearer sk-secret-value");
  assert.ok(!JSON.stringify(result).includes("sk-secret-value"));
});

test("discoverProviderModels lists Ollama tags then asks /api/show per model", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/tags")) {
      return jsonResponse({ models: [{ name: "llava:13b" }, { name: "llama3.2:3b" }] });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    if (body.model === "llava:13b") {
      return jsonResponse({
        capabilities: ["completion", "tools", "vision"],
        model_info: { "llava.context_length": 4096 },
      });
    }
    return jsonResponse({ capabilities: ["completion", "tools"] });
  }) as typeof fetch;

  const config: ProviderConfig = {
    id: "ollama",
    kind: "openai",
    apiStyle: "ollama",
    baseUrl: "http://127.0.0.1:11434",
  };
  const result = await discoverProviderModels(config, "", { fetchImpl });
  assert.deepEqual(result.models.map((m) => m.id), ["llama3.2:3b", "llava:13b"]);
  const llava = result.models.find((m) => m.id === "llava:13b");
  assert.equal(llava?.capabilities?.vision, true);
  assert.equal(llava?.contextWindow, 4096);
  assert.equal(calls[0], "GET http://127.0.0.1:11434/api/tags");
  assert.equal(calls.filter((c) => c.includes("/api/show")).length, 2);
});

test("testProviderConnection sends a tiny request and redacts the key from the preview", async () => {
  let requestBody: Record<string, unknown> = {};
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return jsonResponse({
      choices: [{ message: { content: "pong sk-very-secret-token" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
  }) as typeof fetch;

  const config: ProviderConfig = {
    id: "custom",
    kind: "openai",
    apiStyle: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    models: { balanced: "model-a" },
  };
  const result = await testProviderConnection(config, "sk-very-secret-token", { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.model, "model-a");
  assert.equal(result.endpoint, "https://api.example.com/v1/chat/completions");
  assert.ok(!result.text.includes("sk-very-secret-token"));
  assert.equal(requestBody.max_tokens, 16);
});

test("testProviderConnection requires a model", async () => {
  await assert.rejects(
    () =>
      testProviderConnection(
        { id: "custom", kind: "openai", apiStyle: "openai-chat", baseUrl: "https://api.example.com/v1" },
        "k",
      ),
    /Choose a model/,
  );
});
