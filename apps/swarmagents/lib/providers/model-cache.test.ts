/**
 * Tests for the per-user model-list cache: TTL hits, forced refresh,
 * fail-open to stale cache and caller fallback, per-owner isolation, and
 * the rule that errors are never cached.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ModelListCache, discoverModelsWithCache } from "./model-cache";
import type { ProviderConfig } from "./types";

const OWNER = "local_tester@example.com";
const KEY = "test-key-not-real";

const config: ProviderConfig = {
  id: "groq",
  kind: "openai",
  apiStyle: "openai-chat",
  baseUrl: "https://api.groq.com/openai/v1",
};

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub that counts calls and can be flipped to failing. */
function stubFetch() {
  const state = { calls: 0, fail: false, ids: ["model-a", "model-b"] };
  const fetchImpl = (async () => {
    state.calls += 1;
    if (state.fail) return new Response("boom", { status: 500 });
    return modelsResponse(state.ids);
  }) as typeof fetch;
  return { state, fetchImpl };
}

test("first call fetches live, second within TTL serves the cache", async () => {
  const { state, fetchImpl } = stubFetch();
  const cache = new ModelListCache(60_000);
  let now = 1_000_000;

  const first = await discoverModelsWithCache(config, KEY, {
    owner: OWNER,
    fetchImpl,
    cache,
    now: () => now,
  });
  assert.equal(first.source, "live");
  assert.equal(first.stale, false);
  assert.deepEqual(first.models.map((m) => m.id), ["model-a", "model-b"]);
  assert.equal(state.calls, 1);

  now += 30_000;
  const second = await discoverModelsWithCache(config, KEY, {
    owner: OWNER,
    fetchImpl,
    cache,
    now: () => now,
  });
  assert.equal(second.source, "cache");
  assert.equal(second.stale, false);
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(state.calls, 1, "a fresh cache entry must not refetch");
});

test("force bypasses a fresh cache entry", async () => {
  const { state, fetchImpl } = stubFetch();
  const cache = new ModelListCache(60_000);
  const now = () => 1_000_000;

  await discoverModelsWithCache(config, KEY, { owner: OWNER, fetchImpl, cache, now });
  state.ids = ["model-c"];
  const forced = await discoverModelsWithCache(config, KEY, {
    owner: OWNER,
    fetchImpl,
    cache,
    now,
    force: true,
  });
  assert.equal(forced.source, "live");
  assert.deepEqual(forced.models.map((m) => m.id), ["model-c"]);
  assert.equal(state.calls, 2);
});

test("an expired entry refetches live", async () => {
  const { state, fetchImpl } = stubFetch();
  const cache = new ModelListCache(60_000);
  let now = 1_000_000;

  await discoverModelsWithCache(config, KEY, { owner: OWNER, fetchImpl, cache, now: () => now });
  now += 61_000;
  const again = await discoverModelsWithCache(config, KEY, {
    owner: OWNER,
    fetchImpl,
    cache,
    now: () => now,
  });
  assert.equal(again.source, "live");
  assert.equal(state.calls, 2);
});

test("a failed refresh serves the stale cache with a warning", async () => {
  const { state, fetchImpl } = stubFetch();
  const cache = new ModelListCache(60_000);
  let now = 1_000_000;

  const first = await discoverModelsWithCache(config, KEY, {
    owner: OWNER,
    fetchImpl,
    cache,
    now: () => now,
  });
  now += 61_000;
  state.fail = true;
  const stale = await discoverModelsWithCache(config, KEY, {
    owner: OWNER,
    fetchImpl,
    cache,
    now: () => now,
  });
  assert.equal(stale.source, "stale-cache");
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.ok(stale.warning, "a stale result must carry the failure as a warning");
  assert.deepEqual(stale.models.map((m) => m.id), ["model-a", "model-b"]);
});

test("a failed first fetch serves the caller fallback", async () => {
  const { state, fetchImpl } = stubFetch();
  state.fail = true;
  const cache = new ModelListCache(60_000);

  const result = await discoverModelsWithCache(config, KEY, {
    owner: OWNER,
    fetchImpl,
    cache,
    fallbackModels: ["catalog-one", "catalog-two"],
  });
  assert.equal(result.source, "fallback");
  assert.equal(result.stale, true);
  assert.ok(result.warning);
  assert.deepEqual(result.models.map((m) => m.id), ["catalog-one", "catalog-two"]);
});

test("a failed first fetch with nothing to fall back to rethrows", async () => {
  const { state, fetchImpl } = stubFetch();
  state.fail = true;
  const cache = new ModelListCache(60_000);

  await assert.rejects(
    discoverModelsWithCache(config, KEY, { owner: OWNER, fetchImpl, cache }),
    /500|boom/,
  );
});

test("errors are never cached", async () => {
  const { state, fetchImpl } = stubFetch();
  const cache = new ModelListCache(60_000);
  const now = () => 1_000_000;

  state.fail = true;
  await assert.rejects(discoverModelsWithCache(config, KEY, { owner: OWNER, fetchImpl, cache, now }));
  state.fail = false;
  const recovered = await discoverModelsWithCache(config, KEY, { owner: OWNER, fetchImpl, cache, now });
  assert.equal(recovered.source, "live");
  assert.equal(state.calls, 2, "the retry must reach the network, not a cached error");
});

test("cache entries are isolated per owner", async () => {
  const { state, fetchImpl } = stubFetch();
  const cache = new ModelListCache(60_000);
  const now = () => 1_000_000;

  await discoverModelsWithCache(config, KEY, { owner: OWNER, fetchImpl, cache, now });
  const other = await discoverModelsWithCache(config, KEY, {
    owner: "local_other@example.com",
    fetchImpl,
    cache,
    now,
  });
  assert.equal(other.source, "live", "another user must not see the first user's cache");
  assert.equal(state.calls, 2);
});

test("results never carry key material", async () => {
  const { fetchImpl } = stubFetch();
  const cache = new ModelListCache(60_000);
  const result = await discoverModelsWithCache(config, KEY, { owner: OWNER, fetchImpl, cache });
  assert.ok(!JSON.stringify(result).includes(KEY));
});
