/**
 * Unit tests for the LLM gateway forwarding layer
 * (lib/runtime/llm-gateway.ts): provider ranking, failover on 404/429/5xx/
 * connect errors, anthropic pass-through, OpenAI translation, and streaming
 * SSE translation. All upstream calls use a stubbed fetch — no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  forwardLlmNonStreaming,
  forwardLlmStreaming,
  orderLlmCandidates,
  type LlmCallEvent,
} from "./llm-gateway";
import type { ProviderConfig } from "../providers/types";
import type { TelemetryBus } from "../telemetry";
import { configureProviderStorePaths, userCooldownFilePath } from "../providers/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unique owner per test: cooldown state is persisted per owner, so sharing
// an owner across tests would leak cooldowns between them.
let ownerSeq = 0;
function owner(): string {
  return `user-gateway-${++ownerSeq}`;
}

// Cooldown persistence writes to the store directory; point it at a temp dir
// so tests never touch the real SWARM_HOME / home account data.
let tempDir = "";
test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-gateway-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Unique key material per provider: a failed key's cooldown persists to the
// owner's cooldown file, so reusing the same key across tests would make a
// later pool acquire() return null before any fetch happens.
let keySeq = 0;
function mockKey(): string {
  return `sk-mock-${++keySeq}`;
}

const ANTHROPIC_REQ = {
  model: "claude-x",
  max_tokens: 64,
  messages: [{ role: "user", content: "ping" }],
};

const OPENAI_RESPONSE = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "mock-openai-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "pong" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 1 },
};

const ANTHROPIC_RESPONSE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-x",
  content: [{ type: "text", text: "pong" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 1 },
};

function provider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: `mock-${ownerSeq}`,
    kind: "openai",
    models: { balanced: "mock-openai-model" },
    keys: [mockKey()],
    rank: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stub fetch: routes by URL prefix; records calls for assertions. */
function stubFetch(routes: Array<{ prefix: string; respond: (init: RequestInit, url: string) => Response }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init: init ?? {} });
    for (const route of routes) {
      if (url.startsWith(route.prefix)) return route.respond(init ?? {}, url);
    }
    return jsonResponse({ error: { message: "unexpected url" } }, 404);
  };
  return { fetchImpl, calls };
}

test("orderLlmCandidates ranks enabled providers by rank, preferring the requested model", () => {
  const providers: ProviderConfig[] = [
    provider({ id: "b", rank: 1, models: { balanced: "b-model" } }),
    provider({ id: "a", rank: 0, models: { balanced: "a-model" } }),
    provider({ id: "disabled", rank: -1, enabled: false }),
    provider({ id: "c", rank: 2, models: { balanced: "c-model" } }),
  ];
  const ordered = orderLlmCandidates(providers, "c-model");
  assert.deepEqual(ordered.map((c) => c.config.id), ["c", "a", "b"]);
  assert.equal(ordered[0].model, "c-model");
});

test("orderLlmCandidates with preferFree puts free providers first, keeping rank inside each group", () => {
  const providers: ProviderConfig[] = [
    provider({ id: "paid-a", rank: 0, isFree: false }),
    provider({ id: "free-b", rank: 1, isFree: true }),
    provider({ id: "free-a", rank: 0, isFree: true }),
    provider({ id: "paid-b", rank: 2, isFree: false }),
  ];
  const ordered = orderLlmCandidates(providers, undefined, { preferFree: true });
  assert.deepEqual(ordered.map((c) => c.config.id), ["free-a", "free-b", "paid-a", "paid-b"]);
  // Default (preferFree off / unset) is plain rank order.
  const byRank = orderLlmCandidates(providers, undefined);
  assert.deepEqual(byRank.map((c) => c.config.id), ["paid-a", "free-a", "free-b", "paid-b"]);
  const byRankDefault = orderLlmCandidates(providers, undefined, { preferFree: false });
  assert.deepEqual(byRankDefault.map((c) => c.config.id), ["paid-a", "free-a", "free-b", "paid-b"]);
});

test("orderLlmCandidates resolves tier alias requestedModel and options.tier to fast/balanced/deep", () => {
  const providers: ProviderConfig[] = [
    provider({
      id: "multi",
      rank: 0,
      models: { fast: "mini-fast", balanced: "mid-bal", deep: "pro-deep" },
    }),
  ];
  assert.equal(orderLlmCandidates(providers, "fast")[0].model, "mini-fast");
  assert.equal(orderLlmCandidates(providers, "deep")[0].model, "pro-deep");
  assert.equal(orderLlmCandidates(providers, undefined, { tier: "deep" })[0].model, "pro-deep");
  assert.equal(orderLlmCandidates(providers, undefined)[0].model, "mid-bal");
});

/** In-memory bus spy: captures published events, never persists. */
function memoryBus() {
  const events: Array<{ runId: string; event: { type: string; data?: unknown } }> = [];
  return {
    publish: (runId: string, event: { type: string; data?: unknown }) => {
      events.push({ runId, event });
    },
    events,
  };
}

test("non-streaming forward emits llm.call events with provider/model/attempt/outcome/latency/cost, never secrets", async () => {
  const bus = memoryBus();
  const key = mockKey();
  const { fetchImpl } = stubFetch([
    { prefix: "https://openai.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
  ]);
  const result = await forwardLlmNonStreaming({
    owner: owner(),
    runId: "run-evt",
    bus: bus as unknown as TelemetryBus,
    providers: [
      provider({
        id: "openai",
        baseUrl: "https://openai.example/v1",
        models: { balanced: "mock-openai-model" },
        keys: [key],
        inputPricePer1mTokens: 10,
        outputPricePer1mTokens: 20,
      }),
    ],
    body: ANTHROPIC_REQ,
    requestedModel: "mock-openai-model",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(result.attempts.length, 1);
  // One llm.call per attempt; the router adds one route.decision per pick.
  const llmCalls = bus.events.filter((e) => e.event.type === "llm.call");
  assert.equal(llmCalls.length, 1);
  assert.deepEqual(bus.events.map((e) => e.event.type), ["route.decision", "llm.call"]);
  const ev = llmCalls[0];
  assert.equal(ev.runId, "run-evt");
  assert.equal(ev.event.type, "llm.call");
  const d = (ev.event as LlmCallEvent).data;
  assert.equal(d.provider, "openai");
  assert.equal(d.model, "mock-openai-model");
  assert.equal(d.attempt, 1);
  assert.equal(d.outcome, "ok");
  assert.equal(typeof d.latencyMs, "number");
  assert.equal(d.inputTokens, 5);
  assert.equal(d.outputTokens, 1);
  // 5 in-tokens @ $10/1M + 1 out-token @ $20/1M = $0.00007.
  assert.ok(Math.abs((d.costUsd as number) - 0.00007) < 1e-12);

  // Secrets and prompt content never leak into telemetry.
  const ser = JSON.stringify(bus.events);
  assert.ok(!ser.includes(key), "key material must never appear in telemetry");
  assert.ok(!ser.includes("ping"), "prompt content must never appear in telemetry");
});

test("non-streaming forward: 402 fails over and cools the provider down for the quota window", async () => {
  const keyA = mockKey();
  const { fetchImpl, calls } = stubFetch([
    { prefix: "https://quota.example", respond: () => jsonResponse({ error: { type: "quota_exhausted", message: "monthly limit" } }, 402) },
    { prefix: "https://good.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
  ]);
  const providersList = [
    provider({ id: "quota", baseUrl: "https://quota.example", rank: 0, keys: [keyA] }),
    provider({ id: "good", baseUrl: "https://good.example/v1", rank: 1 }),
  ];
  const u = owner();

  const first = await forwardLlmNonStreaming({
    owner: u, providers: providersList, body: ANTHROPIC_REQ,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(first.attempts.length, 2);
  assert.equal(first.attempts[0].status, 402);
  assert.equal(first.attempts[0].kind, "quota_exhausted");
  assert.equal(first.attempts[1].ok, true);
  assert.equal(calls.length, 2);

  // Second call with the same owner+key: the quota provider's key is out of
  // credit (default 15-minute window), so the router skips it without a
  // fetch — the route.decision event says why instead of a fake attempt.
  const bus = memoryBus();
  const second = await forwardLlmNonStreaming({
    owner: u, providers: providersList, body: ANTHROPIC_REQ,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    runId: "run-402", bus: bus as unknown as TelemetryBus,
  });
  assert.equal(calls.length, 3, "cooled-down provider must not be contacted again");
  assert.equal(second.attempts.length, 1);
  assert.equal(second.attempts[0].ok, true);
  assert.equal(second.attempts[0].provider, "good");
  const decision = bus.events.find((e) => e.event.type === "route.decision")!.event.data as {
    candidates: Array<{ provider: string; reasons: string[] }>;
  };
  const quota = decision.candidates.find((c) => c.provider === "quota")!;
  assert.ok(quota.reasons.includes("key_exhausted_credit_402"), JSON.stringify(quota));
  const lastCall = calls[2];
  assert.ok(lastCall.url.startsWith("https://good.example"), "only the healthy provider is called");
});

test("non-streaming forward: anthropic providers are passed through untouched", async () => {
  const { fetchImpl, calls } = stubFetch([
    {
      prefix: "https://anthropic.example",
      respond: () => jsonResponse(ANTHROPIC_RESPONSE),
    },
  ]);
  const key = mockKey();
  const result = await forwardLlmNonStreaming({
    owner: owner(),
    providers: [provider({ id: "anthropic", kind: "anthropic", baseUrl: "https://anthropic.example", models: { balanced: "claude-x" }, keys: [key] })],
    body: ANTHROPIC_REQ,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://anthropic.example/v1/messages");
  const init = calls[0].init;
  assert.equal((init.headers as Record<string, string>)["x-api-key"], key);
  assert.equal((init.headers as Record<string, string>)["anthropic-version"], "2023-06-01");
  assert.equal(init.body, JSON.stringify(ANTHROPIC_REQ));
  assert.deepEqual(result.body, ANTHROPIC_RESPONSE);
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 1 });
  assert.equal(result.attempts[0].ok, true);
  assert.equal(result.attempts[0].provider, "anthropic");
});

test("non-streaming forward: failover on 404 to the next provider by rank, with translation", async () => {
  const { fetchImpl, calls } = stubFetch([
    {
      prefix: "https://broken.example",
      respond: () => jsonResponse({ error: { message: "not found" } }, 404),
    },
    {
      prefix: "https://openai.example",
      respond: (init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert.equal((body as { model: string }).model, "mock-openai-model", "translated request uses provider model");
        assert.deepEqual(body.messages, [
          { role: "system", content: "You are a terse assistant." },
          { role: "user", content: "ping" },
        ]);
        return jsonResponse(OPENAI_RESPONSE);
      },
    },
  ]);

  const result = await forwardLlmNonStreaming({
    owner: owner(),
    providers: [
      provider({ id: "broken", baseUrl: "https://broken.example", rank: 0 }),
      provider({ id: "openai", baseUrl: "https://openai.example/v1", rank: 1 }),
    ],
    body: { ...ANTHROPIC_REQ, system: "You are a terse assistant." },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://broken.example/v1/chat/completions");
  assert.equal(calls[1].url, "https://openai.example/v1/chat/completions");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[0].status, 404);
  assert.equal(result.attempts[1].ok, true);
  assert.equal(result.attempts[1].provider, "openai");
  assert.deepEqual(result.body, {
    id: "msg_chatcmpl-1",
    type: "message",
    role: "assistant",
    model: "mock-openai-model",
    content: [{ type: "text", text: "pong" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 },
  });
});

for (const [name, status] of [["429", 429], ["500", 500], ["503", 503]] as const) {
  test(`non-streaming forward: failover on ${name}`, async () => {
    const { fetchImpl, calls } = stubFetch([
      { prefix: "https://bad.example", respond: () => jsonResponse({}, status) },
      { prefix: "https://good.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
    ]);
    const result = await forwardLlmNonStreaming({
      owner: owner(),
      providers: [
        provider({ id: "bad", baseUrl: "https://bad.example" }),
        provider({ id: "good", baseUrl: "https://good.example/v1" }),
      ],
      body: ANTHROPIC_REQ,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assert.equal(calls.length, 2);
    assert.equal(result.attempts[0].status, status);
    assert.equal(result.attempts[1].ok, true);
  });
}

test("non-streaming forward: network errors fail over", async () => {
  const { fetchImpl, calls } = stubFetch([
    {
      prefix: "https://bad.example",
      respond: () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    },
    { prefix: "https://good.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
  ]);
  const result = await forwardLlmNonStreaming({
    owner: owner(),
    providers: [
      provider({ id: "bad", baseUrl: "https://bad.example" }),
      provider({ id: "good", baseUrl: "https://good.example/v1" }),
    ],
    body: ANTHROPIC_REQ,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.attempts[0].kind, "network");
  assert.equal(result.attempts[1].ok, true);
});

test("non-streaming forward: non-failover statuses (400) abort instead of failing over", async () => {
  const { fetchImpl, calls } = stubFetch([
    { prefix: "https://bad.example", respond: () => jsonResponse({ error: { message: "bad request" } }, 400) },
    { prefix: "https://good.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
  ]);
  await assert.rejects(
    forwardLlmNonStreaming({
      owner: owner(),
      providers: [
        provider({ id: "bad", baseUrl: "https://bad.example" }),
        provider({ id: "good", baseUrl: "https://good.example/v1" }),
      ],
      body: ANTHROPIC_REQ,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
    (err: unknown) => {
      assert.equal((err as { status: number }).status, 400);
      assert.equal(calls.length, 1);
      assert.equal((err as { attempts: unknown[] }).attempts.length, 1);
      return true;
    },
  );
});

test("non-streaming forward: all providers failed -> 502 with attempts summary", async () => {
  const { fetchImpl } = stubFetch([
    { prefix: "https://a.example", respond: () => jsonResponse({}, 404) },
    { prefix: "https://b.example", respond: () => jsonResponse({}, 503) },
  ]);
  await assert.rejects(
    forwardLlmNonStreaming({
      owner: owner(),
      providers: [
        provider({ id: "a", baseUrl: "https://a.example" }),
        provider({ id: "b", baseUrl: "https://b.example/v1" }),
      ],
      body: ANTHROPIC_REQ,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
    (err: unknown) => {
      const failure = err as { status: number; body: string; attempts: unknown[] };
      assert.equal(failure.status, 502);
      assert.equal(failure.attempts.length, 2);
      assert.match(failure.body, /a \(404\)/);
      assert.match(failure.body, /b \(503\)/);
      return true;
    },
  );
});

test("non-streaming forward: no configured providers -> 503", async () => {
  await assert.rejects(
    forwardLlmNonStreaming({
      owner: owner(),
      providers: [provider({ id: "nokeys", keys: [] })],
      body: ANTHROPIC_REQ,
      fetchImpl: (async () => new Response()) as unknown as typeof fetch,
    }),
    (err: unknown) => (err as { status: number }).status === 503,
  );
});

function openaiSseResponse(chunks: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function collectStream(gen: AsyncGenerator<Uint8Array, void, void>): Promise<string> {
  return (async () => {
    let out = "";
    for await (const bytes of gen) out += new TextDecoder().decode(bytes);
    return out;
  })();
}

test("streaming forward: failover on 404 before committing, then SSE translation", async () => {
  const { fetchImpl, calls } = stubFetch([
    { prefix: "https://bad.example", respond: () => jsonResponse({}, 404) },
    {
      prefix: "https://good.example",
      respond: () =>
        openaiSseResponse([
          {
            id: "chatcmpl-s1",
            model: "mock-openai-model",
            choices: [{ index: 0, delta: { role: "assistant", content: "stream" } }],
          },
          {
            choices: [{ index: 0, delta: { content: "ing" } }],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          },
        ]),
    },
  ]);

  const out = await collectStream(
    forwardLlmStreaming({
      owner: owner(),
      providers: [
        provider({ id: "bad", baseUrl: "https://bad.example" }),
        provider({ id: "good", baseUrl: "https://good.example/v1" }),
      ],
      body: { ...ANTHROPIC_REQ, stream: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://bad.example/v1/chat/completions");
  assert.equal(calls[1].url, "https://good.example/v1/chat/completions");
  // Failover is observable: the comment names the provider that finally served.
  assert.match(out, /: provider=good\n/);
  assert.match(out, /event: message_start/);
  assert.match(out, /event: content_block_start/);
  assert.match(out, /event: content_block_delta/);
  assert.match(out, /"delta":\{"type":"text_delta","text":"stream"\}/);
  assert.match(out, /event: content_block_stop/);
  assert.match(out, /event: message_delta/);
  assert.match(out, /"stop_reason":"end_turn"/);
  // OpenAI stream usage is translated to the Anthropic wire shape: prompt
  // tokens land on input_tokens and completion tokens on output_tokens.
  assert.match(out, /"input_tokens":3/);
  assert.match(out, /"output_tokens":2/);
  assert.match(out, /event: message_stop/);
});

test("streaming forward: anthropic provider SSE passes through unchanged", async () => {
  const anthropicSse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","content":[]}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  const { fetchImpl, calls } = stubFetch([
    {
      prefix: "https://anthropic.example",
      respond: () =>
        new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(anthropicSse));
            controller.close();
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    },
  ]);

  const out = await collectStream(
    forwardLlmStreaming({
      owner: owner(),
      providers: [provider({ id: "anthropic", kind: "anthropic", baseUrl: "https://anthropic.example", models: { balanced: "claude-x" } })],
      body: { ...ANTHROPIC_REQ, stream: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://anthropic.example/v1/messages");
  // The committing provider is announced as a leading SSE comment.
  assert.equal(out, ": provider=anthropic\n\n" + anthropicSse);
});

test("streaming forward: anthropic provider usage passes through untouched", async () => {
  const anthropicSse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","content":[],"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  const { fetchImpl, calls } = stubFetch([
    {
      prefix: "https://anthropic.example",
      respond: () =>
        new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(anthropicSse));
            controller.close();
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    },
  ]);

  const out = await collectStream(
    forwardLlmStreaming({
      owner: owner(),
      providers: [provider({ id: "anthropic", kind: "anthropic", baseUrl: "https://anthropic.example", models: { balanced: "claude-x" } })],
      body: { ...ANTHROPIC_REQ, stream: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );

  assert.equal(calls.length, 1);
  // Anthropic wire usage (input_tokens + output_tokens) survives byte-for-byte.
  assert.match(out, /"input_tokens":7/);
  assert.match(out, /"output_tokens":3/);
});

test("streaming forward: mid-stream failure (OpenAI translation) records the failed attempt", async () => {
  const bus = memoryBus();
  // The upstream SSE stream dies after one chunk: the translator's mid-stream
  // catch must record the failure via recordFailure (an llm.call event with
  // errorKind network), not just fail the handle silently.
  const failing = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              id: "chatcmpl-s1",
              model: "mock-openai-model",
              choices: [{ index: 0, delta: { role: "assistant", content: "part" } }],
            })}\n\n`,
          ),
        );
        controller.error(new Error("upstream reset"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const { fetchImpl } = stubFetch([{ prefix: "https://flaky.example", respond: () => failing }]);

  const out = await collectStream(
    forwardLlmStreaming({
      owner: owner(),
      runId: "run-midstream-openai",
      bus: bus as unknown as TelemetryBus,
      providers: [provider({ id: "flaky", baseUrl: "https://flaky.example/v1" })],
      body: { ...ANTHROPIC_REQ, stream: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );

  // The client still gets an error event after the committed bytes...
  assert.match(out, /event: error/);
  // ...and the failed attempt is recorded in telemetry.
  const llmCalls = bus.events.filter((e) => e.event.type === "llm.call");
  assert.equal(llmCalls.length, 1);
  const d = (llmCalls[0].event as LlmCallEvent).data;
  assert.equal(d.provider, "flaky");
  assert.equal(d.attempt, 1);
  assert.equal(d.errorKind, "network");
});

test("streaming forward: mid-stream failure (Anthropic passthrough) records the failed attempt", async () => {
  const bus = memoryBus();
  const failing = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","content":[]}}\n\n',
          ),
        );
        controller.error(new Error("upstream reset"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const { fetchImpl } = stubFetch([{ prefix: "https://anthropic.example", respond: () => failing }]);

  const out = await collectStream(
    forwardLlmStreaming({
      owner: owner(),
      runId: "run-midstream-anthropic",
      bus: bus as unknown as TelemetryBus,
      providers: [
        provider({
          id: "anthropic",
          kind: "anthropic",
          baseUrl: "https://anthropic.example",
          models: { balanced: "claude-x" },
        }),
      ],
      body: { ...ANTHROPIC_REQ, stream: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );

  assert.match(out, /event: error/);
  const llmCalls = bus.events.filter((e) => e.event.type === "llm.call");
  assert.equal(llmCalls.length, 1);
  const d = (llmCalls[0].event as LlmCallEvent).data;
  assert.equal(d.provider, "anthropic");
  assert.equal(d.attempt, 1);
  assert.equal(d.errorKind, "network");
});

test("forwardLlmNonStreaming: strips image blocks when routed model lacks vision", async () => {
  const bus = memoryBus();
  let capturedBody: Record<string, unknown> | undefined;
  const { fetchImpl } = stubFetch([
    {
      prefix: "https://groq.example",
      respond: (init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "chatcmpl_1",
            model: "llama-3.3-70b-versatile",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  ]);

  const res = await forwardLlmNonStreaming({
    owner: owner(),
    runId: "run-nonvision-airlock",
    bus: bus as unknown as TelemetryBus,
    providers: [
      provider({
        id: "groq",
        kind: "openai",
        baseUrl: "https://groq.example",
        models: { balanced: "llama-3.3-70b-versatile" },
      }),
    ],
    body: {
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  assert.equal(res.attempts.length, 1);
  assert.equal(res.attempts[0]?.provider, "groq");
  const sentMessages = (capturedBody?.messages ?? []) as { role: string; content: unknown }[];
  assert.equal(typeof sentMessages[0].content, "string");
  assert.match(sentMessages[0].content as string, /\[image omitted: this model has no vision\]/);
});

test("forwardLlmNonStreaming: an unknown/future Claude on the Anthropic wire keeps its images", async () => {
  const bus = memoryBus();
  let capturedBody: Record<string, unknown> | undefined;
  const { fetchImpl } = stubFetch([
    {
      prefix: "https://anthropic.example",
      respond: (init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "text", text: "a cat" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  ]);

  await forwardLlmNonStreaming({
    owner: owner(),
    runId: "run-future-claude-vision",
    bus: bus as unknown as TelemetryBus,
    providers: [
      provider({
        id: "anthropic",
        kind: "anthropic",
        baseUrl: "https://anthropic.example",
        models: { balanced: "claude-opus-5" },
      }),
    ],
    body: {
      model: "claude-opus-5",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  const sent = (capturedBody?.messages ?? []) as { content: { type: string }[] }[];
  assert.ok(Array.isArray(sent[0]?.content), "content stays a block list");
  assert.equal(sent[0].content[1]?.type, "image", "the screenshot reaches the model");
});

test("failover onto the Anthropic wire drops unsigned (bridged) thinking blocks, keeps signed ones", async () => {
  const bus = memoryBus();
  let capturedBody: Record<string, unknown> | undefined;
  const { fetchImpl } = stubFetch([
    {
      prefix: "https://anthropic.example",
      respond: (init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "msg_2",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  ]);

  await forwardLlmNonStreaming({
    owner: owner(),
    runId: "run-thinking-failover",
    bus: bus as unknown as TelemetryBus,
    providers: [
      provider({ id: "anthropic", kind: "anthropic", baseUrl: "https://anthropic.example", models: { balanced: "claude-opus-5" } }),
    ],
    body: {
      model: "claude-opus-5",
      max_tokens: 128,
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: [
            // Synthesized by the bridge from DeepSeek reasoning_content: no signature.
            { type: "thinking", thinking: "run ls" },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.ts" }] },
      ],
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  const sent = (capturedBody?.messages ?? []) as { content: { type: string }[] | string }[];
  const assistant = sent[1].content as { type: string }[];
  assert.deepEqual(assistant.map((b) => b.type), ["tool_use"], "unsigned thinking never reaches Anthropic");
});

/** A fat tool result: 2,000 passing lines plus two failures and an exit code. */
function fatToolResult(): string {
  const out: string[] = [];
  for (let i = 0; i < 2000; i++) out.push(`✓ renders row ${i} correctly (3ms)`);
  out.push("FAIL src/components/DesktopView.test.tsx");
  out.push("  ● DesktopView › shows the live desktop");
  out.push("    Expected: live desktop visible");
  out.push("    Received: blank screen");
  out.push("      at Object.<anonymous> (src/components/DesktopView.test.tsx:42:15)");
  out.push("Tests:       1 failed, 1999 passed, 2000 total");
  out.push("error Command failed with exit code 1.");
  return out.join("\n");
}

test("turn compaction: a long multi-turn history is compacted before any provider sees it", async () => {
  const { fetchImpl, calls } = stubFetch([
    { prefix: "https://openai.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
  ]);
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: "make the desktop work" }];
  for (let turn = 1; turn <= 30; turn++) {
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `tu_${turn}`, content: fatToolResult() }],
    });
    messages.push({ role: "assistant", content: [{ type: "text", text: `turn ${turn} done` }] });
  }
  const body = { model: "claude-x", max_tokens: 64, messages };
  const snapshot = JSON.stringify(body);

  const result = await forwardLlmNonStreaming({
    owner: owner(),
    providers: [
      provider({
        id: "openai",
        baseUrl: "https://openai.example/v1",
        models: { balanced: "mock-openai-model" },
        keys: [mockKey()],
      }),
    ],
    body,
    requestedModel: "mock-openai-model",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(result.attempts.length, 1);
  assert.equal(calls.length, 1);

  // The caller's body is never mutated by compaction.
  assert.equal(JSON.stringify(body), snapshot);

  // The forwarded OpenAI body carries bounded tool content: the raw
  // history is ~30 x 60k chars of tool output, the forwarded one must be
  // far smaller, and the newest result's diagnostics must survive.
  const sent = JSON.parse(String(calls[0].init.body)) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const toolContents = sent.messages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  const totalChars = toolContents.reduce((sum, c) => sum + c.length, 0);
  assert.ok(totalChars < 200_000, `forwarded tool content ${totalChars} chars must be bounded`);
  assert.ok(toolContents.length > 0, "tool results still forwarded");
  const joined = toolContents.join("\n");
  assert.ok(joined.includes("exit code 1"), "newest result keeps its exit code in the forwarded body");
  assert.ok(
    joined.includes("src/components/DesktopView.test.tsx:42"),
    "newest result keeps its file:line in the forwarded body",
  );
});

test("turn compaction: a short history is forwarded byte-identical", async () => {
  const { fetchImpl, calls } = stubFetch([
    { prefix: "https://openai.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
  ]);
  const body = {
    model: "claude-x",
    max_tokens: 64,
    messages: [
      { role: "user", content: "ping" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ],
  };
  await forwardLlmNonStreaming({
    owner: owner(),
    providers: [
      provider({
        id: "openai",
        baseUrl: "https://openai.example/v1",
        models: { balanced: "mock-openai-model" },
        keys: [mockKey()],
      }),
    ],
    body,
    requestedModel: "mock-openai-model",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const sent = JSON.parse(String(calls[0].init.body)) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const toolMessage = sent.messages.find((m) => m.role === "tool");
  assert.equal(toolMessage?.content, "ok");
});

test("turn compaction: a large-context model gets ~60k tokens of tool output verbatim (cache-safe)", async () => {
  const { fetchImpl, calls } = stubFetch([
    { prefix: "https://openai.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
  ]);
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: "fix the failing tests" }];
  for (let turn = 1; turn <= 3; turn++) {
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${turn}`, content: fatToolResult() }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: `turn ${turn} done` }] });
  }
  await forwardLlmNonStreaming({
    owner: owner(),
    providers: [
      provider({ id: "openai", baseUrl: "https://openai.example/v1", models: { balanced: "gpt-4o" }, keys: [mockKey()] }),
    ],
    body: { model: "claude-x", max_tokens: 64, messages },
    requestedModel: "gpt-4o",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const sent = JSON.parse(String(calls[0].init.body)) as { messages: Array<{ role: string; content: unknown }> };
  const tool = sent.messages.filter((m) => m.role === "tool");
  assert.equal(tool.length, 3);
  for (const m of tool) assert.equal(m.content, fatToolResult(), "under the 80k budget results are forwarded verbatim");
});
