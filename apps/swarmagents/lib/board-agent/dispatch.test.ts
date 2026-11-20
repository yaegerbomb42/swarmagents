import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { SwarmTask } from "../mcp-types";
import { RuntimeManager, setRuntimeManagerForTesting } from "../runtime/manager";
import { configureRunsDir } from "../telemetry/paths";
import { dispatchTaskToVm } from "./dispatch";

const task: SwarmTask = {
  id: "task_docs", title: "Improve docs", description: "Document the API example", constraints: ["Keep the example short"],
  difficulty: "medium", minElo: 1200, status: "open", createdAt: 1, updatedAt: 1,
};

function stubStart(t: TestContext, start: RuntimeManager["start"]) {
  configureRunsDir(null);
  const manager = new RuntimeManager({ router: null });
  setRuntimeManagerForTesting(manager);
  t.after(() => setRuntimeManagerForTesting(null));
  return t.mock.method(manager, "start", start);
}

test("accepts a queued cloud VM run, with task details and l1 PR instructions in a fresh session", (t) => {
  const start = stubStart(t, () => ({ accepted: true, runId: "run_queued", queued: true, position: 1 }));
  assert.deepEqual(dispatchTaskToVm("alice", task), { runId: "run_queued" });
  const [owner, input] = start.mock.calls[0].arguments;
  assert.equal(owner, "alice");
  assert.equal(input.computeTarget, "cloud");
  assert.equal(input.freshSession, true);
  for (const part of [task.id, task.title, task.description, task.constraints[0], "current tip of origin/feat/l1-Ace-1-library-store", "open a PR targeting feat/l1-Ace-1-library-store", "Do not merge"]) {
    assert.ok(input.prompt.includes(part), `missing instruction: ${part}`);
  }
  assert.equal("runId" in task, false);
});

test("returns a queue refusal or configuration error instead of an empty run id", (t) => {
  const start = stubStart(t, () => ({ accepted: false, runId: "", queued: false, limit: 2 }));
  assert.deepEqual(dispatchTaskToVm("alice", task), { error: "The VM run queue is full (max 2). Wait for a run to finish." });
  start.mock.mockImplementation(() => ({ accepted: false, runId: "", queued: false, error: "No VM is configured." }));
  assert.deepEqual(dispatchTaskToVm("alice", task), { error: "No VM is configured." });
});

test("turns a thrown startup error into a short error without the stack", (t) => {
  stubStart(t, () => { throw new Error("No provider available to start the VM."); });
  assert.deepEqual(dispatchTaskToVm("alice", task), { error: "No provider available to start the VM." });
});
