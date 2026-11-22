import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequest, requestUrl } from "./adapters";
import {
  catalogEntry,
  providerKindForCatalog,
  repairedApiStyle,
  repairedModelId,
} from "./catalog";
import {
  configureProviderStorePaths,
  readConfiguredProviders,
  routerProviders,
  writeConfiguredProviders,
} from "./store";
import type { CompleteRequest, ProviderConfig } from "./types";
import {
  anthropicToResponses,
  newResponsesStreamState,
  responsesEventToChunks,
  responsesToOpenAIResponse,
} from "./wire-shims";

/**
 * Perplexity Agent API migration: the catalog entry speaks the OpenAI
 * Responses wire format (POST /v1/agent, aliased as /v1/responses) with
 * the single perplexity/sonar model. The legacy Sonar Chat Completions
 * endpoint retired 2026-09-27.
 */

const perplexityConfig = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "perplexity",
  kind: "openai",
  apiStyle: "openai-responses",
  baseUrl: "https://api.perplexity.ai",
  keys: ["sk-test"],
  ...overrides,
});

test("catalog entry points at the Agent API with the perplexity/sonar model", () => {
  const entry = catalogEntry("perplexity");
  assert.ok(entry, "perplexity catalog entry");
  assert.equal(entry.apiStyle, "openai-responses");
  assert.equal(entry.baseUrl, "https://api.perplexity.ai");
  assert.equal(entry.models?.default, "perplexity/sonar");
  assert.deepEqual(entry.models?.popular, ["perplexity/sonar"]);
  const listed = [entry.models?.default, ...(entry.models?.popular ?? [])];
  for (const legacy of ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro", "sonar-deep-research"]) {
    assert.equal(listed.includes(legacy), false, `legacy Sonar id "${legacy}" must not be listed`);
  }
  assert.equal(providerKindForCatalog(entry), "openai");
  assert.equal(entry.authHeader, "bearer");
  assert.equal(entry.envVar, "SWARM_KEYS_PERPLEXITY");
  assert.equal(entry.standardEnvVar, "PERPLEXITY_API_KEY");
});

test("requestUrl builds the Agent API endpoint with no double /v1", () => {
  const expected = "https://api.perplexity.ai/v1/responses";
  assert.equal(requestUrl(perplexityConfig(), "perplexity/sonar"), expected);
  // A saved baseUrl that already carries /v1 must not double it.
  assert.equal(
    requestUrl(perplexityConfig({ baseUrl: "https://api.perplexity.ai/v1" }), "perplexity/sonar"),
    expected,
  );
  assert.equal(
    requestUrl(perplexityConfig({ baseUrl: "https://api.perplexity.ai/" }), "perplexity/sonar"),
    expected,
  );
  // No saved baseUrl: the catalog base applies.
  const { baseUrl: _baseUrl, ...noBase } = perplexityConfig();
  assert.equal(requestUrl(noBase, "perplexity/sonar"), expected);
});

test("buildRequest sends a Responses body, never chat-completions messages", () => {
  const request: CompleteRequest = {
    messages: [{ role: "user", content: "what changed in the news today?" }],
    system: "be brief",
    maxTokens: 256,
    temperature: 0.2,
  };
  const { url, init } = buildRequest(
    perplexityConfig(),
    "sk-test",
    "perplexity/sonar",
    request,
    undefined,
    true,
  );
  assert.equal(url, "https://api.perplexity.ai/v1/responses");
  assert.equal(init.headers?.authorization, "Bearer sk-test");
  const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.model, "perplexity/sonar");
  assert.equal(body.instructions, "be brief");
  assert.equal(body.max_output_tokens, 256);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, true);
  assert.equal("messages" in body, false, "Agent API takes input items, not messages");
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "what changed in the news today?" }] },
  ]);
});

test("anthropicToResponses maps system, tools and history onto Agent API items", () => {
  const anthropicBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 512,
    system: "You are a coding agent.",
    messages: [
      { role: "user", content: "list the files" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running ls." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.ts\nb.ts" }],
      },
    ],
    tools: [
      {
        name: "Bash",
        description: "Run a shell command",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
  };
  const out = anthropicToResponses(anthropicBody, "perplexity/sonar");
  assert.equal(out.model, "perplexity/sonar");
  assert.equal(out.instructions, "You are a coding agent.");
  assert.equal(out.max_output_tokens, 512);
  assert.equal("messages" in out, false);
  const input = out.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[0], {
    role: "user",
    content: [{ type: "input_text", text: "list the files" }],
  });
  assert.ok(input.some((item) => item.type === "function_call" && item.name === "Bash"));
  assert.ok(
    input.some((item) => item.type === "function_call_output" && item.output === "a.ts\nb.ts"),
  );
  // Function tools keep their descriptions (the Agent API requires them).
  const tools = out.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].name, "Bash");
  assert.equal(tools[0].description, "Run a shell command");
});

test("responsesToOpenAIResponse reads Agent API output incl. search results", () => {
  const agentResponse = {
    id: "resp_123",
    object: "response",
    model: "perplexity/sonar",
    status: "completed",
    output: [
      {
        type: "search_results",
        results: [{ url: "https://example.com/a", title: "A", snippet: "...", date: "2026-11-20" }],
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Here is the answer.",
            annotations: [
              { type: "url_citation", url: "https://example.com/a", title: "A", start_index: 0, end_index: 4 },
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 120, output_tokens: 45, total_tokens: 165 },
  };
  const out = responsesToOpenAIResponse(agentResponse, "perplexity/sonar");
  const choice = (out.choices as Array<Record<string, unknown>>)[0];
  const message = choice.message as Record<string, unknown>;
  assert.equal(message.content, "Here is the answer.");
  assert.equal(choice.finish_reason, "stop");
  assert.deepEqual(out.usage, { prompt_tokens: 120, completion_tokens: 45 });

  const toolResponse = {
    id: "resp_124",
    object: "response",
    model: "perplexity/sonar",
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: "call_9",
        name: "Bash",
        arguments: "{\"command\":\"ls\"}",
        status: "completed",
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const toolOut = responsesToOpenAIResponse(toolResponse, "perplexity/sonar");
  const toolChoice = (toolOut.choices as Array<Record<string, unknown>>)[0];
  assert.equal(toolChoice.finish_reason, "tool_calls");
  const toolMessage = toolChoice.message as Record<string, unknown>;
  const calls = toolMessage.tool_calls as Array<Record<string, unknown>>;
  assert.equal(calls.length, 1);
  assert.equal((calls[0].function as Record<string, unknown>).name, "Bash");
});

test("responsesEventToChunks handles Agent API stream events and ignores unknown ones", () => {
  const state = newResponsesStreamState("perplexity/sonar");
  const delta = responsesEventToChunks(
    { type: "response.output_text.delta", delta: "Hel" },
    state,
  );
  assert.equal(delta.length, 1);
  assert.equal(delta[0].choices[0].delta.content, "Hel");

  // Built-in tool / search events the shim does not model must not throw.
  assert.deepEqual(
    responsesEventToChunks({ type: "response.web_search_call.completed", item_id: "ws_1" }, state),
    [],
  );
  assert.deepEqual(responsesEventToChunks({ type: "response.created", response: {} }, state), []);

  const done = responsesEventToChunks(
    {
      type: "response.completed",
      response: { usage: { input_tokens: 30, output_tokens: 12 } },
    },
    state,
  );
  assert.equal(done.length, 1);
  assert.equal(done[0].choices[0].finish_reason, "stop");
  assert.deepEqual(done[0].usage, { prompt_tokens: 30, completion_tokens: 12 });

  assert.throws(
    () =>
      responsesEventToChunks(
        { type: "response.failed", response: { error: { message: "boom" } } },
        newResponsesStreamState("perplexity/sonar"),
      ),
    /boom/,
  );
});

test("legacy repair helpers map Sonar ids and the chat style, scoped to perplexity", () => {
  for (const legacy of ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro", "sonar-deep-research"]) {
    assert.equal(repairedModelId("perplexity", legacy), "perplexity/sonar");
  }
  assert.equal(repairedModelId("perplexity", "perplexity/sonar"), "perplexity/sonar");
  assert.equal(repairedModelId("custom", "sonar-pro"), "sonar-pro", "other providers untouched");
  assert.equal(repairedModelId("inception", "mercury"), "mercury-3", "inception repair intact");

  assert.equal(repairedApiStyle("perplexity", "openai-chat"), "openai-responses");
  assert.equal(repairedApiStyle("perplexity", "openai-responses"), "openai-responses");
  assert.equal(repairedApiStyle("openai", "openai-chat"), "openai-chat", "other providers untouched");
});

// --- Saved-config repair on load (mirrors the inception repair harness) ---

const U = "local_tester@example.com";
let tempDir: string;

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-perplexity-repair-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("readConfiguredProviders migrates a saved Sonar chat config to the Agent API", () => {
  writeConfiguredProviders(U, [
    {
      id: "perplexity",
      kind: "openai" as const,
      apiStyle: "openai-chat" as const,
      baseUrl: "https://api.perplexity.ai",
      keys: ["sk-pplx"],
      models: { fast: "sonar", balanced: "sonar-pro", deep: "sonar-reasoning-pro" },
      availableModels: ["sonar-pro", "sonar-deep-research"],
      modelCapabilities: {
        "sonar-pro": { vision: false, tools: true, computerUse: false, source: "override" as const },
      },
    },
    // No explicit style: kind-derived openai-chat must be repaired too.
    {
      id: "perplexity-2",
      kind: "openai" as const,
      baseUrl: "https://api.perplexity.ai/v1",
      keys: ["sk-pplx-2"],
      models: { balanced: "sonar" },
    },
  ]);

  const [migrated, derived] = readConfiguredProviders(U);
  assert.equal(migrated.apiStyle, "openai-responses");
  assert.deepEqual(migrated.models, {
    fast: "perplexity/sonar",
    balanced: "perplexity/sonar",
    deep: "perplexity/sonar",
  });
  assert.deepEqual(migrated.availableModels, ["perplexity/sonar", "perplexity/sonar"]);
  assert.deepEqual(Object.keys(migrated.modelCapabilities ?? {}), ["perplexity/sonar"]);

  // perplexity-2 is a different provider id: the repair tables key on the
  // catalog id, so a renamed copy is the user's own config, untouched.
  assert.equal(derived.apiStyle, undefined);
  assert.deepEqual(derived.models, { balanced: "sonar" });

  // The router view (what the gateway sends) is repaired too.
  const routed = routerProviders(U).find((p) => p.id === "perplexity");
  assert.equal(routed?.apiStyle, "openai-responses");
  assert.equal(routed?.models?.balanced, "perplexity/sonar");
});

test("the repair is host-gated: a perplexity config on a gateway host is untouched", () => {
  // Same provider id, but the base URL is a gateway that still speaks
  // chat completions — flipping its style/model would break it.
  writeConfiguredProviders(U, [
    {
      id: "perplexity",
      kind: "openai" as const,
      apiStyle: "openai-chat" as const,
      baseUrl: "https://gateway.example.invalid/v1",
      keys: ["sk-gw"],
      models: { balanced: "sonar-pro" },
      availableModels: ["sonar-pro"],
    },
  ]);
  const [config] = readConfiguredProviders(U);
  assert.equal(config.apiStyle, "openai-chat");
  assert.deepEqual(config.models, { balanced: "sonar-pro" });
  assert.deepEqual(config.availableModels, ["sonar-pro"]);
});

test("a saved perplexity config with no explicit style gets the Responses style pinned", () => {
  writeConfiguredProviders(U, [
    {
      id: "perplexity",
      kind: "openai" as const,
      keys: ["sk-pplx"],
      models: { balanced: "sonar-pro" },
    },
  ]);
  const [config] = readConfiguredProviders(U);
  assert.equal(config.apiStyle, "openai-responses");
  assert.deepEqual(config.models, { balanced: "perplexity/sonar" });
});
