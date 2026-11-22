/**
 * FIX-06 regression tests for the provider Router (lib/providers/router.ts):
 * the per-attempt deadline is always set (option > env > 120s default),
 * covers the response body read, and streaming attempts get an idle-gap
 * deadline after first text instead of a total-duration cap.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Router, RouterError } from "./router";
import type { FetchLike, ProviderConfig, ProviderKind } from "./types";

function provider(
  id: string,
  kind: ProviderKind,
  keys: string[],
  rank: number,
  overrides: Partial<ProviderConfig> = {}
): ProviderConfig {
  return {
    id,
    kind,
    keys,
    rank,
    models: { fast: "test-fast", balanced: "test-balanced", deep: "test-deep" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openaiOk(text: string) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 5, completion_tokens: 6 },
    model: "test-balanced",
  };
}

const userMessage = { role: "user" as const, content: "hello" };

/** A fetch that never answers until its signal aborts (a hung provider). */
function hangingFetch(onCall?: (url: string) => void): FetchLike {
  return ((url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      onCall?.(url);
      const signal = init?.signal;
      if (!signal) return; // hangs forever
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as FetchLike;
}

test("complete: the default deadline is always set and fails over on timeout", async () => {
  const calls: string[] = [];
  const fetchMock: FetchLike = async (url, init) => {
    calls.push(url);
    if (url.includes("anthropic")) return hangingFetch()(url, init);
    return jsonResponse(openaiOk("fallback answer"));
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-a"], 0),
      provider("openai", "openai", ["sk-b"], 1),
    ],
    fetch: fetchMock,
    defaultTimeoutMs: 50,
  });

  const result = await router.complete({ messages: [userMessage], tier: "balanced" });
  assert.equal(result.provider, "openai");
  assert.equal(result.text, "fallback answer");
  assert.equal(calls.length, 2);
  const stats = router.stats();
  assert.equal(stats.providers[0].keys[0].failures, 1);
  assert.equal(stats.providers[1].keys[0].successes, 1);
});

test("complete: a body that stalls after headers times out (deadline covers the read)", async () => {
  const fetchMock: FetchLike = async (url, init) => {
    if (url.includes("anthropic")) {
      const signal = init?.signal;
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
            { once: true }
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return jsonResponse(openaiOk("fallback answer"));
  };

  const router = new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-a"], 0),
      provider("openai", "openai", ["sk-b"], 1),
    ],
    fetch: fetchMock,
    defaultTimeoutMs: 50,
  });

  const result = await router.complete({ messages: [userMessage], tier: "balanced" });
  assert.equal(result.provider, "openai");
  assert.equal(result.text, "fallback answer");
});

test("complete: a per-provider timeoutMs override beats the router default", async () => {
  // The provider answers after 80ms. The router default (30ms) would kill
  // it; the provider's own timeoutMs (500ms) must win.
  const fetchMock: FetchLike = async () =>
    new Promise<Response>((resolve) => {
      setTimeout(() => resolve(jsonResponse(openaiOk("slow answer"))), 80);
    });

  const router = new Router({
    providers: [provider("openai", "openai", ["sk-b"], 0, { timeoutMs: 500 })],
    fetch: fetchMock,
    defaultTimeoutMs: 30,
  });

  const result = await router.complete({ messages: [userMessage], tier: "balanced" });
  assert.equal(result.text, "slow answer");
});

test("complete: when every provider times out the error names the timeout", async () => {
  const router = new Router({
    providers: [provider("anthropic", "anthropic", ["sk-a"], 0)],
    fetch: hangingFetch(),
    defaultTimeoutMs: 50,
  });

  await assert.rejects(
    router.complete({ messages: [userMessage], tier: "balanced" }),
    (err: unknown) => {
      assert.ok(err instanceof RouterError);
      assert.match(err.message, /timed out/);
      return true;
    }
  );
});

/** OpenAI-shaped SSE frames for the streaming tests. */
function sseFrames(texts: string[]): string {
  const frames = texts.map((text) =>
    JSON.stringify({
      id: "chatcmpl-s",
      model: "test-balanced",
      choices: [{ index: 0, delta: { content: text } }],
    })
  );
  frames.push(
    JSON.stringify({
      id: "chatcmpl-s",
      model: "test-balanced",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    })
  );
  return frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n";
}

test("stream: an idle stall after first text fails the attempt with a timeout", async () => {
  const fetchMock: FetchLike = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              id: "chatcmpl-s",
              model: "test-balanced",
              choices: [{ index: 0, delta: { content: "hi" } }],
            })}\n\n`
          )
        );
        // ...then silence: the idle guard must fail the attempt.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const router = new Router({
    providers: [provider("openai", "openai", ["sk-b"], 0)],
    fetch: fetchMock,
    defaultTimeoutMs: 1_000,
    streamIdleTimeoutMs: 50,
  });

  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of router.stream({ messages: [userMessage], tier: "balanced" })) {
        if (event.type === "delta") seen.push(event.text);
      }
    })(),
    (err: unknown) => {
      assert.ok(err instanceof RouterError);
      assert.match(err.message, /stalled/);
      return true;
    }
  );
  assert.deepEqual(seen, ["hi"]);
});

test("stream: a long but flowing stream is not killed by total duration", async () => {
  // 8 frames, 30ms apart = ~240ms total, past the 50ms first-text
  // deadline — but every gap is under the 200ms idle deadline.
  const frames = sseFrames(["a", "b", "c", "d", "e", "f", "g", "h"]).split("\n\n").filter(Boolean);
  const fetchMock: FetchLike = async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame + "\n\n"));
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const router = new Router({
    providers: [provider("openai", "openai", ["sk-b"], 0)],
    fetch: fetchMock,
    defaultTimeoutMs: 50,
    streamIdleTimeoutMs: 200,
  });

  let doneText = "";
  for await (const event of router.stream({ messages: [userMessage], tier: "balanced" })) {
    if (event.type === "done") doneText = event.text;
  }
  assert.equal(doneText, "abcdefgh");
});
