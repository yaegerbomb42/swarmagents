import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TelemetryBus } from "../telemetry/bus";
import { FakeVmDriver } from "../vm/fake-driver";
import { getRun, ORPHANED_RUN_REASON, setRecoveryEpochForTesting } from "./run-store";
import {
  killOrphanedAgentProcessesOnce,
  reconcileInterruptedRunsOnStartup,
  resetRecoveryStateForTesting,
  startupRecoveredRunCount,
} from "./recovery";

test("reconcileInterruptedRunsOnStartup finalizes running/queued runs from prior epoch and is idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-recovery-"));
  const prevHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = home;
  const runsDir = path.join(home, "runs");
  resetRecoveryStateForTesting();

  try {
    const bus = new TelemetryBus({ persist: true });
    bus.publish("run_prev_1", { type: "run.created", data: { prompt: "active work", userId: "alice" } });
    bus.publish("run_prev_1", { type: "run.started", data: { userId: "alice" } });
    assert.equal(getRun("run_prev_1", runsDir)?.summary.status, "running");

    setRecoveryEpochForTesting(getRun("run_prev_1", runsDir)!.summary.createdAt + 1);

    const first = reconcileInterruptedRunsOnStartup(runsDir);
    assert.equal(first, 1);
    assert.equal(startupRecoveredRunCount(), 1);
    assert.equal(getRun("run_prev_1", runsDir)?.summary.status, "error");
    assert.equal(getRun("run_prev_1", runsDir)?.summary.error, ORPHANED_RUN_REASON);

    const second = reconcileInterruptedRunsOnStartup(runsDir);
    assert.equal(second, 0);
  } finally {
    resetRecoveryStateForTesting();
    if (prevHome === undefined) delete process.env.SWARM_HOME;
    else process.env.SWARM_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("killOrphanedAgentProcessesOnce runs pkill once per user, ignores exit 1, and skips FakeVmDriver", async () => {
  const swept = new Set<string>();
  const fakeVm = {
    driver: new FakeVmDriver(),
    async exec() {
      throw new Error("must not exec on FakeVmDriver");
    },
  };
  assert.equal(await killOrphanedAgentProcessesOnce(fakeVm as never, "u1", swept), false);
  assert.equal(swept.has("u1"), true);

  const calls: Array<{ userId: string; cmd: string[] }> = [];
  const realLikeSwept = new Set<string>();
  const realLikeVm = {
    driver: {} as never,
    async exec(userId: string, cmd: string[]) {
      calls.push({ userId, cmd });
      // Simulate pkill exit code 1 (no process found) throwing or returning 1
      throw new Error("exit 1");
    },
  };

  assert.equal(await killOrphanedAgentProcessesOnce(realLikeVm, "u1", realLikeSwept), true);
  assert.equal(await killOrphanedAgentProcessesOnce(realLikeVm, "u1", realLikeSwept), false);
  assert.equal(await killOrphanedAgentProcessesOnce(realLikeVm, "u2", realLikeSwept), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { userId: "u1", cmd: ["pkill", "-u", "agent", "-f", "claude -p"] });
  assert.deepEqual(calls[1], { userId: "u2", cmd: ["pkill", "-u", "agent", "-f", "claude -p"] });
});
