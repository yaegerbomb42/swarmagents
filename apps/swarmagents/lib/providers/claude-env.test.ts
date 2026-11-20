/**
 * Unit tests for buildClaudeEnv and the Claude run error classifier.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeEnv,
  classifyClaudeRunError,
  isClaudeFailoverEligible,
} from "./claude-env";

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
  });
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
