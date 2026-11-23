import test from "node:test";
import assert from "node:assert/strict";

import { Router, RouterError } from "./router";
import type {
  FetchLike,
  FetchResponse,
  ModelTier,
  ProviderConfig,
  ProviderKind,
  StreamDone,
  StreamEvent,
} from "./types";

/**
 * All timers are mocked (same approach as router.timeout.test.ts): the
 * router arms its hedge/deadline/idle timers with `.unref()`, so a test
 * that awaits a promise settleable only by one of those timers can see
 * its event loop drain and be cancelled by the runner ("Promise
 * resolution is still pending but the event loop has already resolved").
 * The hedged `complete()` test is exactly that shape — the loser's fetch
 * never settles on its own and only the unref'd hedge timer starts the
 * winner. Driving the mocked clock deterministically removes the
 * real-timer race entirely — no wall-clock time passes in these tests.
 */

/**
 * Advance the mocked clock until `work` settles (or the fake-time budget
 * is spent). The router arms its timers asynchronously (after fetch +
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

/**
 * Advance fake time and flush microtasks so abort/cancel plumbing (abort
 * event → reader.cancel() → source cancel callback) has fully settled
 * before asserting on it. Replaces wall-clock sleeps.
 */
async function settleAfterAbort(
  timers: { tick: (ms: number) => void },
  ms = 200,
): Promise<void> {
  timers.tick(ms);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

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
      message: { model: "test-balanced", usage: { input_tokens: 3, output_tokens: 0 } },
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
      openaiFrame({ model: "test-balanced", choices: [{ index: 0, delta: { content: text } }] })
    ),
    openaiFrame({ model: "test-balanced", choices: [], usage: { prompt_tokens: 5, completion_tokens: 6 } }),
    "data: [DONE]\n\n",
  ];
}

function jsonResponse(
  body: unknown,
  init: { status?: number } = {}
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

const userMessage = { role: "user" as const, content: "hello" };

function collect(events: StreamEvent[]): StreamDone {
  const last = events[events.length - 1];
  assert.equal(last?.type, "done");
  return last as StreamDone;
}

function hedgeRouter(
  fetchMock: FetchLike,
  extra: {
    hedgeDelayMs?: number;
    raceTiers?: ModelTier[];
    env?: Record<string, string | undefined>;
  } = {}
) {
  return new Router({
    providers: [
      provider("anthropic", "anthropic", ["sk-ant-hedge"], 0),
      provider("openai", "openai", ["sk-oai-hedge"], 1),
    ],
    fetch: fetchMock,
    ...extra,
  });
}

test("hedged: primary wins before the hedge delay and the hedger never starts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const primary = makeStream(anthropicStream(["pri"]));
    let openaiCalls = 0;

    const router = hedgeRouter(async (url) => {
      if (url.includes("anthropic")) return primary.response;
      openaiCalls += 1;
      throw new Error("hedger must not start when the primary wins first");
    });

    const run = (async () => {
      const events: StreamEvent[] = [];
      for await (const event of router.stream({
        messages: [userMessage],
        tier: "balanced",
        hedge: true,
      })) {
        events.push(event);
      }
      return events;
    })();
    await driveClock(t.mock.timers, run);
    const events = await run;

    const done = collect(events);
    assert.equal(done.provider, "anthropic");
    assert.equal(done.text, "pri");
    assert.equal(openaiCalls, 0, "hedge was cancelled once the primary produced a token");
    assert.equal(done.attempts.length, 1);
    assert.equal(done.attempts[0].provider, "anthropic");
    assert.equal(done.attempts[0].ok, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("hedged: hedge wins after the delay and the slow primary is aborted", async (t) => {
  // Date is mocked too so the fetchedAt gaps below measure fake time.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    // Primary produces its first token only after 80ms; hedge fires at 30ms.
    const slowPrimary = makeStream([
      { text: anthropicStream(["slow"])[0], delayMs: 80 },
    ]);
    const fastHedger = makeStream(openaiStream(["fast", " answer"]));
    const fetchedAt: number[] = [];
    const start = Date.now();

    const router = hedgeRouter(async (url) => {
      fetchedAt.push(Date.now() - start);
      if (url.includes("anthropic")) return slowPrimary.response;
      return fastHedger.response;
    });

    const run = (async () => {
      const events: StreamEvent[] = [];
      for await (const event of router.stream({
        messages: [userMessage],
        tier: "balanced",
        hedge: 30,
      })) {
        events.push(event);
      }
      return events;
    })();
    await driveClock(t.mock.timers, run);
    const events = await run;

    const done = collect(events);
    assert.equal(done.provider, "openai");
    assert.equal(done.text, "fast answer");

    assert.ok(fetchedAt.length >= 2, "the hedger was started");
    assert.ok(
      fetchedAt[1] - fetchedAt[0] >= 15,
      `hedger started after the hedge delay (gap ${fetchedAt[1] - fetchedAt[0]}ms)`
    );
    assert.ok(fetchedAt[1] < 1200, "hedge delay was not the 1500ms default");

    await settleAfterAbort(t.mock.timers);
    assert.equal(slowPrimary.cancelled(), true, "losing primary stream is cancelled");

    const loserKey = router.stats().providers[0].keys[0];
    assert.equal(loserKey.failures, 0, "cancelled racers are not key failures");
    assert.equal(loserKey.available, true);

    const winnerKey = router.stats().providers[1].keys[0];
    assert.equal(winnerKey.successes, 1);
    assert.equal(done.attempts.filter((a) => a.ok).length, 1);
    assert.equal(done.attempts[0].provider, "openai");
  } finally {
    t.mock.timers.reset();
  }
});

test("hedged: the primary can still win after the hedger started, aborting it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // The primary's first token arrives at ~60ms; the hedger starts at ~30ms
    // but its first token only arrives at ~140ms, so the primary wins and the
    // already-started hedger is aborted.
    const primary = makeStream([
      anthropicStream(["pri"])[0],
      { text: anthropicStream(["pri"])[1], delayMs: 60 },
    ]);
    const slowHedger = makeStream([
      { text: openaiStream(["hed"])[0], delayMs: 140 },
    ]);
    let hedgerStarted = false;

    const router = hedgeRouter(async (url) => {
      if (url.includes("anthropic")) return primary.response;
      hedgerStarted = true;
      return slowHedger.response;
    });

    const run = (async () => {
      const events: StreamEvent[] = [];
      for await (const event of router.stream({
        messages: [userMessage],
        tier: "balanced",
        hedge: 30,
      })) {
        events.push(event);
      }
      return events;
    })();
    await driveClock(t.mock.timers, run);
    const events = await run;

    assert.equal(hedgerStarted, true, "hedger started because the primary was late");
    const done = collect(events);
    assert.equal(done.provider, "anthropic");
    assert.equal(done.text, "pri");

    await settleAfterAbort(t.mock.timers);
    assert.equal(slowHedger.cancelled(), true, "losing hedger stream is cancelled");

    const hedgerKey = router.stats().providers[1].keys[0];
    assert.equal(hedgerKey.failures, 0);
    assert.equal(hedgerKey.available, true);
  } finally {
    t.mock.timers.reset();
  }
});

test("hedged: both racers fail and the error aggregates both attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let anthropicCalls = 0;
    let openaiCalls = 0;

    const router = hedgeRouter(async (url) => {
      if (url.includes("anthropic")) {
        anthropicCalls += 1;
        return jsonResponse({ error: { message: "anthropic down" } }, { status: 500 });
      }
      openaiCalls += 1;
      return jsonResponse({ error: { message: "openai down" } }, { status: 500 });
    });

    const run = (async () => {
      const events: StreamEvent[] = [];
      for await (const event of router.stream({
        messages: [userMessage],
        tier: "balanced",
        hedge: 30,
      })) {
        events.push(event);
      }
      return events;
    })();
    await driveClock(t.mock.timers, run);

    let caught: unknown;
    try {
      await run;
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof RouterError);
    const error = caught as RouterError;
    assert.equal(error.code, "all_failed");
    assert.equal(error.attempts.length, 2);
    for (const attempt of error.attempts) {
      assert.equal(attempt.ok, false);
      assert.equal(attempt.status, 500);
    }
    assert.equal(anthropicCalls, 1);
    assert.equal(openaiCalls, 1);

    const stats = router.stats();
    assert.equal(stats.failed, 1);
    for (const providerStats of stats.providers) {
      assert.equal(providerStats.keys[0].failures, 1);
      assert.equal(providerStats.keys[0].available, false, "failed racers cool down");
      assert.ok((providerStats.keys[0].cooldownUntil ?? 0) > 0);
    }
  } finally {
    t.mock.timers.reset();
  }
});

test("hedged: budgets are charged only to the winner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const slowPrimary = makeStream([{ text: anthropicStream(["slow"])[0], delayMs: 80 }]);
    const fastHedger = makeStream(openaiStream(["fast"]));

    const router = new Router({
      providers: [
        {
          ...provider("anthropic", "anthropic", ["sk-ant-budget"], 0),
          dailyBudgetUsd: 10,
          inputPricePer1mTokens: 5,
          outputPricePer1mTokens: 5,
        },
        {
          ...provider("openai", "openai", ["sk-oai-budget"], 1),
          dailyBudgetUsd: 10,
          inputPricePer1mTokens: 2,
          outputPricePer1mTokens: 2,
        },
      ],
      fetch: async (url) => {
        if (url.includes("anthropic")) return slowPrimary.response;
        return fastHedger.response;
      },
    });

    const run = (async () => {
      const events: StreamEvent[] = [];
      for await (const event of router.stream({
        messages: [userMessage],
        tier: "balanced",
        hedge: 30,
      })) {
        events.push(event);
      }
      return events;
    })();
    await driveClock(t.mock.timers, run);
    const events = await run;
    const done = collect(events);
    assert.equal(done.provider, "openai");

    const budgets = router.budgetStats();
    const anthropic = budgets.find((b) => b.id === "anthropic")!;
    const openai = budgets.find((b) => b.id === "openai")!;
    assert.equal(anthropic.spentTodayUsd, 0, "aborted primary is not charged");
    assert.ok(openai.spentTodayUsd > 0, "winner is charged");
  } finally {
    t.mock.timers.reset();
  }
});

test("hedged: complete() races the same way and aborts the loser", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let loserAborted = false;

    const router = hedgeRouter((url, init) => {
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
      return Promise.resolve(jsonResponse({
        choices: [{ message: { content: "hedge winner" } }],
        usage: { prompt_tokens: 5, completion_tokens: 6 },
        model: "test-balanced",
      }));
    });

    const promise = router.complete({
      messages: [userMessage],
      tier: "balanced",
      hedge: 30,
    });
    await driveClock(t.mock.timers, promise);
    const result = await promise;

    assert.equal(result.provider, "openai");
    assert.equal(result.text, "hedge winner");
    assert.equal(loserAborted, true);

    const loserKey = router.stats().providers[0].keys[0];
    assert.equal(loserKey.failures, 0, "cancelled racers are not key failures");
    assert.equal(loserKey.available, true);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].provider, "openai");
  } finally {
    t.mock.timers.reset();
  }
});

test("hedged: the hedge delay comes from env or options, and per-call overrides win", () => {
  const envRouter = new Router({
    providers: [provider("anthropic", "anthropic", ["sk-ant-env"], 0)],
    env: { SWARM_HEDGE_DELAY_MS: "25" },
    fetch: async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }),
  });
  assert.equal(
    (envRouter as unknown as { hedgeDelayMs: number }).hedgeDelayMs,
    25,
    "SWARM_HEDGE_DELAY_MS is honoured"
  );

  const optionRouter = new Router({
    providers: [provider("anthropic", "anthropic", ["sk-ant-opt"], 0)],
    env: { SWARM_HEDGE_DELAY_MS: "25" },
    hedgeDelayMs: 10,
    fetch: async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }),
  });
  assert.equal(
    (optionRouter as unknown as { hedgeDelayMs: number }).hedgeDelayMs,
    10,
    "explicit option beats env"
  );

  const defaultRouter = new Router({
    providers: [provider("anthropic", "anthropic", ["sk-ant-def"], 0)],
    env: { SWARM_HEDGE_DELAY_MS: "not-a-number" },
    fetch: async () => jsonResponse({ content: [{ type: "text", text: "ok" }] }),
  });
  assert.equal(
    (defaultRouter as unknown as { hedgeDelayMs: number }).hedgeDelayMs,
    1500,
    "invalid env falls back to 1500ms"
  );

  const reflect = defaultRouter as unknown as {
    resolveRace(request: { hedge?: boolean | number; race?: number; tier?: string }, count: number): {
      race: number;
      mode: string | undefined;
      hedge: number;
    };
  };
  const resolveRace = reflect.resolveRace.bind(reflect);

  const plain = resolveRace({}, 3);
  assert.equal(plain.race, 1, "no opt-in means sequential failover");
  assert.equal(plain.mode, undefined);

  const hedged = resolveRace({ hedge: true }, 3);
  assert.equal(hedged.mode, "hedged");
  assert.equal(hedged.race, 2);
  assert.equal(hedged.hedge, 1500);

  const overridden = resolveRace({ hedge: 5 }, 3);
  assert.equal(overridden.hedge, 5, "per-call numeric hedge overrides the default");

  const simultaneous = resolveRace({ race: 2 }, 3);
  assert.equal(simultaneous.mode, undefined, "plain race stays simultaneous");
  assert.equal(simultaneous.race, 2);
});

test("hedged: race mode can be opted in per tier", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Primary's first token arrives at ~60ms; the hedge delay is 30ms.
    const anthropicStreams: MockStream[] = [];
    let anthropicCalls = 0;
    let openaiCalls = 0;

    const router = new Router({
      providers: [
        provider("anthropic", "anthropic", ["sk-ant-tier"], 0),
        provider("openai", "openai", ["sk-oai-tier"], 1),
      ],
      raceTiers: ["balanced"],
      hedgeDelayMs: 30,
      fetch: async (url) => {
        if (url.includes("anthropic")) {
          anthropicCalls += 1;
          const stream = makeStream([
            anthropicStream(["slow"])[0],
            { text: anthropicStream(["slow"])[1], delayMs: 60 },
          ]);
          anthropicStreams.push(stream);
          return stream.response;
        }
        openaiCalls += 1;
        return makeStream(openaiStream(["fast"])).response;
      },
    });

    // "fast" is not in raceTiers: sequential failover, no hedger.
    const runFast = (async () => {
      const eventsFast: StreamEvent[] = [];
      for await (const event of router.stream({
        messages: [userMessage],
        tier: "fast",
      })) {
        eventsFast.push(event);
      }
      return eventsFast;
    })();
    await driveClock(t.mock.timers, runFast);
    const eventsFast = await runFast;
    assert.equal(collect(eventsFast).provider, "anthropic");
    assert.equal(anthropicCalls, 1);
    assert.equal(openaiCalls, 0, "non-raced tiers stay sequential");

    // "balanced" opts in: the hedger starts because the primary is late.
    const runBalanced = (async () => {
      const eventsBalanced: StreamEvent[] = [];
      for await (const event of router.stream({
        messages: [userMessage],
        tier: "balanced",
      })) {
        eventsBalanced.push(event);
      }
      return eventsBalanced;
    })();
    await driveClock(t.mock.timers, runBalanced);
    const eventsBalanced = await runBalanced;
    assert.equal(collect(eventsBalanced).provider, "openai");
    assert.equal(anthropicCalls, 2);
    assert.equal(openaiCalls, 1);

    await settleAfterAbort(t.mock.timers);
    assert.equal(anthropicStreams[1].cancelled(), true, "racy primary was aborted");
  } finally {
    t.mock.timers.reset();
  }
});
