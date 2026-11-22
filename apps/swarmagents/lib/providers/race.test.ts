import test from "node:test";
import assert from "node:assert/strict";

import { KeyPool } from "./key-pool";
import { ProviderRaceEngine, isValidCompletionText, kindForHttpStatus } from "./race";
import type { RaceRouter } from "./race";
import type { FetchLike, FetchResponse, ProviderConfig } from "./types";

// Fake keys. They only ever live in this test file; nothing here is a real secret.
const FAKE_KEYS = ["gsk_fake_key_1", "gsk_fake_key_2", "gsk_fake_key_3"];

const GROQ_CONFIG: ProviderConfig = {
  id: "groq",
  kind: "openai",
  apiStyle: "openai-chat",
  baseUrl: "https://api.groq.com/openai/v1",
  models: {
    fast: "llama-3.3-70b-versatile",
    balanced: "llama-3.3-70b-versatile",
    deep: "llama-3.3-70b-versatile",
  },
  keys: [...FAKE_KEYS],
};

function makeRouter(pool: KeyPool, config: ProviderConfig): RaceRouter {
  return {
    keyPool: (id) => (id === config.id ? pool : undefined),
    providerConfigs: () => [config],
  };
}

interface FakeBehavior {
  /** ms before this key's response resolves. */
  delayMs: number;
  status: number;
  /** Response body (already a string; JSON for completions). */
  body: string;
  retryAfter?: string;
  throwError?: Error;
}

function completionBody(text: string, outputTokens = 10): string {
  return JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { completion_tokens: outputTokens, total_tokens: outputTokens + 5 },
  });
}

/** A fetch that answers per key (read from the Authorization header) and honours aborts. */
function makeFetch(behaviors: Map<string, FakeBehavior>): FetchLike {
  return (async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const authKey = Object.keys(headers).find(
      (k) => k.toLowerCase() === "authorization",
    );
    const auth = authKey ? headers[authKey]! : "";
    const key = auth.replace(/^Bearer\s+/i, "");
    const behavior = behaviors.get(key);
    if (!behavior) throw new Error(`fake fetch: no behavior for key ${key.slice(0, 6)}`);
    if (behavior.throwError) throw behavior.throwError;

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(resolvePromise, behavior.delayMs);
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          rejectPromise(err);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            rejectPromise(err);
          },
          { once: true },
        );
      }
    });

    const response: FetchResponse = {
      ok: behavior.status >= 200 && behavior.status < 300,
      status: behavior.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "retry-after" ? (behavior.retryAfter ?? null) : null,
      },
      text: async () => behavior.body,
    };
    return response;
  }) as FetchLike;
}

function behaviorFor(key: string, behavior: FakeBehavior): [string, FakeBehavior][] {
  return [[key, behavior]];
}

// ---------------------------------------------------------------------------
// Garbage validator
// ---------------------------------------------------------------------------

test("validator: plain valid text passes", () => {
  assert.equal(isValidCompletionText("Hello, here is the answer."), true);
  assert.equal(isValidCompletionText("```js\nconst x = 1;\n```"), true);
});

test("validator: empty or whitespace-only fails", () => {
  assert.equal(isValidCompletionText(""), false);
  assert.equal(isValidCompletionText("   \n\t  "), false);
});

test("validator: replacement characters fail", () => {
  assert.equal(isValidCompletionText("��� ��� ���"), false);
  assert.equal(isValidCompletionText("The result is ���"), false);
});

test("validator: token soup (-Re fragments) fails", () => {
  assert.equal(isValidCompletionText("The -Re-Re-Re result is -Re-P"), false);
  assert.equal(isValidCompletionText("a".repeat(50) + "-Re-Re-Re-Re"), false);
});

test("validator: runaway dashes fail", () => {
  assert.equal(isValidCompletionText(`start ${"-".repeat(50)} end`), false);
});

test("validator: high CJK share fails", () => {
  assert.equal(isValidCompletionText("你好世界这是一个测试中文内容"), false);
});

test("validator: a little CJK in normal text passes", () => {
  assert.equal(isValidCompletionText("Hello 世界, this is a normal answer."), true);
});

// ---------------------------------------------------------------------------
// Status -> kind mapping
// ---------------------------------------------------------------------------

test("kindForHttpStatus maps statuses to pool kinds", () => {
  assert.equal(kindForHttpStatus(429), "rate_limit");
  assert.equal(kindForHttpStatus(401), "auth");
  assert.equal(kindForHttpStatus(403), "auth");
  assert.equal(kindForHttpStatus(402), "quota_exhausted");
  assert.equal(kindForHttpStatus(408), "timeout");
  assert.equal(kindForHttpStatus(400), "bad_request");
  assert.equal(kindForHttpStatus(404), "bad_request");
  assert.equal(kindForHttpStatus(500), "server");
  assert.equal(kindForHttpStatus(503), "server");
});

// ---------------------------------------------------------------------------
// Race
// ---------------------------------------------------------------------------

test("race: fastest valid response wins", async () => {
  const pool = new KeyPool("groq", FAKE_KEYS);
  const engine = new ProviderRaceEngine({
    router: makeRouter(pool, GROQ_CONFIG),
    fetch: makeFetch(
      new Map([
        ...behaviorFor(FAKE_KEYS[0], {
          delayMs: 50,
          status: 200,
          body: completionBody("slow answer"),
        }),
        ...behaviorFor(FAKE_KEYS[1], {
          delayMs: 10,
          status: 200,
          body: completionBody("fast answer"),
        }),
        ...behaviorFor(FAKE_KEYS[2], {
          delayMs: 100,
          status: 200,
          body: completionBody("slowest answer"),
        }),
      ]),
    ),
  });

  const result = await engine.complete({ prompt: "hi", provider: "groq" });
  assert.equal(result.text, "fast answer");
  assert.equal(result.keyId, "groq:key-2");
  assert.equal(result.provider, "groq");
  assert.equal(result.tokens, 10);

  // The winner recorded a success; the losers were cancelled, not failed.
  const stats = pool.stats();
  assert.equal(stats[1].successes, 1);
  assert.equal(stats[0].successes, 0);
  assert.equal(stats[0].failures, 0);
  assert.equal(stats[2].successes, 0);
  assert.equal(stats[2].failures, 0);
});

test("race: garbage from the fastest key does not win", async () => {
  const pool = new KeyPool("groq", FAKE_KEYS);
  const engine = new ProviderRaceEngine({
    router: makeRouter(pool, GROQ_CONFIG),
    fetch: makeFetch(
      new Map([
        ...behaviorFor(FAKE_KEYS[0], {
          delayMs: 10,
          status: 200,
          body: completionBody("The -Re-Re-Re result is -Re-P"),
        }),
        ...behaviorFor(FAKE_KEYS[1], {
          delayMs: 50,
          status: 200,
          body: completionBody("the real answer"),
        }),
        ...behaviorFor(FAKE_KEYS[2], {
          delayMs: 100,
          status: 200,
          body: completionBody("also real but slower"),
        }),
      ]),
    ),
  });

  const result = await engine.complete({ prompt: "hi", provider: "groq" });
  assert.equal(result.text, "the real answer");
  assert.equal(result.keyId, "groq:key-2");

  // The garbage key counted as a failure; the valid key succeeded.
  const stats = pool.stats();
  assert.equal(stats[0].failures, 1);
  assert.equal(stats[1].successes, 1);
});

test("race: all keys failing rejects and cools the keys down", async () => {
  const pool = new KeyPool("groq", FAKE_KEYS);
  const engine = new ProviderRaceEngine({
    router: makeRouter(pool, GROQ_CONFIG),
    fetch: makeFetch(
      new Map(
        FAKE_KEYS.map((key) => [
          key,
          { delayMs: 5, status: 429, body: "rate limited" },
        ]),
      ),
    ),
  });

  await assert.rejects(
    engine.complete({ prompt: "hi", provider: "groq" }),
    /All 3 candidate\(s\) for provider "groq" failed/,
  );

  // Every key failed with a cooldown kind, so all are cooling.
  const stats = pool.stats();
  assert.equal(stats.length, 3);
  for (const stat of stats) {
    assert.equal(stat.failures, 1);
    assert.ok(stat.cooldownUntil !== undefined, "key should be cooling");
  }
});

test("race: Retry-After is honoured on the failing key", async () => {
  const pool = new KeyPool("groq", FAKE_KEYS);
  const before = Date.now();
  const engine = new ProviderRaceEngine({
    router: makeRouter(pool, GROQ_CONFIG),
    fetch: makeFetch(
      new Map([
        ...behaviorFor(FAKE_KEYS[0], {
          delayMs: 5,
          status: 429,
          body: "slow down",
          retryAfter: "60",
        }),
        ...behaviorFor(FAKE_KEYS[1], {
          delayMs: 5,
          status: 429,
          body: "slow down",
        }),
        ...behaviorFor(FAKE_KEYS[2], {
          delayMs: 5,
          status: 429,
          body: "slow down",
        }),
      ]),
    ),
  });

  await assert.rejects(engine.complete({ prompt: "hi", provider: "groq" }));

  const stats = pool.stats();
  // The Retry-After key cools for ~60s; the others cool for the base backoff (~1s).
  assert.ok(
    (stats[0].cooldownUntil ?? 0) >= before + 55_000,
    `key-1 cooldown ${stats[0].cooldownUntil} should be ~60s`,
  );
  assert.ok((stats[1].cooldownUntil ?? 0) > before, "key-2 should be cooling");
});

test("race: outer abort rejects and cancels the leases", async () => {
  const pool = new KeyPool("groq", FAKE_KEYS);
  const controller = new AbortController();
  const engine = new ProviderRaceEngine({
    router: makeRouter(pool, GROQ_CONFIG),
    fetch: makeFetch(
      new Map(
        FAKE_KEYS.map((key) => [
          key,
          { delayMs: 200, status: 200, body: completionBody("too late") },
        ]),
      ),
    ),
  });

  const promise = engine.complete({ prompt: "hi", provider: "groq", signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, /aborted/i);

  // No key recorded a success or a failure.
  for (const stat of pool.stats()) {
    assert.equal(stat.successes, 0);
    assert.equal(stat.failures, 0);
  }
});

test("race: no available keys rejects", async () => {
  const pool = new KeyPool("groq", FAKE_KEYS);
  pool.cooldownAllKeys(60_000);
  const engine = new ProviderRaceEngine({
    router: makeRouter(pool, GROQ_CONFIG),
    fetch: makeFetch(new Map()),
  });

  await assert.rejects(
    engine.complete({ prompt: "hi", provider: "groq" }),
    /no available keys \(3\/3 cooling\)/,
  );
});

test("race: unknown provider rejects", async () => {
  const pool = new KeyPool("groq", FAKE_KEYS);
  const engine = new ProviderRaceEngine({
    router: makeRouter(pool, GROQ_CONFIG),
    fetch: makeFetch(new Map()),
  });

  await assert.rejects(
    engine.complete({ prompt: "hi", provider: "nope" }),
    /no provider config for "nope"/,
  );
});

test("race: fewer keys than candidates races just the one key", async () => {
  const pool = new KeyPool("groq", [FAKE_KEYS[0]]);
  const engine = new ProviderRaceEngine({
    router: makeRouter(pool, GROQ_CONFIG),
    fetch: makeFetch(
      new Map([
        ...behaviorFor(FAKE_KEYS[0], {
          delayMs: 5,
          status: 200,
          body: completionBody("only key"),
        }),
      ]),
    ),
  });

  const result = await engine.complete({ prompt: "hi", provider: "groq", candidates: 3 });
  assert.equal(result.text, "only key");
  assert.equal(result.keyId, "groq:key-1");
});

test("race: network error on one key does not stop the others", async () => {
  const pool = new KeyPool("groq", FAKE_KEYS);
  const engine = new ProviderRaceEngine({
    router: makeRouter(pool, GROQ_CONFIG),
    fetch: makeFetch(
      new Map([
        ...behaviorFor(FAKE_KEYS[0], {
          delayMs: 5,
          status: 200,
          body: completionBody("unused"),
          throwError: new Error("fetch failed"),
        }),
        ...behaviorFor(FAKE_KEYS[1], {
          delayMs: 10,
          status: 200,
          body: completionBody("winner despite the network error"),
        }),
        ...behaviorFor(FAKE_KEYS[2], {
          delayMs: 100,
          status: 200,
          body: completionBody("slowest"),
        }),
      ]),
    ),
  });

  const result = await engine.complete({ prompt: "hi", provider: "groq" });
  assert.equal(result.text, "winner despite the network error");
  assert.equal(result.keyId, "groq:key-2");
  assert.equal(pool.stats()[0].failures, 1);
});
