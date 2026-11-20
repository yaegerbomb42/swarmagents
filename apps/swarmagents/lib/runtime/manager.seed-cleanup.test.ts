/**
 * General improvement (a) — seedRoleFiles() clears orphaned
 * /workspace/.swarm/questions/*.pending.json files so a new run cannot
 * adopt a leftover question from an aborted prior run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager, type RunSummary } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { ASK_QUESTIONS_DIR } from "../harness/ask-mcp";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class RecordingDriver extends FakeVmDriver {
  execs: string[][] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execs.push(cmd);
    return super.exec(handle, cmd, opts);
  }
}

async function waitForRun(
  manager: RuntimeManager,
  userId: string,
  runId: string,
): Promise<RunSummary> {
  const deadline = Date.now() + 10000;
  for (;;) {
    const run = manager.list(userId).find((candidate) => candidate.runId === runId);
    if (run && run.status !== "running" && run.status !== "queued") return run;
    if (Date.now() > deadline) throw new Error("timed out waiting for run to finish");
    await sleep(10);
  }
}

test("run start clears orphaned pending questions before the agent runs", async () => {
  const driver = new RecordingDriver();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });
  const started = manager.start("u-seed-cleanup", { prompt: "hello" });
  assert.equal(started.accepted, true);

  const run = await waitForRun(manager, "u-seed-cleanup", started.runId);
  assert.equal(run.status, "finished");

  const rmIndex = driver.execs.findIndex(
    (cmd) => cmd[0] === "sh" && cmd.some((arg) => arg === `rm -f ${ASK_QUESTIONS_DIR}/*.pending.json`),
  );
  assert.ok(rmIndex >= 0, `expected the orphan cleanup exec, saw: ${driver.execs.map((c) => c.join(" ")).join(" | ")}`);
  const claudeIndex = driver.execs.findIndex((cmd) => cmd[0] === "claude");
  assert.ok(claudeIndex >= 0, "expected a claude exec");
  assert.ok(rmIndex < claudeIndex, "the cleanup must run before the first agent exec");
});
