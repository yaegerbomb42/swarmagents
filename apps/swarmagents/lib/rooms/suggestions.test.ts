/**
 * Unit tests for the guest suggestion store: FIFO ordering, the
 * SWARM_MAX_QUEUED bound, input validation, rate limiting, and immutability
 * of returned snapshots.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SuggestionsStore, maxQueuedFromEnv, MAX_SUGGESTION_LEN } from "./suggestions";

test("maxQueuedFromEnv: defaults and falls back on invalid values", () => {
  assert.equal(maxQueuedFromEnv({}), 3);
  assert.equal(maxQueuedFromEnv({ SWARM_MAX_QUEUED: "5" }), 5);
  assert.equal(maxQueuedFromEnv({ SWARM_MAX_QUEUED: "0" }), 0);
  assert.equal(maxQueuedFromEnv({ SWARM_MAX_QUEUED: "abc" }), 3);
  assert.equal(maxQueuedFromEnv({ SWARM_MAX_QUEUED: "-2" }), 3);
});

test("add: validates and trims the prompt", () => {
  const store = new SuggestionsStore();
  assert.equal(store.add("alice", "   ").accepted, false);
  assert.equal(store.add("", "hello").accepted, false);
  assert.equal(store.add("alice", "x".repeat(MAX_SUGGESTION_LEN + 1)).accepted, false);

  const ok = store.add("alice", "  run tests  ");
  assert.equal(ok.accepted, true);
  assert.equal(ok.suggestion?.prompt, "run tests");
});

test("add: FIFO ordering and the SWARM_MAX_QUEUED bound", () => {
  const store = new SuggestionsStore({ now: () => 1000, maxQueued: 2 });
  store.add("alice", "first");
  store.add("alice", "second");

  const third = store.add("alice", "third");
  assert.equal(third.accepted, false);
  assert.equal(third.limit, 2);

  // FIFO: oldest first.
  const list = store.list("alice");
  assert.deepEqual(list.map((s) => s.prompt), ["first", "second"]);
  assert.equal(store.count("alice"), 2);
});

test("remove: consumes a specific suggestion immutably", () => {
  const store = new SuggestionsStore({ now: () => 1000 });
  store.add("alice", "alpha");
  store.add("alice", "beta");
  const beta = store.list("alice")[1];

  const removed = store.remove("alice", beta.id);
  assert.equal(removed.ok, true);
  assert.equal(removed.suggestion?.prompt, "beta");
  assert.deepEqual(store.list("alice").map((s) => s.prompt), ["alpha"]);

  // Idempotent: removing again fails.
  assert.equal(store.remove("alice", beta.id).ok, false);
  // Unknown id fails.
  assert.equal(store.remove("alice", "nope").ok, false);
});

test("rate limiting: bounded by window, resets after it elapses", () => {
  let now = 1000;
  const store = new SuggestionsStore({ now: () => now, maxPerWindow: 2 });
  assert.equal(store.add("alice", "a").accepted, true);
  assert.equal(store.add("alice", "b").accepted, true);
  const blocked = store.add("alice", "c");
  assert.equal(blocked.accepted, false);
  assert.ok(blocked.error);

  now += 61_000;
  assert.equal(store.add("alice", "d").accepted, true);
});

test("immutability: returned snapshots are copies, not live arrays", () => {
  const store = new SuggestionsStore({ now: () => 1000 });
  store.add("alice", "one");
  const list = store.list("alice");
  list[0].prompt = "mutated";
  assert.equal(store.list("alice")[0].prompt, "one");

  const added = store.add("alice", "two");
  const returned = added.suggestion!;
  returned.prompt = "mutated";
  assert.equal(store.list("alice")[1].prompt, "two");
});

test("queues are isolated per owner", () => {
  const store = new SuggestionsStore({ now: () => 1000 });
  store.add("alice", "for alice");
  store.add("bob", "for bob");
  assert.equal(store.count("alice"), 1);
  assert.equal(store.list("bob")[0].prompt, "for bob");
});
