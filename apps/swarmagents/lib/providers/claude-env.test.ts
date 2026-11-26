/**
 * Unit tests for buildClaudeEnv / claudeModelEnv and the Claude run error
 * classifier.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeEnv,
  claudeModelEnv,
  classifyClaudeRunError,
  isClaudeFailoverEligible,
} from "./claude-env";

/** The tier pins + opt-outs every selection must carry, for a given model. */
function pinned(model: string): Record<string, string> {
  return {
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
}

test("buildClaudeEnv: gateway providers get AUTH_TOKEN + BASE_URL + MODEL", () => {
  const env = buildClaudeEnv({
    provider: "mercury",
    kind: "openai",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    key: "sk_mercury_key_0000",
    model: "mercury-3",
  });
  assert.deepEqual(env, {
    ANTHROPIC_BASE_URL: "https://api.inceptionlabs.ai/v1",
    ANTHROPIC_AUTH_TOKEN: "sk_mercury_key_0000",
    ANTHROPIC_MODEL: "mercury-3",
    ...pinned("mercury-3"),
  });
});

test("buildClaudeEnv: LiteLLM-style gateway with anthropic kind", () => {
  const env = buildClaudeEnv({
    provider: "litellm",
    kind: "anthropic",
    baseUrl: "http://localhost:8000/v1",
    key: "sk-litellm-0000",
    model: "claude-sonnet-4-5",
  });
  assert.deepEqual(env, {
    ANTHROPIC_BASE_URL: "http://localhost:8000/v1",
    ANTHROPIC_AUTH_TOKEN: "sk-litellm-0000",
    ANTHROPIC_MODEL: "claude-sonnet-4-5",
    ...pinned("claude-sonnet-4-5"),
  });
});

test("buildClaudeEnv: native Anthropic host gets API_KEY, not a Bearer token", () => {
  const env = buildClaudeEnv({
    provider: "anthropic",
    kind: "anthropic",
    key: "sk-ant-api03-native-0000",
    model: "claude-sonnet-4-5",
  });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.deepEqual(env, {
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_API_KEY: "sk-ant-api03-native-0000",
    ANTHROPIC_MODEL: "claude-sonnet-4-5",
    ...pinned("claude-sonnet-4-5"),
  });
});

test("claudeModelEnv: pins every tier to one model and disables phone-home", () => {
  assert.deepEqual(claudeModelEnv("llama3.2"), {
    ANTHROPIC_SMALL_FAST_MODEL: "llama3.2",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "llama3.2",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "llama3.2",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "llama3.2",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });
});

test("buildClaudeEnv: a non-Anthropic model powers every Claude Code tier (BYOK)", () => {
  // The whole point of BYOK: Claude Code must never fall back to a built-in
  // Anthropic model name (haiku/opus) that the user's provider does not serve.
  const env = buildClaudeEnv({
    provider: "ollama",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    key: "ollama",
    model: "qwen2.5:7b",
  });
  for (const key of [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  ]) {
    assert.equal(env[key], "qwen2.5:7b", `${key} must be the selected model`);
  }
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.DISABLE_TELEMETRY, "1");
});

test("classifyClaudeRunError: 401 and 429 are failover-eligible", () => {
  assert.deepEqual(classifyClaudeRunError("claude exited with code 1: HTTP 429 from gateway"), {
    kind: "rate_limit",
    status: 429,
  });
  assert.deepEqual(classifyClaudeRunError("Error: 401 unauthorized"), { kind: "auth", status: 401 });
  assert.equal(isClaudeFailoverEligible("claude exited with code 1: HTTP 429 from gateway"), true);
  assert.equal(isClaudeFailoverEligible("claude exited with code 1: HTTP 401"), true);
});

test("classifyClaudeRunError: overloaded (529/text) is failover-eligible", () => {
  assert.deepEqual(classifyClaudeRunError("gateway overloaded, retry later"), {
    kind: "server",
    status: undefined,
  });
  assert.equal(isClaudeFailoverEligible("claude exited with code 1: HTTP 529 overloaded"), true);
});

test("classifyClaudeRunError: unrelated failures are not failover-eligible", () => {
  assert.equal(classifyClaudeRunError("claude exited with code 1: permission denied"), null);
  assert.equal(classifyClaudeRunError("claude exited with code 1: ENOENT"), null);
  assert.equal(isClaudeFailoverEligible("bash: command not found"), false);
  assert.equal(classifyClaudeRunError(""), null);
});