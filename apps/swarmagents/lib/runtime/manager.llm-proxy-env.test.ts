/**
 * Tests for applyLlmProxyEnv: the per-run Claude Code env built from a
 * provider selection. The model-tier pins and phone-home opt-outs from
 * buildClaudeEnv must survive the proxy rewrite, and the run token must
 * replace the provider credential so the raw key never enters the VM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyLlmProxyEnv } from "./manager";
import { buildClaudeEnv, type ClaudeSelection } from "../providers/claude-env";

function selection(model = "qwen2.5:7b"): ClaudeSelection {
  return {
    env: buildClaudeEnv({
      provider: "ollama",
      kind: "openai",
      baseUrl: "http://localhost:11434/v1",
      key: "ollama-local",
      model,
    }),
    secrets: ["ollama-local"],
    provider: "ollama",
    keyId: "ollama:key-1",
    model,
    settle: () => {},
    release: () => {},
  };
}

const PIN_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

test("applyLlmProxyEnv: proxy mode swaps in the run token and keeps the tier pins", () => {
  const sel = selection("qwen2.5:7b");
  const env = applyLlmProxyEnv(sel, "https://agents.example.com", "run-token-123");

  assert.equal(env.ANTHROPIC_BASE_URL, "https://agents.example.com/api/runtime/llm/run-token-123");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "run-token-123");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  for (const key of PIN_KEYS) {
    assert.equal(env[key], "qwen2.5:7b", `${key} must survive the proxy rewrite`);
  }
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.DISABLE_TELEMETRY, "1");
  // The provider's real credential must not survive into the VM env.
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "run-token-123");
  assert.notEqual(env.ANTHROPIC_AUTH_TOKEN, "ollama-local");
});

test("applyLlmProxyEnv: direct mode returns the selection env unchanged (pins intact)", () => {
  const sel = selection("mercury-3");
  const env = applyLlmProxyEnv(sel, null, null);

  assert.equal(env, sel.env, "no proxy => the selection env is returned as-is");
  for (const key of PIN_KEYS) {
    assert.equal(env[key], "mercury-3");
  }
});