/**
 * FIX-20: a cancelled run's leftover processes are reaped before the
 * successor run's harness spawns in the same VM.
 *
 * Previously the kill-escalation backstop stood down whenever a successor
 * had taken the slot (`active !== null`), so orphaned processes of a
 * cancelled run (TERM ignored, detached children of the agent's shell) kept
 * running inside the user's VM during the next run. The kill is scoped to
 * the cancelled run's own recorded process group, so startNext now reaps
 * pending cancelling entries before executing the successor — bounded by
 * reapTimeoutMs so a wedged reap can never block the queue forever.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager, type RunSummary } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_reap", model: "claude-test" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_reap", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

/**
 * Records every exec. Claude invocations either complete with the fixture
 * transcript, block until abort, or hang until released (a wedged /
 * TERM-ignoring agent — the case the reap exists for). The pgid SIGKILL
 * exec can likewise be made to hang to exercise the reap timeout.
 */
class ReapDriver extends FakeVmDriver {
  execs: Array<{ cmd: string[]; opts?: ExecOptions }> = [];
  claudeSeen: () => void = () => {};
  private claudeGate = new Promise<void>((resolve) => {
    this.claudeSeen = resolve;
  });
  private releases: Array<() => void> = [];

  constructor(
    private readonly mode: {
      hangClaude?: boolean;
      hangKill?: boolean;
      completeClaude?: boolean;
    } = {},
  ) {
    super();
  }

  /** Let every hung exec settle (test cleanup only). */
  releaseAll(): void {
    for (const release of this.releases.splice(0)) release();
  }

  private hang(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.releases.push(resolve);
    });
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ cmd, opts });
    if (cmd[0] !== "claude" && cmd.join(" ").includes("kill -KILL")) {
      // The reap's pgid SIGKILL exec.
      if (this.mode.hangKill) await this.hang();
      return { exitCode: 0 };
    }
    if (cmd[0] === "claude") {
      this.claudeSeen();
      if (this.mode.completeClaude) {
        for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
        return { exitCode: 0 };
      }
      if (this.mode.hangClaude) await this.hang();
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) resolve();
        else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { exitCode: 130 };
    }
    return super.exec(handle, cmd, opts);
  }

  claudeExecs(): Array<{ cmd: string[]; opts?: ExecOptions }> {
    return this.execs.filter((call) => call.cmd[0] === "claude");
  }

  killExecIndex(pgidFile: string): number {
    return this.execs.findIndex(
      (call) =>
        call.cmd[0] !== "claude" &&
        call.cmd.includes(pgidFile) &&
        call.cmd.join(" ").includes("kill -KILL"),
    );
  }

  async waitForClaude(timeoutMs = 5000): Promise<void> {
    await Promise.race([
      this.claudeGate,
      sleep(timeoutMs).then(() => {
        throw new Error("timed out waiting for the claude exec");
      }),
    ]);
  }

  async waitForClaudeCount(count: number, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.claudeExecs().length >= count) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} claude execs`);
      await sleep(25);
    }
  }
}

function managerWith(
  driver: ReapDriver,
  opts: { reapTimeoutMs?: number } = {},
): RuntimeManager {
  return new RuntimeManager({
    vm: new VmManager({ customDriver: driver }),
    router: null,
    // Keep the grace timer out of these tests: the startNext reap path is
    // what is under test, and the timer is unref'd so it cannot hold the
    // test process open.
    killGraceMs: 60_000,
    reapTimeoutMs: opts.reapTimeoutMs,
  });
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

test("cancel reaps the run's process group before the successor's harness spawns", async () => {
  const driver = new ReapDriver({ hangClaude: true });
  const manager = managerWith(driver);
  const userId = "u-reap-before-successor";
  try {
    const first = manager.start(userId, { prompt: "do a slow thing" });
    assert.equal(first.accepted, true);
    await driver.waitForClaude();

    const second = manager.start(userId, { prompt: "next thing" });
    assert.equal(second.accepted, true);
    assert.equal(second.queued, true);

    manager.cancel(userId, first.runId);
    assert.equal(manager.list(userId).find((run) => run.runId === first.runId)?.status, "cancelled");

    // The successor's harness must spawn only after the reap.
    await driver.waitForClaudeCount(2);
    const expectedPgidFile = `/tmp/.swarm-exec-${first.runId}.pgid`;
    const killIndex = driver.killExecIndex(expectedPgidFile);
    assert.ok(killIndex >= 0, "expected a pgid SIGKILL reap exec for the cancelled run");
    const successorClaudeIndex = driver.execs.indexOf(driver.claudeExecs()[1]);
    assert.ok(
      killIndex < successorClaudeIndex,
      "the reap must complete before the successor's harness spawns",
    );
    assert.equal(manager.list(userId).find((run) => run.runId === second.runId)?.status, "running");
  } finally {
    try {
      manager.cancel(userId, second.runId);
    } catch {
      /* already finished */
    }
    driver.releaseAll();
  }
});

test("a wedged reap times out and the successor still starts", async () => {
  const driver = new ReapDriver({ hangClaude: true, hangKill: true });
  const manager = managerWith(driver, { reapTimeoutMs: 250 });
  const userId = "u-reap-timeout";
  try {
    const first = manager.start(userId, { prompt: "do a slow thing" });
    assert.equal(first.accepted, true);
    await driver.waitForClaude();

    const second = manager.start(userId, { prompt: "next thing" });
    assert.equal(second.queued, true);

    manager.cancel(userId, first.runId);

    // The reap was attempted (kill exec recorded) but never settles; the
    // successor must still start once reapTimeoutMs elapses.
    await driver.waitForClaudeCount(2);
    const expectedPgidFile = `/tmp/.swarm-exec-${first.runId}.pgid`;
    const killIndex = driver.killExecIndex(expectedPgidFile);
    assert.ok(killIndex >= 0, "expected the reap to be attempted");
    const successorClaudeIndex = driver.execs.indexOf(driver.claudeExecs()[1]);
    assert.ok(killIndex < successorClaudeIndex, "the reap attempt precedes the successor spawn");
    assert.equal(manager.list(userId).find((run) => run.runId === second.runId)?.status, "running");
  } finally {
    try {
      manager.cancel(userId, second.runId);
    } catch {
      /* already finished */
    }
    driver.releaseAll();
  }
});

test("a normal finish does not reap before the successor starts", async () => {
  const driver = new ReapDriver({ completeClaude: true });
  const manager = managerWith(driver);
  const userId = "u-reap-normal-finish";

  const first = manager.start(userId, { prompt: "first" });
  assert.equal(first.accepted, true);
  const second = manager.start(userId, { prompt: "second" });
  assert.equal(second.accepted, true);

  const firstRun = await waitForRun(manager, userId, first.runId);
  assert.equal(firstRun.status, "finished");
  const secondRun = await waitForRun(manager, userId, second.runId);
  assert.equal(secondRun.status, "finished");

  // No pgid SIGKILL exec anywhere: reaping is a cancel-path behavior only.
  for (const call of driver.execs) {
    assert.ok(
      !call.cmd.join(" ").includes("kill -KILL"),
      `no reap exec expected on a normal finish: ${call.cmd.join(" ")}`,
    );
    assert.ok(
      call.cmd[0] === "claude" || !call.cmd.some((arg) => arg.includes(".pgid")),
      `no pgid exec expected on a normal finish: ${call.cmd.join(" ")}`,
    );
  }
});
