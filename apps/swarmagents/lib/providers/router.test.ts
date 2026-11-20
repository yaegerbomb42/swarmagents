import test from "node:test";
import assert from "node:assert/strict";

import { Router, RouterError } from "./router";
import type { FetchLike, ProviderConfig, ProviderKind } from "./types";

function provider(
  id: string,
  kind: ProviderKind,
  keys: string[],
  rank: number
): ProviderConfig {
  return {
    id,
    kind,
    keys,
    rank,
    models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" },
  };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function anthropicOk(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 3, output_tokens: 4 },
    model: "test-balanced",
  };
}

function openaiOk(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 5, completion_tokens: 6 },
    model: "test-balanced",
  };
}

const userMessage = { role: "user" as const, content: "hello" };

test("fails over to the next ranked provider and records key health", async () => {
  const calls: string[] = [];
  const fetchMock: FetchLike = async (url) => {
    calls.push(url);
    if (url.includes("anthropic")) {
      return jsonResponse({ error: { message: "upstream boom" } }, { status: 500 });
    }
    return jsonResponse(openaiOk("fallback answer"));
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-test-failover"], 0),
      provider("openai", "openai", ["sk-oai-test-failover"], 1),
    ],
    fetch: fetchMock,
  });

  const result = await router.complete({
    messages: [userMessage],
    tier: "balanced",
    maxTokens: 32,
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.text, "fallback answer");
  assert.equal(result.usage.inputTokens, 5);
  assert.equal(calls.length, 2);

  const stats = router.stats();
  assert.equal(stats.totalRequests, 1);
  assert.equal(stats.succeeded, 1);
  assert.equal(stats.providers[0].keys[0].failures, 1);
  assert.ok((stats.providers[0].keys[0].cooldownUntil ?? 0) > 0);
  assert.equal(stats.providers[1].keys[0].successes, 1);
  assert.equal(stats.providers[1].keys[0].failures, 0);
});

test("honours 429 Retry-After and does not reuse a cooling key", async () => {
  let clock = 1_000;
  let anthropicCalls = 0;
  let openaiCalls = 0;

  const fetchMock: FetchLike = async (url) => {
    if (url.includes("anthropic")) {
      anthropicCalls += 1;
      return jsonResponse(
        { error: { message: "rate limited" } },
        { status: 429, headers: { "retry-after": "2" } }
      );
    }
    openaiCalls += 1;
    return jsonResponse(openaiOk("after cooldown"));
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-rate-limited"], 0),
      provider("openai", "openai", ["sk-oai-rate-limited"], 1),
    ],
    fetch: fetchMock,
    now: () => clock,
  });

  const first = await router.complete({ messages: [userMessage], tier: "fast" });
  assert.equal(first.provider, "openai");
  assert.equal(anthropicCalls, 1);

  const key = router.stats().providers[0].keys[0];
  assert.equal(key.available, false);
  assert.equal(key.cooldownUntil, 1_000 + 2_000);
  assert.equal(key.lastStatus, 429);

  clock = 1_500;
  const second = await router.complete({ messages: [userMessage], tier: "fast" });
  assert.equal(second.provider, "openai");
  assert.equal(anthropicCalls, 1, "cooling key must not be used again");
  assert.equal(openaiCalls, 2);

  clock = 3_000;
  assert.equal(router.stats().providers[0].keys[0].available, true);
});

test("rotates to another key in the same pool before failing over", async () => {
  let attempts = 0;
  const fetchMock: FetchLike = async (url) => {
    if (url.includes("anthropic")) {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse(
          { error: { message: "slow down" } },
          { status: 429, headers: { "retry-after": "1" } }
        );
      }
      return jsonResponse(anthropicOk("second key"));
    }
    return jsonResponse(openaiOk("should not be needed"));
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-key-one", "sk-ant-key-two"], 0),
      provider("openai", "openai", ["sk-oai-unused"], 1),
    ],
    fetch: fetchMock,
  });

  const result = await router.complete({ messages: [userMessage], tier: "balanced" });
  assert.equal(result.provider, "anthropic");
  assert.equal(result.text, "second key");
  assert.equal(attempts, 2);

  const keys = router.stats().providers[0].keys;
  assert.equal(keys[0].failures, 1);
  assert.equal(keys[0].available, false);
  assert.equal(keys[1].successes, 1);
});

test("race mode takes the first valid response and aborts the rest", async () => {
  let loserAborted = false;

  const fetchMock: FetchLike = (url, init) => {
    if (url.includes("anthropic")) {
      return new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            loserAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
      });
    }
    return Promise.resolve(jsonResponse(openaiOk("race winner")));
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-race-loser"], 0),
      provider("openai", "openai", ["sk-oai-race-winner"], 1),
    ],
    fetch: fetchMock,
  });

  const result = await router.complete({
    messages: [userMessage],
    tier: "balanced",
    race: 2,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.provider, "openai");
  assert.equal(result.text, "race winner");
  assert.equal(loserAborted, true);

  const loserKey = router.stats().providers[0].keys[0];
  assert.equal(loserKey.failures, 0, "cancelled racers are not key failures");
  assert.equal(loserKey.available, true);
});

test("never leaks keys into errors or stats", async () => {
  const anthropicKey = "sk-ant-super-secret-alpha";
  const openaiKey = "sk-oai-super-secret-beta";

  const fetchMock: FetchLike = async (url) => {
    if (url.includes("anthropic")) {
      return jsonResponse(
        { error: { message: `bad credential ${anthropicKey}` } },
        { status: 401 }
      );
    }
    return jsonResponse(
      { error: { message: `also bad credential ${openaiKey}` } },
      { status: 500 }
    );
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", [anthropicKey], 0),
      provider("openai", "openai", [openaiKey], 1),
    ],
    fetch: fetchMock,
  });

  let caught: unknown;
  try {
    await router.complete({ messages: [userMessage], tier: "balanced" });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof RouterError);
  const error = caught as RouterError;
  const serialized = [
    error.message,
    JSON.stringify(error.attempts),
    JSON.stringify(router.stats()),
  ].join("\n");

  assert.equal(serialized.includes(anthropicKey), false);
  assert.equal(serialized.includes(openaiKey), false);
  assert.match(error.message, /\[redacted\]/);
  assert.equal(error.code, "all_failed");
});

test("loads provider keys from SWARM_KEYS_<PROVIDER>", async () => {
  const keyOne = "env-anthropic-key-one";
  const keyTwo = "env-anthropic-key-two";
  const env = { SWARM_KEYS_ANTHROPIC: `${keyOne}, ${keyTwo}` };

  const router = new Router({
    providers: [{ id: "anthropic", kind: "anthropic", rank: 0 }],
    env,
    fetch: async () => jsonResponse(anthropicOk("from env")),
  });

  const result = await router.complete({ messages: [userMessage], tier: "fast" });
  assert.equal(result.provider, "anthropic");
  assert.equal(router.stats().providers[0].keys.length, 2);

  const serialized = JSON.stringify(router.stats());
  assert.equal(serialized.includes(keyOne), false);
  assert.equal(serialized.includes(keyTwo), false);
});

test("calls Gemini with the key in a header, not the URL", async () => {
  const key = "gemini-secret-key";
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};

  const fetchMock: FetchLike = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers ?? {};
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: "gemini answer" }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 },
      modelVersion: "gemini-test",
    });
  };

  const router = new Router({
    providers: [provider("gemini", "gemini", [key], 0)],
    fetch: fetchMock,
  });

  const result = await router.complete({ messages: [userMessage], tier: "fast" });
  assert.equal(result.text, "gemini answer");
  assert.equal(result.usage.inputTokens, 7);
  assert.match(capturedUrl, /\/v1beta\/models\/test-fast:generateContent$/);
  assert.equal(capturedUrl.includes(key), false);
  assert.equal(capturedHeaders["x-goog-api-key"], key);
});

test("skips provider with exhausted daily budget and fails over", async () => {
  const fetchMock: FetchLike = async (url) => {
    if (url.includes("anthropic")) {
      return jsonResponse(anthropicOk("anthropic answer"));
    }
    return jsonResponse(openaiOk("openai answer"));
  };

  const router = new Router({
    providers: [
      {
        id: "anthropic",
        kind: "anthropic",
        keys: ["sk-ant-budget"],
        rank: 0,
        models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" },
        dailyBudgetUsd: 10,
        inputPricePer1mTokens: 1,
        outputPricePer1mTokens: 1,
      },
      { id: "openai", kind: "openai", keys: ["sk-oai-budget"], rank: 1, models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" } },
    ],
    fetch: fetchMock,
  });

  // First request: anthropic succeeds and records spend.
  const first = await router.complete({ messages: [userMessage], tier: "balanced" });
  assert.equal(first.provider, "anthropic");

  const stats = router.budgetStats().find((b) => b.id === "anthropic")!;
  assert.ok(stats.spentTodayUsd > 0);

  // Artificially exhaust the budget via the internal map.
  const internalBudgets = (router as unknown as { budgets: Map<string, { spentTodayUsd: number; dailyBudgetUsd: number }> }).budgets;
  const budget = internalBudgets.get("anthropic")!;
  budget.spentTodayUsd = budget.dailyBudgetUsd;

  // Second request: should fail over to openai because anthropic is over budget.
  const second = await router.complete({ messages: [userMessage], tier: "balanced" });
  assert.equal(second.provider, "openai");
  assert.equal(second.attempts.some((a) => a.kind === "budget_exhausted"), true);
});

test("budget resets at the start of a new day", async () => {
  let clock = 1_000;
  const router = new Router({
    providers: [
      {
        id: "anthropic",
        kind: "anthropic",
        keys: ["sk-ant-budget"],
        rank: 0,
        models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" },
        dailyBudgetUsd: 10,
        inputPricePer1mTokens: 1,
        outputPricePer1mTokens: 1,
      },
    ],
    fetch: async () => jsonResponse(anthropicOk("hello")),
    now: () => clock,
  });

  await router.complete({ messages: [userMessage], tier: "balanced" });
  const budgetBefore = router.budgetStats().find((b) => b.id === "anthropic")!;
  assert.ok(budgetBefore.spentTodayUsd > 0);

  // Advance 24 hours.
  clock += 86_400_000;

  const budgetAfter = router.budgetStats().find((b) => b.id === "anthropic")!;
  assert.equal(budgetAfter.spentTodayUsd, 0);
  assert.equal(budgetAfter.remainingUsd, 10);
});

test("selectForClaude skips budget-exhausted providers", () => {
  const router = new Router({
    providers: [
      {
        id: "anthropic",
        kind: "anthropic",
        keys: ["sk-ant-budget"],
        rank: 0,
        models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" },
        dailyBudgetUsd: 10,
        inputPricePer1mTokens: 1,
        outputPricePer1mTokens: 1,
      },
      { id: "openai", kind: "openai", keys: ["sk-oai-budget"], rank: 1, models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" } },
    ],
    fetch: async () => jsonResponse(anthropicOk("hello")),
  });

  const internalBudgets = (router as unknown as { budgets: Map<string, { spentTodayUsd: number; dailyBudgetUsd: number }> }).budgets;
  const budget = internalBudgets.get("anthropic")!;
  budget.spentTodayUsd = budget.dailyBudgetUsd;

  const sel = router.selectForClaude({ tier: "balanced" });
  assert.ok(sel);
  assert.equal(sel!.provider, "openai");
});
