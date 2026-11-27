// Per-agent VM wiring in the runtime manager: a run with an agentId
// executes in that agent's own desktop VM, a second agent gets a different
// VM, and the run summary carries the agent so the UI can dial its desktop.

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../vm/types";
import type { RunSummary } from "./manager";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_agent_vm", model: "claude-test" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_agent_vm", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

/** Fake VM that replays claude like the queue tests and records every ensure key. */
class RecordingVm extends FakeVmDriver {
  ensures: string[] = [];
  calls: string[][] = [];

  override async ensure(userId: string): Promise<VmHandle> {
    this.ensures.push(userId);
    return super.ensure(userId);
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    this.calls.push(cmd);
    if (opts?.signal?.aborted) return { exitCode: 130 };
    for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
    return { exitCode: 0 };
  }
}

function managerWith(driver: VmDriver): RuntimeManager {
  return new RuntimeManager({
    vm: new VmManager({ customDriver: driver }),
    router: null,
  });
}

async function waitFor(
  manager: RuntimeManager,
  userId: string,
  pred: (runs: RunSummary[]) => boolean,
  steps = 400,
): Promise<RunSummary[]> {
  for (let i = 0; i < steps; i++) {
    const runs = manager.list(userId);
    if (pred(runs)) return runs;
    await sleep(10);
  }
  throw new Error("timed out waiting for run state");
}

test("a run with agentId executes in that agent's VM, not the per-user one", async () => {
  const driver = new RecordingVm();
  const manager = managerWith(driver);

  const started = manager.start("alice", { prompt: "do it", agentId: "worker-2" });
  assert.equal(started.accepted, true);
  assert.equal(started.queued, false);

  const runs = await waitFor(manager, "alice", (all) =>
    all.every((run) => run.status !== "running" && run.status !== "queued"),
  );
  const run = runs.find((r) => r.runId === started.runId);
  assert.equal(run?.status, "finished");
  assert.equal(run?.agentId, "worker-2");
  assert.ok(driver.ensures.includes("agent:worker-2:alice"), `ensures: ${driver.ensures}`);
  assert.ok(!driver.ensures.includes("alice"), `the per-user VM must not be ensured: ${driver.ensures}`);
  assert.equal(driver.calls.length, 1);
});

test("two sequential runs for different agents use two distinct VMs", async () => {
  const driver = new RecordingVm();
  const manager = managerWith(driver);

  const first = manager.start("alice", { prompt: "first", agentId: "worker-2" });
  assert.equal(first.accepted, true);
  await waitFor(manager, "alice", (all) =>
    all.every((run) => run.status !== "running" && run.status !== "queued"),
  );

  const second = manager.start("alice", { prompt: "second" });
  assert.equal(second.accepted, true);
  const runs = await waitFor(manager, "alice", (all) =>
    all.length === 2 && all.every((run) => run.status !== "running" && run.status !== "queued"),
  );

  assert.ok(driver.ensures.includes("agent:worker-2:alice"));
  assert.ok(driver.ensures.includes("alice"), `ensures: ${driver.ensures}`);
  assert.equal(runs.find((r) => r.runId === first.runId)?.agentId, "worker-2");
  assert.equal(runs.find((r) => r.runId === second.runId)?.agentId, undefined);
  assert.equal(driver.calls.length, 2);
});

test("the default agent reuses the per-user VM", async () => {
  const driver = new RecordingVm();
  const manager = managerWith(driver);

  const started = manager.start("alice", { prompt: "do it" });
  assert.equal(started.accepted, true);
  await waitFor(manager, "alice", (all) =>
    all.every((run) => run.status !== "running" && run.status !== "queued"),
  );
  assert.ok(driver.ensures.includes("alice"));
  assert.ok(!driver.ensures.some((key) => key.startsWith("agent:")), `ensures: ${driver.ensures}`);
});

test("an invalid agentId is refused at admission", async () => {
  const driver = new RecordingVm();
  const manager = managerWith(driver);

  const refused = manager.start("alice", { prompt: "do it", agentId: "bad/id" });
  assert.equal(refused.accepted, false);
  assert.match(refused.error ?? "", /agentId/);
  assert.equal(manager.list("alice").length, 0);
  assert.equal(driver.ensures.length, 0);
});
