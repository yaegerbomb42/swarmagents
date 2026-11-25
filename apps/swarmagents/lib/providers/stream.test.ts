import test from "node:test";
import assert from "node:assert/strict";

import { Router } from "./router";
import type {
  FetchLike,
  FetchResponse,
  ProviderConfig,
  ProviderKind,
  StreamDone,
  StreamEvent,
} from "./types";

type Chunk = string | { text: string; delayMs?: number };

interface MockStream {
  response: FetchResponse;
  cancelled: () => boolean;
}

function makeStream(chunks: Chunk[]): MockStream {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      try {
        if (typeof chunk === "string") {
          controller.enqueue(encoder.encode(chunk));
          return;
        }
        if (chunk.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, chunk.delayMs));
        }
        if (cancelled) return;
        controller.enqueue(encoder.encode(chunk.text));
      } catch {
        // The consumer cancelled while a delayed chunk was pending.
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    response: {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "",
      body,
    },
    cancelled: () => cancelled,
  };
}

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

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicStream(texts: string[]): string[] {
  return [
    anthropicFrame("message_start", {
      type: "message_start",
      message: {
        model: "test-balanced",
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }),
    ...texts.map((text) =>
      anthropicFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      })
    ),
    anthropicFrame("message_delta", {
      type: "message_delta",
      usage: { output_tokens: 5 },
    }),
    anthropicFrame("message_stop", { type: "message_stop" }),
  ];
}

function openaiFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function openaiStream(texts: string[]): string[] {
  return [
    ...texts.map((text) =>
      openaiFrame({
        model: "test-balanced",
        choices: [{ index: 0, delta: { content: text } }],
      })
    ),
    openaiFrame({
      model: "test-balanced",
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    }),
    "data: [DONE]\n\n",
  ];
}

const userMessage = { role: "user" as const, content: "hello" };

function collect(events: StreamEvent[]): StreamDone {
  const last = events[events.length - 1];
  assert.equal(last?.type, "done");
  return last as StreamDone;
}

test("streams Anthropic SSE as unified deltas and a done event", async () => {
  const stream = makeStream(anthropicStream(["Hel", "lo"]));
  let sentBody: Record<string, unknown> = {};

  const fetchMock: FetchLike = async (_url, init) => {
    sentBody = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    return stream.response;
  };

  const router = new Router({
    providers: [provider("anthropic", "anthropic", ["sk-ant-stream"], 0)],
    fetch: fetchMock,
  });

  const events: StreamEvent[] = [];
  for await (const event of router.stream({
    messages: [userMessage],
    tier: "balanced",
  })) {
    events.push(event);
  }

  const deltas = events.filter((event) => event.type === "delta");
  assert.deepEqual(
    deltas.map((event) => event.text),
    ["Hel", "lo"]
  );
  assert.equal(sentBody.stream, true);

  const done = collect(events);
  assert.equal(done.provider, "anthropic");
  assert.equal(done.text, "Hello");
  assert.equal(done.model, "test-balanced");
  assert.equal(done.usage.inputTokens, 3);
  assert.equal(done.usage.outputTokens, 5);
  assert.equal(done.attempts.at(-1)?.ok, true);
});

test("streams OpenAI-compatible SSE chunks and usage", async () => {
  const stream = makeStream(openaiStream(["fast", " answer"]));
  let sentBody: Record<string, unknown> = {};

  const fetchMock: FetchLike = async (_url, init) => {
    sentBody = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    return stream.response;
  };

  const router = new Router({
    providers: [provider("openai", "openai", ["sk-oai-stream"], 0)],
    fetch: fetchMock,
  });

  const events: StreamEvent[] = [];
  for await (const event of router.stream({
    messages: [userMessage],
    tier: "balanced",
  })) {
    events.push(event);
  }

  const deltas = events.filter((event) => event.type === "delta");
  assert.deepEqual(
    deltas.map((event) => event.text),
    ["fast", " answer"]
  );
  assert.equal(sentBody.stream, true);

  const done = collect(events);
  assert.equal(done.provider, "openai");
  assert.equal(done.text, "fast answer");
  assert.equal(done.usage.inputTokens, 5);
  assert.equal(done.usage.outputTokens, 6);
});

test("race takes the first token and aborts losing streams", async () => {
  const slowAnthropic = makeStream([
    { text: anthropicStream(["slow"])[0], delayMs: 50 },
  ]);
  const fastOpenAI = makeStream(openaiStream(["fast", " answer"]));

  const fetchMock: FetchLike = async (url) => {
    if (url.includes("anthropic")) return slowAnthropic.response;
    return fastOpenAI.response;
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-race-loser"], 0),
      provider("openai", "openai", ["sk-oai-race-winner"], 1),
    ],
    fetch: fetchMock,
  });

  const events: StreamEvent[] = [];
  for await (const event of router.stream({
    messages: [userMessage],
    tier: "balanced",
    race: 2,
  })) {
    events.push(event);
  }

  const done = collect(events);
  assert.equal(done.provider, "openai");
  assert.equal(done.text, "fast answer");

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(slowAnthropic.cancelled(), true, "losing stream is cancelled");

  const loserKey = router.stats().providers[0].keys[0];
  assert.equal(loserKey.failures, 0, "cancelled racers are not key failures");
  assert.equal(loserKey.available, true);
});

test("a loser that errors mid-stream does not break the winner", async () => {
  const failingAnthropic = makeStream([
    anthropicStream(["partial"])[0],
    { text: anthropicFrame("ping", { type: "ping" }), delayMs: 5 },
    {
      text: anthropicFrame("error", {
        type: "error",
        error: { message: "upstream stream boom" },
      }),
      delayMs: 5,
    },
  ]);
  const slowOpenAI = makeStream([
    { text: openaiStream(["winner"])[0], delayMs: 30 },
    ...openaiStream(["winner"]).slice(1),
  ]);

  const fetchMock: FetchLike = async (url) => {
    if (url.includes("anthropic")) return failingAnthropic.response;
    return slowOpenAI.response;
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-mid-error"], 0),
      provider("openai", "openai", ["sk-oai-mid-winner"], 1),
    ],
    fetch: fetchMock,
  });

  const events: StreamEvent[] = [];
  for await (const event of router.stream({
    messages: [userMessage],
    tier: "balanced",
    race: 2,
  })) {
    events.push(event);
  }

  const done = collect(events);
  assert.equal(done.provider, "openai");
  assert.equal(done.text, "winner");

  const failed = done.attempts.find((attempt) => attempt.provider === "anthropic");
  assert.ok(failed, "failed racer is recorded");
  assert.equal(failed?.ok, false);
  assert.match(failed?.error ?? "", /upstream stream boom/);

  const failedKey = router.stats().providers[0].keys[0];
  assert.equal(failedKey.failures, 1);
});

test("stream rotates to the next key of the same provider on a pre-token 429", async () => {
  let clock = 1_000;
  const secondKey = makeStream(anthropicStream(["second", " key"]));

  const fetchMock: FetchLike = async (_url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const key = headers["x-api-key"] ?? "";
    if (key === "sk-ant-key-one") {
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "1", "content-type": "application/json" },
      });
    }
    return secondKey.response;
  };

  const router = new Router({
    providers: [provider("anthropic", "anthropic", ["sk-ant-key-one", "sk-ant-key-two"], 0)],
    fetch: fetchMock,
    now: () => clock,
  });

  const events: StreamEvent[] = [];
  for await (const event of router.stream({
    messages: [userMessage],
    tier: "balanced",
  })) {
    events.push(event);
  }

  const done = collect(events);
  assert.equal(done.provider, "anthropic");
  assert.equal(done.text, "second key");
  assert.equal(done.keyId, "anthropic:key-2");

  const keys = router.stats().providers[0].keys;
  assert.equal(keys[0].failures, 1);
  assert.equal(keys[0].available, false);
  assert.equal(keys[0].cooldownUntil, 1_000 + 1_000, "Retry-After is honoured");
  assert.equal(keys[0].lastStatus, 429);
  assert.equal(keys[1].successes, 1);

  const firstAttempt = done.attempts[0];
  assert.equal(firstAttempt?.ok, false);
  assert.equal(firstAttempt?.keyId, "anthropic:key-1");
  assert.equal(firstAttempt?.status, 429);
  assert.equal(done.attempts.at(-1)?.ok, true);
  assert.equal(done.attempts.at(-1)?.keyId, "anthropic:key-2");

  // Cooldown recovery: once the window passes, the rate-limited key is
  // usable again instead of being stuck out of rotation.
  clock = 2_500;
  assert.equal(router.stats().providers[0].keys[0].available, true);
});

test("stream fails over to the next provider only after every key is exhausted", async () => {
  const openai = makeStream(openaiStream(["after", " failover"]));
  let anthropicCalls = 0;

  const fetchMock: FetchLike = async (url, init) => {
    if (url.includes("anthropic")) {
      anthropicCalls += 1;
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "1", "content-type": "application/json" },
      });
    }
    return openai.response;
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-key-one", "sk-ant-key-two"], 0),
      provider("openai", "openai", ["sk-oai-failover"], 1),
    ],
    fetch: fetchMock,
  });

  const events: StreamEvent[] = [];
  for await (const event of router.stream({
    messages: [userMessage],
    tier: "balanced",
  })) {
    events.push(event);
  }

  const done = collect(events);
  assert.equal(done.provider, "openai");
  assert.equal(done.text, "after failover");
  assert.equal(anthropicCalls, 2, "both anthropic keys were tried before failover");

  const keys = router.stats().providers[0].keys;
  assert.deepEqual(
    keys.map((key) => key.failures),
    [1, 1],
  );
  assert.deepEqual(
    done.attempts.map((attempt) => attempt.keyId),
    ["anthropic:key-1", "anthropic:key-2", "openai:key-1"],
  );
});
