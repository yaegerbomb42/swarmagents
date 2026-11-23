/**
 * Run-flow auto-commit wiring: after a successful agent run, an opted-in
 * account's tracked changes are committed (via the injected committer)
 * before the terminal event, and the result is published as a git.commit
 * run event. Disabled accounts and failed commits leave the run's finish
 * untouched.
 *
 * Drives real runs over the FakeVmDriver's recorded transcript (the
 * `claude` exec finishes immediately), mirroring manager.restart.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeManager, type RunSummary } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { TelemetryBus } from "../telemetry/bus";
import { configureRunsDir } from "../telemetry/paths";
import { readRunEvents } from "../telemetry/run-log";
import { ApprovalStore, setApprovalStoreForTesting } from "../harness/approvals";
import { writeUserSettings } from "../providers/settings";
import type { GitCommitResult } from "../harness/git-committer";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForFinished(
  manager: RuntimeManager,
  userId: string,
  runId: string,
  steps = 400,
): Promise<RunSummary> {
  for (let i = 0; i < steps; i++) {
    const run = manager.list(userId).find((r) => r.runId === runId);
    if (run && (run.status === "finished" || run.status === "error" || run.status === "cancelled")) {
      return run;
    }
    await sleep(10);
  }
  throw new Error("timed out waiting for run to finish");
}

interface Harness {
  manager: RuntimeManager;
  runsDir: string;
  cleanup: () => void;
}

function setup(autoCommit: (userId: string) => Promise<GitCommitResult>, enabled: boolean): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-autocommit-"));
  const runsDir = path.join(dir, "runs");
  configureRunsDir(runsDir);
  const previousHome = process.env.SWARM_HOME;
  process.env.SWARM_HOME = dir;
  writeUserSettings("alice", { preferFreeProviders: true, gitAutoCommit: enabled });
  setApprovalStoreForTesting(
    new ApprovalStore({ persistPath: path.join(dir, "approvals.json"), ttlMs: 60_000 }),
  );
  const bus = new TelemetryBus({ persist: true, runsDir: () => runsDir });
  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: new FakeVmDriver() }),
    bus,
    router: null,
    autoCommit,
  });
  return {
    manager,
    runsDir,
    cleanup: () => {
      manager.cancel("alice");
      configureRunsDir(null);
      setApprovalStoreForTesting(null);
      if (previousHome === undefined) delete process.env.SWARM_HOME;
      else process.env.SWARM_HOME = previousHome;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const SUCCESS: GitCommitResult = {
  success: true,
  commitMessage: "feat(app): add the thing",
  filesCommitted: ["src/app.ts"],
  output: "[main abc1234] feat(app): add the thing",
};

test("auto-commit fires after a finished run when enabled, before run.finished", async () => {
  const calls: string[] = [];
  const { manager, runsDir, cleanup } = setup(async (userId) => {
    calls.push(userId);
    return SUCCESS;
  }, true);
  try {
    const started = manager.start("alice", { prompt: "do the thing" });
    assert.equal(started.accepted, true);
    const summary = await waitForFinished(manager, "alice", started.runId);
    assert.equal(summary.status, "finished");
    assert.deepEqual(calls, ["alice"]);

    const events = readRunEvents(started.runId, runsDir);
    const commit = events.find((e) => e.type === "git.commit");
    assert.ok(commit, "git.commit event must be in the run log");
    assert.deepEqual(commit.data, {
      success: true,
      commitMessage: "feat(app): add the thing",
      filesCommitted: ["src/app.ts"],
      output: "[main abc1234] feat(app): add the thing",
    });
    const finished = events.find((e) => e.type === "run.finished");
    assert.ok(finished, "run.finished event must be in the run log");
    assert.ok(commit.seq < finished.seq, "git.commit must precede the terminal event");
  } finally {
    cleanup();
  }
});

test("auto-commit does not fire when the setting is off", async () => {
  let called = false;
  const { manager, runsDir, cleanup } = setup(async () => {
    called = true;
    return SUCCESS;
  }, false);
  try {
    const started = manager.start("alice", { prompt: "do the thing" });
    const summary = await waitForFinished(manager, "alice", started.runId);
    assert.equal(summary.status, "finished");
    assert.equal(called, false);
    const events = readRunEvents(started.runId, runsDir);
    assert.equal(events.some((e) => e.type === "git.commit"), false);
  } finally {
    cleanup();
  }
});

test("a failed auto-commit does not fail the run", async () => {
  const { manager, runsDir, cleanup } = setup(
    async () => ({
      success: false,
      commitMessage: "",
      filesCommitted: [],
      output: "git commit failed: Author identity unknown",
    }),
    true,
  );
  try {
    const started = manager.start("alice", { prompt: "do the thing" });
    const summary = await waitForFinished(manager, "alice", started.runId);
    assert.equal(summary.status, "finished");
    assert.equal(summary.error, undefined);

    const events = readRunEvents(started.runId, runsDir);
    const commit = events.find((e) => e.type === "git.commit");
    assert.ok(commit, "the failure must be published as the git.commit event");
    assert.deepEqual(commit.data, {
      success: false,
      commitMessage: "",
      filesCommitted: [],
      output: "git commit failed: Author identity unknown",
    });
  } finally {
    cleanup();
  }
});
