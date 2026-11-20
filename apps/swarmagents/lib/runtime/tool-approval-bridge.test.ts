import test from "node:test";
import assert from "node:assert/strict";
import {
  clearSynchronousApprovalsForTesting,
  registerSynchronousApproval,
  requestRegisteredApproval,
} from "./tool-approval-bridge";

test.afterEach(() => {
  clearSynchronousApprovalsForTesting();
});

test("dispatches to the run's handler and scopes it to the owning user", async () => {
  const calls: Array<[string, unknown]> = [];
  registerSynchronousApproval("run_team", "alice", async (toolName, input) => {
    calls.push([toolName, input]);
    return { decision: "allow" };
  });

  const result = await requestRegisteredApproval("alice", "run_team", "Bash", { command: "ls" });
  assert.deepEqual(result, { decision: "allow" });
  assert.deepEqual(calls, [["Bash", { command: "ls" }]]);

  // Another user can never answer this run's call.
  assert.equal(requestRegisteredApproval("bob", "run_team", "Bash", {}), null);
  // Unknown run.
  assert.equal(requestRegisteredApproval("alice", "run_other", "Bash", {}), null);
});

test("unregister is idempotent and only removes its own handler", async () => {
  const first = registerSynchronousApproval("run_a", "alice", async () => ({ decision: "allow" }));
  const second = registerSynchronousApproval("run_a", "alice", async () => ({ decision: "deny" }));

  // The newer registration wins; the old unregister must not remove it.
  assert.deepEqual(await requestRegisteredApproval("alice", "run_a", "Bash", {}), { decision: "deny" });
  first();
  assert.deepEqual(await requestRegisteredApproval("alice", "run_a", "Bash", {}), { decision: "deny" });
  second();
  assert.equal(requestRegisteredApproval("alice", "run_a", "Bash", {}), null);
});
