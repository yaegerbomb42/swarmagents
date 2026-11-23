import test from "node:test";
import assert from "node:assert/strict";
import { KeyPool } from "./key-pool";

test("KeyPool trims, drops empty keys, and dedupes by value", () => {
  const pool = new KeyPool("prov", [" k1 ", "k1", "", "   ", "k2"]);
  assert.equal(pool.size, 2);
  assert.deepEqual(
    [pool.acquire()!.id, pool.acquire()!.id],
    ["prov:key-1", "prov:key-2"],
  );
});

test("KeyPool rotates to the least-recently-used usable key", () => {
  const pool = new KeyPool("prov", ["k1", "k2"], { now: () => 0 });
  const first = pool.acquire()!;
  assert.equal(first.id, "prov:key-1");
  first.cancel();
  const second = pool.acquire()!;
  assert.equal(second.id, "prov:key-2");
  second.cancel();
  const third = pool.acquire()!;
  assert.equal(third.id, "prov:key-1");
});

test("KeyPool skips a key that is cooling down", () => {
  let now = 1_000;
  const pool = new KeyPool("prov", ["k1", "k2"], { now: () => now });
  const first = pool.acquire()!;
  first.failure({ kind: "rate_limit", status: 429 });

  const stats = pool.stats();
  assert.equal(stats[0].available, false);
  assert.ok((stats[0].cooldownUntil ?? 0) > now);
  assert.equal(pool.acquire()!.id, "prov:key-2");

  now += 10_000;
  assert.equal(pool.stats()[0].available, true);
});

test("KeyPool returns null when every key is cooling down", () => {
  const pool = new KeyPool("prov", ["k1"], { now: () => 0 });
  const lease = pool.acquire()!;
  lease.failure({ kind: "quota_exhausted", status: 402 });
  assert.equal(pool.hasAvailable(), false);
  assert.equal(pool.acquire(), null);
});

test("KeyPool settles a lease only once", () => {
  const pool = new KeyPool("prov", ["k1"], { now: () => 0 });
  const lease = pool.acquire()!;
  lease.success(100);
  lease.failure({ kind: "rate_limit" });
  lease.cancel();
  const stat = pool.stats()[0];
  assert.equal(stat.successes, 1);
  assert.equal(stat.failures, 0);
});

test("KeyPool never exposes key material in stats, cooldown records, or errors", () => {
  const secret = "sk-test-secret-material-123";
  const pool = new KeyPool("prov", [secret], { now: () => 0 });
  const lease = pool.acquire()!;
  assert.ok(!lease.id.includes(secret));
  lease.failure({ kind: "auth", status: 401 });

  const serialized = JSON.stringify({ stats: pool.stats(), cooldowns: pool.cooldownStates() });
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes("test-secret-material"));

  let thrown = "";
  try {
    new KeyPool("prov", [secret, null] as unknown as string[]);
  } catch (error) {
    thrown = String(error);
  }
  assert.ok(!thrown.includes(secret), "a constructor error must not echo the key");
});
