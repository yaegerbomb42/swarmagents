import test from "node:test";
import assert from "node:assert/strict";
import { KeyPool } from "./key-pool";

test("fallback mode always serves the first usable key in saved order", () => {
  const pool = new KeyPool("prov", ["k1", "k2", "k3"], {
    now: () => 0,
    selectionMode: "fallback",
  });
  for (let i = 0; i < 3; i++) {
    const lease = pool.acquire()!;
    assert.equal(lease.id, "prov:key-1");
    lease.success(10);
  }
});

test("fallback mode moves to the next key only while the first cools down", () => {
  let now = 1_000;
  const pool = new KeyPool("prov", ["k1", "k2"], {
    now: () => now,
    selectionMode: "fallback",
  });
  pool.acquire()!.failure({ kind: "rate_limit", status: 429 });
  assert.equal(pool.acquire()!.id, "prov:key-2");
  now += 60_000; // cooldown elapsed
  assert.equal(pool.acquire()!.id, "prov:key-1");
});

test("random mode picks uniformly via the injected randomness", () => {
  const picks = [0, 0.5, 0.99];
  let i = 0;
  const pool = new KeyPool("prov", ["k1", "k2", "k3"], {
    now: () => 0,
    selectionMode: "random",
    random: () => picks[i++]!,
  });
  assert.equal(pool.acquire()!.id, "prov:key-1");
  assert.equal(pool.acquire()!.id, "prov:key-2");
  assert.equal(pool.acquire()!.id, "prov:key-3");
});

test("random mode never picks a cooling key", () => {
  const pool = new KeyPool("prov", ["k1", "k2"], {
    now: () => 0,
    selectionMode: "random",
    random: () => 0,
  });
  pool.acquire()!.failure({ kind: "rate_limit", status: 429 });
  assert.equal(pool.acquire()!.id, "prov:key-2");
});

test("tiered mode prefers the fastest healthy key over LRU order", () => {
  const pool = new KeyPool("prov", ["k1", "k2"], {
    now: () => 0,
    selectionMode: "tiered",
  });
  // k1 serves first (both unsampled, LRU tie) and is slow; k2 is fast.
  pool.acquire()!.success(900);
  pool.acquire()!.success(100);
  // Both healthy; tiered picks the lower-latency k2 even though k1 is LRU.
  assert.equal(pool.acquire()!.id, "prov:key-2");
});

test("tiered mode still prefers fewer consecutive failures over latency", () => {
  let now = 1_000;
  const pool = new KeyPool("prov", ["k1", "k2"], {
    now: () => now,
    selectionMode: "tiered",
  });
  pool.acquire()!.success(900); // k1 slow but healthy
  pool.acquire()!.failure({ kind: "rate_limit", status: 429 }); // k2 fails, cools
  now += 60_000; // k2 usable again but carries a consecutive failure
  assert.equal(pool.acquire()!.id, "prov:key-1");
});

test("round-robin remains the default when no mode is given", () => {
  const pool = new KeyPool("prov", ["k1", "k2"], { now: () => 0 });
  assert.equal(pool.acquire()!.id, "prov:key-1");
  assert.equal(pool.acquire()!.id, "prov:key-2");
  assert.equal(pool.acquire()!.id, "prov:key-1");
});
