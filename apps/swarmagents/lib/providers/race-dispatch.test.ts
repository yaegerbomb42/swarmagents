/**
 * Tests for the provider race dispatch (lib/providers/race-dispatch.ts):
 * cross-provider racing over the race engine, eligibility gating, loser
 * cancellation, telemetry/budget accounting, and the settings plumbing.
 *
 * Fakes follow race.test.ts: real KeyPools behind a fake RaceRouter, and a
 * fetch that answers per API key (read from the Authorization header) and
 * honours aborts. Fake keys only ever live in this file.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KeyPool } from "./key-pool";
import type { RaceRouter } from "./race";
import {
  extractRacePrompt,
  raceCompletion,
  raceConfigFromSettings,
  raceMaxTokens,
  type RaceCallEventData,
  type RaceCandidate,
} from "./race-dispatch";
import { parseUserSettings, type UserSettings } from "./settings";
import type { FetchLike, FetchResponse, ProviderConfig } from "./types";

const GROQ_KEYS = ["gsk_fake_groq_1", "gsk_fake_groq_2"];
const OR_KEYS = ["sk-or-fake-1", "sk-or-fake-2"];

const GROQ: ProviderConfig = {
  id: "groq",
  kind: "openai",
  baseUrl: "https://api.groq.com/openai/v1",
  models: { balanced: "llama-3.3-70b-versatile" },
  keys: [...GROQ_KEYS],
  isFree: true,
  rank: 1,
};

const OPENROUTER: ProviderConfig = {
  id: "openrouter",
  kind: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
  models: { balanced: "meta-llama/llama-3.3-70b-instruct" },
  keys: [...OR_KEYS],
  rank: 2,
  inputPricePer1mTokens: 1,
  outputPricePer1mTokens: 2,
};

const CANDIDATES: RaceCandidate[] = [
  { config: GROQ, model: "llama-3.3-70b-versatile" },
  { config: OPENROUTER, model: "meta-llama/llama-3.3-70b-instruct" },
];

function makeRouter(): RaceRouter {
  const pools = new Map<string, KeyPool>([
    ["groq", new KeyPool("groq", GROQ_KEYS)],
    ["openrouter", new KeyPool("openrouter", OR_KEYS)],
  ]);
  return {
    keyPool: (id) => pools.get(id),
    providerConfigs: () => [GROQ, OPENROUTER],
  };
}

interface FakeBehavior {
  delayMs: number;
  status: number;
  body: string;
}

function completionBody(text: string, outputTokens = 10): string {
  return JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { completion_tokens: outputTokens, total_tokens: outputTokens + 5 },
  });
}

/** A fetch that answers per key and honours aborts (records aborted keys). */
function makeFetch(
  behaviors: Map<string, FakeBehavior>,
  abortedKeys: string[] = [],
): FetchLike {
  return (async (url, init) => {
    void url;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const authKey = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
    const auth = authKey ? headers[authKey]! : "";
    const key = auth.replace(/^Bearer\s+/i, "");
    const behavior = behaviors.get(key);
    if (!behavior) throw new Error(`fake fetch: no behavior for key ${key.slice(0, 6)}`);

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(resolvePromise, behavior.delayMs);
      const signal = init.signal;
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          abortedKeys.push(key);
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          rejectPromise(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    const response: FetchResponse = {
      ok: behavior.status >= 200 && behavior.status < 300,
      status: behavior.status,
      headers: { get: () => null },
      text: async () => behavior.body,
    };
    return response;
  }) as FetchLike;
}

function behaviorMap(entries: [string, FakeBehavior][]): Map<string, FakeBehavior> {
  return new Map(entries);
}

const BASE = {
  owner: "local_tester@example.com",
  prompt: "Say hello.",
  candidates: CANDIDATES,
  config: { maxParallel: 2, keysPerProvider: 1 },
  routerFactory: () => makeRouter(),
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("raceConfigFromSettings: absent or disabled race is off", () => {
  assert.equal(raceConfigFromSettings({ preferFreeProviders: true }), null);
  assert.equal(
    raceConfigFromSettings({ preferFreeProviders: true, race: { enabled: false } }),
    null,
  );
});

test("raceConfigFromSettings: enabled applies defaults and clamps", () => {
  assert.deepEqual(
    raceConfigFromSettings({ preferFreeProviders: true, race: { enabled: true } }),
    { maxParallel: 3, keysPerProvider: 2 },
  );
  assert.deepEqual(
    raceConfigFromSettings({
      preferFreeProviders: true,
      race: { enabled: true, maxParallel: 99, keysPerProvider: 0 },
    }),
    { maxParallel: 3, keysPerProvider: 2 },
  );
  assert.deepEqual(
    raceConfigFromSettings({
      preferFreeProviders: true,
      race: { enabled: true, maxParallel: 4, keysPerProvider: 3 },
    }),
    { maxParallel: 4, keysPerProvider: 3 },
  );
});

test("parseUserSettings round-trips a valid race object and drops malformed ones", () => {
  const parsed = parseUserSettings({ race: { enabled: true, maxParallel: 5, keysPerProvider: 2 } });
  assert.deepEqual(parsed.race, { enabled: true, maxParallel: 5, keysPerProvider: 2 });
  assert.equal(parseUserSettings({ race: { enabled: "yes" } }).race, undefined);
  assert.equal(parseUserSettings({ race: "on" }).race, undefined);
  const settings: UserSettings = parseUserSettings({ race: { enabled: true, maxParallel: 99 } });
  assert.deepEqual(settings.race, { enabled: true });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("extractRacePrompt: single user message is raced verbatim", () => {
  assert.equal(
    extractRacePrompt({ messages: [{ role: "user", content: "Hello" }] }),
    "Hello",
  );
  assert.equal(
    extractRacePrompt({
      messages: [{ role: "user", content: [{ type: "text", text: "Hi " }, { type: "text", text: "there" }] }],
    }),
    "Hi there",
  );
});

test("extractRacePrompt: system string is prepended; multi-turn is flattened", () => {
  assert.equal(
    extractRacePrompt({ system: "Be terse.", messages: [{ role: "user", content: "Hi" }] }),
    "Be terse.\n\nHi",
  );
  assert.equal(
    extractRacePrompt({
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "Answer" },
        { role: "user", content: "Second" },
      ],
    }),
    "user: First\n\nassistant: Answer\n\nuser: Second",
  );
});

test("extractRacePrompt: tools, streaming, and non-text content are ineligible", () => {
  assert.equal(
    extractRacePrompt({ tools: [{ name: "x" }], messages: [{ role: "user", content: "Hi" }] }),
    null,
  );
  assert.equal(
    extractRacePrompt({ stream: true, messages: [{ role: "user", content: "Hi" }] }),
    null,
  );
  assert.equal(
    extractRacePrompt({
      messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
    }),
    null,
  );
  assert.equal(extractRacePrompt({ messages: [] }), null);
  assert.equal(extractRacePrompt(null), null);
  assert.equal(raceMaxTokens({ max_tokens: 512 }), 512);
  assert.equal(raceMaxTokens({ max_tokens: -1 }), undefined);
});

// ---------------------------------------------------------------------------
// Racing
// ---------------------------------------------------------------------------

test("race picks the fastest valid response across providers", async () => {
  const fetch = makeFetch(behaviorMap([
    [GROQ_KEYS[0]!, { delayMs: 60, status: 200, body: completionBody("slow groq") }],
    [OR_KEYS[0]!, { delayMs: 5, status: 200, body: completionBody("fast openrouter") }],
  ]));
  const result = await raceCompletion({ ...BASE, fetch });
  assert.equal(result.winner.provider, "openrouter");
  assert.equal(result.winner.text, "fast openrouter");
  const body = result.body as { content: { type: string; text: string }[] };
  assert.equal(body.content[0]!.text, "fast openrouter");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[1]!.ok, true);
});

test("losers are aborted once a winner lands", async () => {
  const abortedKeys: string[] = [];
  const fetch = makeFetch(behaviorMap([
    [GROQ_KEYS[0]!, { delayMs: 500, status: 200, body: completionBody("too slow") }],
    [OR_KEYS[0]!, { delayMs: 5, status: 200, body: completionBody("winner") }],
  ]), abortedKeys);
  const result = await raceCompletion({ ...BASE, fetch });
  assert.equal(result.winner.provider, "openrouter");
  assert.ok(abortedKeys.includes(GROQ_KEYS[0]!), "the slow provider's fetch must be aborted");
  assert.equal(result.attempts[0]!.ok, false);
  assert.equal(result.attempts[0]!.kind, "aborted");
});

test("a fast garbage response does not win; the race waits for a valid one", async () => {
  const fetch = makeFetch(behaviorMap([
    [GROQ_KEYS[0]!, { delayMs: 1, status: 200, body: completionBody("-Re-Re-Re-P-P-P soup") }],
    [OR_KEYS[0]!, { delayMs: 20, status: 200, body: completionBody("real answer") }],
  ]));
  const result = await raceCompletion({ ...BASE, fetch });
  assert.equal(result.winner.provider, "openrouter");
  assert.equal(result.winner.text, "real answer");
});

test("all providers failing rejects so the gateway can fall back", async () => {
  const fetch = makeFetch(behaviorMap([
    [GROQ_KEYS[0]!, { delayMs: 1, status: 500, body: "boom" }],
    [OR_KEYS[0]!, { delayMs: 1, status: 429, body: "slow down" }],
  ]));
  await assert.rejects(raceCompletion({ ...BASE, fetch }), /all 2 provider\(s\) failed/);
});

test("budget accounting: winner spend is noted and every attempt is telemetered", async () => {
  const events: RaceCallEventData[] = [];
  const spends: number[] = [];
  const fetch = makeFetch(behaviorMap([
    [GROQ_KEYS[0]!, { delayMs: 50, status: 200, body: completionBody("slow free") }],
    [OR_KEYS[0]!, { delayMs: 5, status: 200, body: completionBody("fast paid", 100) }],
  ]));
  const result = await raceCompletion({
    ...BASE,
    fetch,
    inputTokens: 1_000_000,
    emit: (data) => events.push(data),
    noteSpend: (usd) => spends.push(usd),
  });
  assert.equal(result.winner.provider, "openrouter");
  // 1M input @ $1 + 100 output @ $2/1M = $1.0002.
  assert.equal(spends.length, 1);
  assert.ok(Math.abs(spends[0]! - 1.0002) < 1e-9, `spend ${spends[0]}`);
  assert.equal(events.length, 2);
  const winnerEvent = events.find((e) => e.outcome === "ok")!;
  assert.equal(winnerEvent.provider, "openrouter");
  assert.equal(winnerEvent.outputTokens, 100);
  assert.ok(winnerEvent.costUsd !== null && winnerEvent.costUsd > 0);
  const loserEvent = events.find((e) => e.outcome === "aborted")!;
  assert.equal(loserEvent.provider, "groq");
  assert.equal(loserEvent.costUsd, null);
});

test("allowPaid false excludes paid providers from the race", async () => {
  const fetch = makeFetch(behaviorMap([
    [GROQ_KEYS[0]!, { delayMs: 5, status: 200, body: completionBody("free answer") }],
    [OR_KEYS[0]!, { delayMs: 1, status: 200, body: completionBody("paid answer") }],
  ]));
  const result = await raceCompletion({ ...BASE, fetch, allowPaid: false });
  assert.equal(result.winner.provider, "groq");
  assert.equal(result.attempts.length, 1);
});

test("an outer abort propagates instead of falling back", async () => {
  const controller = new AbortController();
  const fetch = makeFetch(behaviorMap([
    [GROQ_KEYS[0]!, { delayMs: 500, status: 200, body: completionBody("slow") }],
    [OR_KEYS[0]!, { delayMs: 500, status: 200, body: completionBody("slow") }],
  ]));
  const pending = raceCompletion({ ...BASE, fetch, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /abort/i);
});

test("no eligible providers rejects", async () => {
  await assert.rejects(
    raceCompletion({ ...BASE, candidates: [], fetch: makeFetch(new Map()) }),
    /no eligible providers/,
  );
});
