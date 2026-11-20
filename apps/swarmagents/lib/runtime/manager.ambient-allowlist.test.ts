import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

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

test("a tool outside the ambient allowlist is blocked before it runs", async () => {
  const driver = new HoldDriver();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });
  const started = manager.start("user_allow", {
    prompt: "watch the hook",
    roleId: "main",
    fullAuto: true,
    toolAllowlist: ["Read"],
    ambientRuleId: "hook1",
  });
  assert.equal(started.accepted, true);
  for (let i = 0; i < 100 && !manager.isActiveRun("user_allow", started.runId); i++) await sleep(10);
  assert.equal(manager.isActiveRun("user_allow", started.runId), true);

  const denied = await manager.requestToolApproval("user_allow", started.runId, "Bash", { command: "ls" });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason ?? "", /allowlist/);

  const permitted = await manager.requestToolApproval("user_allow", started.runId, "Read", {
    file_path: "/workspace/note.txt",
  });
  assert.equal(permitted.decision, "allow");

  driver.release();
});
