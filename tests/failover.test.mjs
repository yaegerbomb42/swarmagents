import test from "node:test";
import assert from "node:assert/strict";
import { getEligibleProviders, resolveProviderFailover } from "../lib/connections/router-failover";

test("Failover: Filters out disabled or keyless providers correctly", () => {
  const providers = [
    { id: "p1", kind: "openai", model: "gpt-4o", apiKey: "sk-123", enabled: true },
    { id: "p2", kind: "anthropic", model: "claude-3-5", apiKey: "", enabled: true },
    { id: "p3", kind: "ollama", preset: "ollama", model: "llama3", apiKey: "", enabled: true },
    { id: "p4", kind: "mistral", model: "mistral-large", apiKey: "key", enabled: false },
  ];

  const eligible = getEligibleProviders(providers);
  assert.equal(eligible.length, 2);
  assert.equal(eligible[0].id, "p1");
  assert.equal(eligible[1].id, "p3"); // Ollama allowed without key
});

test("Failover: Seamlessly selects next provider in priority chain", () => {
  const providers = [
    { id: "p1", kind: "openai", model: "gpt-4o", apiKey: "sk-123", enabled: true, label: "OpenAI Primary" },
    { id: "p2", kind: "anthropic", model: "claude-3-5", apiKey: "sk-ant-123", enabled: true, label: "Anthropic Backup" },
    { id: "p3", kind: "groq", model: "llama3-70b", apiKey: "gsk_123", enabled: true, label: "Groq Fast" },
  ];

  // Default selection (no provider specified)
  const def = resolveProviderFailover(undefined, undefined, providers);
  assert.equal(def.activeProvider?.id, "p1");
  assert.equal(def.fallbackChain.length, 2);

  // When p1 fails with rate limit or quota
  const failover = resolveProviderFailover("p1", "Rate limited (429)", providers);
  assert.equal(failover.activeProvider?.id, "p2");
  assert.equal(failover.fallbackChain[0].id, "p3");
  assert.ok(failover.reason?.includes("Failed on OpenAI Primary"));

  // When removed provider is passed
  const removed = resolveProviderFailover("deleted_provider", undefined, providers);
  assert.equal(removed.activeProvider?.id, "p1");
});
