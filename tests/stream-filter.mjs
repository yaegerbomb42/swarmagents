// Cross-account admission logic for the live task-board stream (lib/runtime/stream-filter.ts).
// The stream is a process-wide broadcast, so this filter is what keeps one account from seeing
// another's task board. The live end-to-end check is tests/tenant-isolation.mjs ("live"); this
// unit test locks the decision table down without a server.
// Run: npx tsx tests/stream-filter.mjs
import assert from "node:assert";
import { makeAccountFilter } from "../lib/runtime/stream-filter.ts";

let pass = 0;
const t = (name, fn) => {
  fn();
  pass++;
  console.log("  ok", name);
};

// Two accounts with disjoint task sets. ownIds() is re-read on every unknown event, so it mimics
// the store: it returns whatever ids "exist" for that account at call time.
let aliceIds = new Set(["a1"]);
let malloryIds = new Set(["m1"]);
const alice = makeAccountFilter("alice", () => new Set(aliceIds));
const mallory = makeAccountFilter("mallory", () => new Set(malloryIds));

const taskEvent = (id, userId) => ({ type: "task", task: { id, userId } });
const removed = (id, userId) => ({ type: "removed", id, userId });

t("an untagged event for an owned id is admitted", () => {
  assert.equal(alice.admit(taskEvent("a1")), true);
});

t("an untagged event for a foreign id is denied", () => {
  assert.equal(alice.admit(taskEvent("m1")), false);
  assert.equal(mallory.admit(taskEvent("a1")), false);
});

t("a newly created task in this account is admitted after a refresh", () => {
  aliceIds.add("a2"); // the task now exists for alice
  assert.equal(alice.admit(taskEvent("a2")), true);
  // ...but is still foreign to mallory.
  assert.equal(mallory.admit(taskEvent("a2")), false);
});

t("a task created in another account is never admitted", () => {
  malloryIds.add("m2");
  assert.equal(alice.admit(taskEvent("m2")), false);
});

t("a tagged event is admitted only for its owner", () => {
  assert.equal(alice.admit(taskEvent("zz", "alice")), true);
  assert.equal(mallory.admit(taskEvent("zz", "alice")), false);
  assert.equal(mallory.admit(taskEvent("yy", "mallory")), true);
});

t("a removal is admitted only for an owned task", () => {
  aliceIds.add("a3");
  assert.equal(alice.admit(removed("a3")), true); // owned at call time
  assert.equal(alice.admit(removed("m1")), false); // foreign
  assert.equal(mallory.admit(removed("m1")), true); // its own
});

t("a removal is admitted by tag even once the id is gone from storage", () => {
  // The task was deleted, so the store no longer lists it, but the owner tag still routes it.
  assert.equal(alice.admit(removed("gone", "alice")), true);
  assert.equal(mallory.admit(removed("gone", "alice")), false);
});

t("the filter only ever reports the account's own ids", () => {
  for (const id of alice.ids()) assert.notEqual(id, "m1");
  for (const id of mallory.ids()) assert.notEqual(id, "a1");
});

console.log(`\nSTREAM FILTER PASS (${pass})`);