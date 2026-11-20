/**
 * Runtime #6 (cancel backstop kills only the run's own process group) and
 * #11 (a cancelled run stays "cancelled" when its attempt then fails).
 *
 * The agent exec runs in its own session with its pgid recorded in a
 * per-run marker file; the cancel backstop must SIGKILL that group — never
 * `pkill -KILL -P 1`, which kills the desktop session in desktop VMs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager, type RunSummary } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { telemetryBus, type SequencedEvent } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Records every exec; the claude invocation blocks until its signal aborts. */
class BlockingDriver extends FakeVmDriver {
  execs: Array<{ cmd: string[]; opts?: ExecOptions }> = [];
  claudeSeen: () => void = () => {};
  private claudeGate = new Promise<void>((resolve) => {
    this.claudeSeen = resolve;
  });

  /**
   * When true, the claude exec never settles even after abort — a wedged /
   * TERM-ignoring agent. That is the case the cancel backstop exists for:
   * a clean unwind clears the cancelling record in execute()'s finally.
   */
  constructor(private readonly hang: boolean = false) {
    super();
  }

  private hangRelease: () => void = () => {};

  /** Let a hung claude exec settle (test cleanup only). */
  releaseHung(): void {
    this.hangRelease();
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ cmd, opts });
    if (cmd[0] === "claude") {
      this.claudeSeen();
      if (this.hang) {
        // Never settle: the run's execute() never completes, so the grace
        // timer's killRunTree must fire. Released by releaseHung() in the
        // test's finally so the quota timer does not hold the process open.
        await new Promise<void>((resolve) => {
          this.hangRelease = resolve;
        });
      }
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) resolve();
        else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { exitCode: 130 };
    }
    return super.exec(handle, cmd, opts);
  }

  async waitForClaude(timeoutMs = 5000): Promise<void> {
    await Promise.race([
      this.claudeGate,
      sleep(timeoutMs).then(() => {
        throw new Error("timed out waiting for the claude exec");
      }),
    ]);
  }

  async waitForExec(
    pred: (call: { cmd: string[]; opts?: ExecOptions }) => boolean,
    timeoutMs = 8000,
  ): Promise<{ cmd: string[]; opts?: ExecOptions }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.execs.find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("timed out waiting for exec");
      await sleep(25);
    }
  }
}

function managerWith(driver: BlockingDriver): RuntimeManager {
  return new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });
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

test("cancel backstop kills only the run's recorded process group, never PID 1's children", async () => {
  // The agent exec never settles (wedged / TERM-ignoring): that is the case
  // the backstop exists for — a clean unwind clears the record in
  // execute()'s finally and needs no backstop.
  const driver = new BlockingDriver(true);
  const manager = managerWith(driver);
  const userId = "u-kill-tree";
  const started = manager.start(userId, { prompt: "do a slow thing" });
  assert.equal(started.accepted, true);
  const runId = started.runId;

  await driver.waitForClaude();
  const claudeCall = driver.execs.find((call) => call.cmd[0] === "claude");
  assert.ok(claudeCall, "expected a claude exec");
  const expectedPgidFile = `/tmp/.swarm-exec-${runId}.pgid`;
  assert.equal(
    claudeCall.opts?.pgidFile,
    expectedPgidFile,
    "the agent exec must carry the run's stable pgid marker path",
  );

  manager.cancel(userId, runId);
  // Cancel finalizes synchronously; the backstop fires after KILL_GRACE_MS.
  assert.equal(manager.list(userId).find((run) => run.runId === runId)?.status, "cancelled");
  try {
    const killCall = await driver.waitForExec(
      (call) => call.cmd.includes(expectedPgidFile) && call.cmd[0] !== "claude",
    );
    const script = killCall.cmd.join(" ");
    assert.match(script, /kill -KILL "-\$pgid"/, "the backstop must SIGKILL the recorded group");
    assert.ok(!script.includes("pkill"), "the backstop must never pkill");
    // No exec anywhere in the run may target children of PID 1.
    for (const call of driver.execs) {
      assert.ok(
        !call.cmd.includes("pkill"),
        `no exec may pkill: ${call.cmd.join(" ")}`,
      );
      assert.ok(
        !(call.cmd.includes("-P") && call.cmd.includes("1")),
        `no exec may target PID 1's children: ${call.cmd.join(" ")}`,
      );
    }

    const run = await waitForRun(manager, userId, runId);
    assert.equal(run.status, "cancelled");
  } finally {
    driver.releaseHung();
  }
});

test("a run cancelled mid-attempt stays cancelled when the attempt then fails", async () => {
  const driver = new BlockingDriver();
  const manager = managerWith(driver);
  const userId = "u-cancel-stays";
  const events: SequencedEvent[] = [];
  const started = manager.start(userId, { prompt: "do a failing thing" });
  assert.equal(started.accepted, true);
  telemetryBus.subscribe(started.runId, 0, (event) => events.push(event));

  await driver.waitForClaude();
  // Cancel while the attempt is still in flight; the blocked exec then
  // unwinds with exit 130 (the abort path) instead of succeeding.
  manager.cancel(userId, started.runId);
  const run = await waitForRun(manager, userId, started.runId);
  assert.equal(run.status, "cancelled");

  // No run.error may be published after the run.cancelled event: the
  // durable status must not flip from "cancelled" to "error".
  const cancelledAt = events.findIndex((event) => event.type === "run.cancelled");
  assert.ok(cancelledAt >= 0, "expected a run.cancelled event");
  assert.equal(
    events.slice(cancelledAt + 1).some((event) => event.type === "run.error"),
    false,
    "no run.error may follow run.cancelled",
  );
});
