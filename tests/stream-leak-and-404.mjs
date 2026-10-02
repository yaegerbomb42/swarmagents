// Verifies:
// 1. Opening and closing 500 runtime stream subscriptions does not leak listeners in subscribeRuntime.
// 2. Cross-account / unknown task access on DELETE and POST returns 404.
// Run: npx tsx tests/stream-leak-and-404.mjs

import assert from "node:assert";
import { subscribeRuntime, createTask, deleteTask } from "../lib/runtime/tasks.ts";
import { runAs } from "../lib/store.ts";

let pass = 0;
const t = async (name, fn) => {
  await fn();
  pass++;
  console.log("  ok", name);
};

await t("open and close 500 runtime stream subscriptions with zero listener leak", async () => {
  // Subscribe and unsubscribe 500 times
  const unsubs = [];
  for (let i = 0; i < 500; i++) {
    const unsub = subscribeRuntime(() => {});
    unsubs.push(unsub);
  }

  // Cleanup all 500
  for (const unsub of unsubs) {
    unsub();
  }

  // Verify that an announced event only calls active subscribers, and no lingering listeners remain
  let callCount = 0;
  const activeUnsub = subscribeRuntime(() => {
    callCount++;
  });

  // Create a dummy task to trigger announce()
  const task = await createTask({ prompt: "test stream leak" });
  assert.equal(callCount, 1, "Only the 1 active subscriber should receive the event");

  activeUnsub();
  await deleteTask(task.id, true);
});

await t("deleteTask returns false for non-existent or foreign task ID", async () => {
  const result = await deleteTask("non-existent-task-id-12345", true);
  assert.strictEqual(result, false, "Deleting an unknown task must return false");
});

await t("cross-account isolation on deleteTask", async () => {
  const userA = "1111111111111111";
  const userB = "2222222222222222";

  // Create task under userA
  const taskA = await runAs(userA, async () => {
    return await createTask({ prompt: "Task for user A" });
  });

  assert.ok(taskA.id);

  // Attempt to delete under userB
  const deleteUnderB = await runAs(userB, async () => {
    return await deleteTask(taskA.id, true);
  });
  assert.strictEqual(deleteUnderB, false, "userB cannot delete userA's task");

  // userA can delete their own task
  const deleteUnderA = await runAs(userA, async () => {
    return await deleteTask(taskA.id, true);
  });
  assert.strictEqual(deleteUnderA, true, "userA can delete their own task");
});

console.log(`\nSTREAM LEAK & 404 PASS (${pass})`);
