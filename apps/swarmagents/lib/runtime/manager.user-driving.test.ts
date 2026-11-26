/**
 * core-25b: a user takeover of the live desktop actually pauses A1. The
 * in-VM PreToolUse hook (RuntimeManager.requestToolApproval) holds mutating
 * computer-mcp calls while the user drives and answers the first one after
 * hand-back with the hand-back note — a deny the model reads, not a halt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { clearAllUserDrivingForTests, handbackUserDriving, isUserDriving, setUserDriving } from "./user-driving";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class HoldDriver extends FakeVmDriver {
  release: () => void = () => undefined;
  private readonly held = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    await this.held;
    return { exitCode: 0 };
  }
}

async function activeRun(user: string, opts: { maxWaitMs?: number } = {}) {
  const driver = new HoldDriver();
  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: driver }),
    router: null,
    userDrivingPollMs: 10,
    ...(opts.maxWaitMs !== undefined ? { userDrivingMaxWaitMs: opts.maxWaitMs } : {}),
  });
  const started = manager.start(user, { prompt: "click around", roleId: "main", fullAuto: true });
  assert.equal(started.accepted, true);
  for (let i = 0; i < 100 && !manager.isActiveRun(user, started.runId); i++) await sleep(10);
  assert.equal(manager.isActiveRun(user, started.runId), true);
  return { manager, driver, runId: started.runId };
}

const CLICK = "mcp__computer-mcp__click";
const DESCRIBE = "mcp__computer-mcp__describe_screen";

test.afterEach(() => clearAllUserDrivingForTests());

test("a desktop click waits while the user drives and gets the hand-back note after", async () => {
  const { manager, driver, runId } = await activeRun("user_drive");
  setUserDriving(runId);

  let settled = false;
  const pending = manager.requestToolApproval("user_drive", runId, CLICK, { x: 10, y: 10 }).then((v) => {
    settled = true;
    return v;
  });
  await sleep(80);
  assert.equal(settled, false, "the click is held while the user drives");

  // Read-only inspection is never held.
  const look = await manager.requestToolApproval("user_drive", runId, DESCRIBE, {});
  assert.equal(look.decision, "allow");

  handbackUserDriving(runId);
  const verdict = await pending;
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason ?? "", /User controlled the desktop for \d+s/);
  assert.match(verdict.reason ?? "", /describe_screen/);

  // The note is one-shot: the agent's next click proceeds.
  const next = await manager.requestToolApproval("user_drive", runId, CLICK, { x: 10, y: 10 });
  assert.equal(next.decision, "allow");
  assert.equal(manager.isActiveRun("user_drive", runId), true, "the run was never halted");
  driver.release();
});

test("a takeover that outlasts the wait bound answers with a wait reason and keeps the run", async () => {
  const { manager, driver, runId } = await activeRun("user_long", { maxWaitMs: 50 });
  setUserDriving(runId);
  const verdict = await manager.requestToolApproval("user_long", runId, CLICK, { x: 1, y: 1 });
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason ?? "", /user is controlling the desktop/);
  assert.equal(isUserDriving(runId), true);
  assert.equal(manager.isActiveRun("user_long", runId), true);
  driver.release();
});

test("without a takeover desktop calls are classified as before", async () => {
  const { manager, driver, runId } = await activeRun("user_none");
  const verdict = await manager.requestToolApproval("user_none", runId, CLICK, { x: 5, y: 5 });
  assert.equal(verdict.decision, "allow");
  driver.release();
});
