/**
 * FIX-06 regression tests for the LLM gateway (lib/runtime/llm-gateway.ts):
 * per-attempt upstream deadlines. A hung provider must become a
 * failover-eligible "timeout" attempt — never a hung turn. Streaming is
 * bounded by time-to-first-byte and inter-chunk idle gaps, not by total
 * duration. All upstream calls use a stubbed fetch — no network.
 *
 * All timers are mocked: the gateway arms its attempt/stream deadlines
 * with `.unref()`, so a test that awaits a promise settleable only by one
 * of those timers can see its event loop drain and be cancelled by the
 * runner ("Promise resolution is still pending but the event loop has
 * already resolved"). Driving the mocked clock deterministically removes
 * the real-timer race entirely — no wall-clock time passes in these tests.
 */

import test from "node:test";
import assert from "node:assert/strict";

// The production watchdogs are intentionally unref'ed so they do not keep a
// server alive on their own. Keep the test process alive while each test is
// awaiting one; otherwise node:test cancels the pending promise on idle.
let keepAlive: ReturnType<typeof setInterval>;
test.beforeEach(() => { keepAlive = setInterval(() => {}, 60_000); });
test.afterEach(() => clearInterval(keepAlive));

import { forwardLlmNonStreaming, forwardLlmStreaming } from "./llm-gateway";
import type { ProviderConfig } from "../providers/types";
import { configureProviderStorePaths } from "../providers/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Advance the mocked clock until `work` settles (or the fake-time budget
 * is spent). The gateway arms its timers asynchronously (after fetch +
 * body parsing), so a single tick is not enough: step the clock and flush
 * microtasks between steps so newly-armed timers are picked up. Throws
 * instead of hanging when the work never settles.
 */
async function driveClock(
  timers: { tick: (ms: number) => void },
  work: Promise<unknown>,
  budgetMs = 1000,
): Promise<void> {
  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let elapsed = 0; elapsed < budgetMs && !settled; elapsed += 10) {
    timers.tick(10);
    await Promise.resolve();
  }
  if (!settled) throw new Error(`driveClock: work did not settle within ${budgetMs}ms of mocked time`);
}

// Unique owner per test: cooldown state is persisted per owner.
let ownerSeq = 0;
function owner(): string {
  return `user-gateway-timeout-${++ownerSeq}`;
}

let tempDir = "";
test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "swarm-gateway-timeout-"));
  configureProviderStorePaths(join(tempDir, "providers.json"));
});

test.afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

let keySeq = 0;
function mockKey(): string {
  return `sk-mock-timeout-${++keySeq}`;
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

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectStream(stream: AsyncGenerator<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

/** A fetch that never answers until its signal aborts (a hung provider). */
function hangingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // hangs forever
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
}

/**
 * A 200 response whose body never produces a byte. Like real fetch, the
 * body errors when the request signal aborts.
 */
function stalledBodyResponse(signal: AbortSignal | undefined): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => {
          try {
            controller.error(new Error("aborted"));
          } catch {
            /* already closed */
          }
        },
        { once: true },
      );
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Route by URL prefix like the main gateway suite's stubFetch. */
function stubFetch(
  routes: Array<{
    prefix: string;
    respond: (init: RequestInit, url: string) => Response | Promise<Response>;
  }>,
) {
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

test("non-streaming: a hung provider times out and fails over", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { fetchImpl, calls } = stubFetch([
      { prefix: "https://hung.example", respond: (init) => hangingFetch()("", init) },
      { prefix: "https://good.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
    ]);

    const promise = forwardLlmNonStreaming({
      owner: owner(),
      providers: [
        provider({ id: "hung", baseUrl: "https://hung.example/v1", rank: 0 }),
        provider({ id: "good", baseUrl: "https://good.example/v1", rank: 1 }),
      ],
      body: ANTHROPIC_REQ,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await driveClock(t.mock.timers, promise);
    const result = await promise;

    assert.equal(calls.length, 2);
    assert.equal(result.attempts[0].provider, "hung");
    assert.equal(result.attempts[0].kind, "timeout");
    assert.equal(result.attempts[1].provider, "good");
    assert.equal(result.attempts[1].ok, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("non-streaming: a body that stalls after headers times out and fails over", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { fetchImpl } = stubFetch([
      {
        prefix: "https://stalled.example",
        respond: (init) => stalledBodyResponse(init.signal ?? undefined),
      },
      { prefix: "https://good.example", respond: () => jsonResponse(OPENAI_RESPONSE) },
    ]);

    const promise = forwardLlmNonStreaming({
      owner: owner(),
      providers: [
        provider({ id: "stalled", baseUrl: "https://stalled.example/v1", rank: 0 }),
        provider({ id: "good", baseUrl: "https://good.example/v1", rank: 1 }),
      ],
      body: ANTHROPIC_REQ,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await driveClock(t.mock.timers, promise);
    const result = await promise;

    assert.equal(result.attempts[0].provider, "stalled");
    assert.equal(result.attempts[0].kind, "timeout");
    assert.equal(result.attempts[1].provider, "good");
    assert.equal(result.attempts[1].ok, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("non-streaming: a per-provider timeoutMs override beats the caller default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // The provider answers after 80ms. The caller default (30ms) would kill
    // it; the provider's own timeoutMs (500ms) must win.
    const { fetchImpl } = stubFetch([
      {
        prefix: "https://slow.example",
        respond: () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(jsonResponse(OPENAI_RESPONSE)), 80);
          }),
      },
    ]);

    const promise = forwardLlmNonStreaming({
      owner: owner(),
      providers: [
        provider({ id: "slow", baseUrl: "https://slow.example/v1", rank: 0, timeoutMs: 500 }),
      ],
      body: ANTHROPIC_REQ,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 30,
    });
    await driveClock(t.mock.timers, promise);
    const result = await promise;

    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].ok, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("streaming: first-byte timeout fails over before any byte is committed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const goodSse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","content":[]}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const { fetchImpl, calls } = stubFetch([
      {
        prefix: "https://hung.example",
        respond: (init) => sseResponse(stalledBodyResponse(init.signal ?? undefined).body!),
      },
      {
        prefix: "https://good.example",
        respond: () =>
          sseResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(goodSse));
                controller.close();
              },
            }),
          ),
      },
    ]);

    const promise = collectStream(
      forwardLlmStreaming({
        owner: owner(),
        providers: [
          provider({
            id: "hung",
            kind: "anthropic",
            baseUrl: "https://hung.example",
            models: { balanced: "claude-x" },
            rank: 0,
          }),
          provider({
            id: "good",
            kind: "anthropic",
            baseUrl: "https://good.example",
            models: { balanced: "claude-x" },
            rank: 1,
          }),
        ],
        body: { ...ANTHROPIC_REQ, stream: true },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 50,
        streamIdleTimeoutMs: 50,
      }),
    );
    await driveClock(t.mock.timers, promise);
    const out = await promise;

    assert.equal(calls.length, 2);
    // Nothing from the hung provider was committed; the good one served.
    assert.equal(out, ": provider=good\n\n" + goodSse);
  } finally {
    t.mock.timers.reset();
  }
});

test("streaming: an idle stall after the first byte ends with an error event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const firstChunk =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","content":[]}}\n\n';
    const { fetchImpl } = stubFetch([
      {
        prefix: "https://stalling.example",
        respond: () =>
          sseResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(firstChunk));
                // ...then silence: the idle guard must end the stream.
              },
            }),
          ),
      },
    ]);

    const promise = collectStream(
      forwardLlmStreaming({
        owner: owner(),
        providers: [
          provider({
            id: "stalling",
            kind: "anthropic",
            baseUrl: "https://stalling.example",
            models: { balanced: "claude-x" },
          }),
        ],
        body: { ...ANTHROPIC_REQ, stream: true },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
        streamIdleTimeoutMs: 50,
      }),
    );
    await driveClock(t.mock.timers, promise);
    const out = await promise;

    assert.ok(out.startsWith(": provider=stalling\n\n" + firstChunk));
    assert.match(out, /event: error/);
    assert.match(out, /stalled for 50ms/);
  } finally {
    t.mock.timers.reset();
  }
});

test("streaming: a long but flowing stream is not killed by total duration", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // 10 chunks, 30ms apart = ~300ms total, well past the 50ms first-byte
    // deadline — but every gap is under the 200ms idle deadline.
    const chunks = Array.from(
      { length: 10 },
      (_, i) =>
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"c${i}"}}\n\n`,
    );
    const { fetchImpl } = stubFetch([
      {
        prefix: "https://flowing.example",
        respond: () =>
          sseResponse(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                const encoder = new TextEncoder();
                for (const chunk of chunks) {
                  controller.enqueue(encoder.encode(chunk));
                  await new Promise((resolve) => setTimeout(resolve, 30));
                }
                controller.close();
              },
            }),
          ),
      },
    ]);

    const promise = collectStream(
      forwardLlmStreaming({
        owner: owner(),
        providers: [
          provider({
            id: "flowing",
            kind: "anthropic",
            baseUrl: "https://flowing.example",
            models: { balanced: "claude-x" },
          }),
        ],
        body: { ...ANTHROPIC_REQ, stream: true },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 50,
        streamIdleTimeoutMs: 200,
      }),
    );
    await driveClock(t.mock.timers, promise);
    const out = await promise;

    assert.equal(out, ": provider=flowing\n\n" + chunks.join(""));
  } finally {
    t.mock.timers.reset();
  }
});
