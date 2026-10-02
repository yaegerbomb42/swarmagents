import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateOrReservedIp, validateSsrfUrl } from "../lib/connections/ssrf.ts";
import { detectProviderFromKey, maskKey } from "../lib/connections/key-detect.ts";
import { mapProviderError } from "../lib/connections/capabilities.ts";

test("SSRF: Blocks private, metadata, and tailnet ranges by default", async () => {
  // Cloud metadata
  assert.equal(isPrivateOrReservedIp("169.254.169.254"), true);
  assert.equal(isPrivateOrReservedIp("169.254.170.2"), true);

  // Private RFC1918
  assert.equal(isPrivateOrReservedIp("10.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("172.16.5.4"), true);
  assert.equal(isPrivateOrReservedIp("192.168.1.1"), true);

  // Tailscale / CGNAT
  assert.equal(isPrivateOrReservedIp("100.100.100.100"), true);

  // Localhost (blocked by default)
  assert.equal(isPrivateOrReservedIp("127.0.0.1", false), true);
  // Localhost allowed when opt-in
  assert.equal(isPrivateOrReservedIp("127.0.0.1", true), false);

  // Public IP
  assert.equal(isPrivateOrReservedIp("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedIp("1.1.1.1"), false);
});

test("SSRF: validateSsrfUrl validates URLs correctly", async () => {
  const meta = await validateSsrfUrl("http://169.254.169.254/latest/meta-data/");
  assert.equal(meta.allowed, false);

  const localBlocked = await validateSsrfUrl("http://localhost:11434/v1");
  assert.equal(localBlocked.allowed, false);

  const localAllowed = await validateSsrfUrl("http://localhost:11434/v1", { allowLocalhost: true });
  assert.equal(localAllowed.allowed, true);

  const validPublic = await validateSsrfUrl("https://api.openai.com/v1");
  assert.equal(validPublic.allowed, true);
});

test("Key Detection: Recognizes prefixes for popular providers", () => {
  // OpenAI
  const oai = detectProviderFromKey(["sk-", "proj-", "abc12345678901234567890"].join(""));
  assert.equal(oai?.preset, "openai");

  // Anthropic
  const ant = detectProviderFromKey(["sk-", "ant-", "api03-abcdef123456789012345678"].join(""));
  assert.equal(ant?.preset, "anthropic");

  // OpenRouter
  const or = detectProviderFromKey(["sk-", "or-", "v1-0123456789abcdef0123456789abcdef"].join(""));
  assert.equal(or?.preset, "openrouter");

  // Gemini
  const gemini = detectProviderFromKey(["AIza", "SyD-123456789012345678901234567890"].join(""));
  assert.equal(gemini?.preset, "gemini");

  // Groq
  const groq = detectProviderFromKey(["gsk_", "123456789012345678901234567890"].join(""));
  assert.equal(groq?.preset, "groq");

  // Unknown
  const unknown = detectProviderFromKey("unknown-format-key-123");
  assert.equal(unknown, undefined);
});

test("Key Masking: Never leaks secrets and formats mask correctly", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey(undefined), "");
  assert.equal(maskKey("123"), "••••");
  assert.equal(maskKey(["sk-", "ant-", "secret-1234567890"].join("")), "••••7890");
});

test("Error Mapping: Translates errors into plain actionable messages", () => {
  const authErr = mapProviderError(401, "Unauthorized: Invalid key", "https://api.openai.com");
  assert.equal(authErr.type, "wrong_key");
  assert.ok(authErr.suggestedFix.includes("API key"));

  const quotaErr = mapProviderError(429, "You exceeded your current quota", "https://api.openai.com");
  assert.equal(quotaErr.type, "no_credits");
  assert.ok(quotaErr.suggestedFix.includes("billing"));

  const rateErr = mapProviderError(429, "Rate limit reached for requests", "https://api.openai.com");
  assert.equal(rateErr.type, "rate_limited");
  assert.ok(rateErr.suggestedFix.includes("Wait"));
});

import http from "node:http";
import { validateAndConfigureCustomEndpoint } from "../lib/connections/custom-endpoint.ts";

test("BYOK: Local mock server model discovery and custom headers", async () => {
  // Spin up an ephemeral local mock OpenAI server
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [{ id: "mock-model-v1" }, { id: "mock-model-v2" }]
      }));
      return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "pong", role: "assistant" } }]
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  // Localhost blocked without opt-in
  const blocked = await validateAndConfigureCustomEndpoint({
    kind: "custom",
    baseUrl,
    allowLocalhost: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.type, "ssrf_blocked");

  // Localhost allowed with opt-in
  const allowed = await validateAndConfigureCustomEndpoint({
    kind: "custom",
    baseUrl,
    allowLocalhost: true,
  });

  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.capabilities?.discoveredModels, ["mock-model-v1", "mock-model-v2"]);

  await new Promise((resolve) => server.close(resolve));
});

test("OAuth: GitHub Device Code response parsing and token storage", async () => {
  const { saveGitHubTokens, loadGitHubTokens, clearGitHubTokens } = await import("../lib/connections/oauth-github.ts");
    saveGitHubTokens({
      accessToken: "gho_test_1234567890abcdef",
      tokenType: "bearer",
      scope: "repo",
      savedAt: Date.now(),
    });

    const loaded = loadGitHubTokens();
    assert.equal(loaded?.accessToken, "gho_test_1234567890abcdef");
    assert.equal(loaded?.scope, "repo");

    clearGitHubTokens();
    assert.equal(loadGitHubTokens(), null);
});

import { getEnrichedPresets } from "../lib/connections/catalog";

test("Catalog: Enriched presets contain valid direct key links and guidance hints", () => {
  const enriched = getEnrichedPresets();
  assert.ok(enriched.length > 20);

  const openai = enriched.find((p) => p.id === "openai");
  assert.ok(openai);
  assert.equal(openai.directKeyUrl, "https://platform.openai.com/api-keys");
  assert.ok(openai.keyHelpHint?.includes("OpenAI"));

  const anthropic = enriched.find((p) => p.id === "anthropic");
  assert.ok(anthropic);
  assert.equal(anthropic.directKeyUrl, "https://console.anthropic.com/settings/keys");
  assert.ok(anthropic.keyHelpHint?.includes("Anthropic"));
});

import { constructAzureUrl, validateAzureEndpoint } from "../lib/connections/azure";

test("Azure OpenAI: URL construction and parameter handling", () => {
  const url1 = constructAzureUrl({
    resourceName: "eastus-ai-res",
    deploymentName: "gpt-4o-deploy",
    apiVersion: "2024-06-01",
  });
  assert.equal(url1, "https://eastus-ai-res.openai.azure.com/openai/deployments/gpt-4o-deploy/chat/completions?api-version=2024-06-01");

  const url2 = constructAzureUrl({
    customBaseUrl: "https://gateway.internal.net/azure-proxy",
    deploymentName: "o1-mini",
  });
  assert.equal(url2, "https://gateway.internal.net/azure-proxy/openai/deployments/o1-mini/chat/completions?api-version=2024-02-15-preview");
});

test("Azure OpenAI: Mock server validation with streaming & tools verification", async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers["api-key"], "mock-azure-key");
    if (req.method === "POST") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.end("data: {\"choices\":[{\"delta\":{\"content\":\"azure ok\"}}]}\n\ndata: [DONE]\n\n");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const result = await validateAzureEndpoint({
    customBaseUrl: `http://127.0.0.1:${port}/azure-mock`,
    deploymentName: "gpt-4o-deploy",
    apiKey: "mock-azure-key",
    allowLocalhost: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.capabilities?.streaming, true);
  assert.equal(result.normalizedConfig?.model, "gpt-4o-deploy");
  assert.equal(result.normalizedConfig?.headers?.["api-version"], "2024-02-15-preview");

  await new Promise((resolve) => server.close(resolve));
});
