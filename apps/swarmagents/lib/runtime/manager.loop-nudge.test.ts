import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const CLICK = { x: 412, y: 300 };

/** A claude CLI that clicks the same spot three times (same output), then waits. */
class LoopingCliDriver extends FakeVmDriver {
  release: () => void = () => undefined;
  private readonly held = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    const lines: unknown[] = [{ type: "system", subtype: "init", session_id: "s-loop", model: "m" }];
    for (let i = 0; i < 3; i++) {
      lines.push(
        { type: "assistant", message: { id: `m${i}`, content: [{ type: "tool_use", id: `tu${i}`, name: "mcp__computer__click", input: CLICK }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu${i}`, content: "click done", is_error: false }] } },
      );
    }
    opts?.onStdout?.(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await this.held;
    return { exitCode: 0 };
  }
}

test("loop nudge: after 3 identical clicks the hook denies a 4th try once, with the nudge text", async () => {
  const driver = new LoopingCliDriver();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });
  const started = manager.start("user_loop", { prompt: "click the button", roleId: "main", fullAuto: true });
  assert.equal(started.accepted, true);
  for (let i = 0; i < 100 && !manager.isActiveRun("user_loop", started.runId); i++) await sleep(10);
  await sleep(300); // let the stream reach the runner

  // A different call is not affected (and disarms the nudge: the model moved on).
  const other = await manager.requestToolApproval("user_loop", started.runId, "mcp__computer__click", { x: 10, y: 10 });
  assert.equal(other.decision, "allow");
  driver.release();
});

test("loop nudge: the exact looping call is denied with the nudge, then allowed again", async () => {
  const driver = new LoopingCliDriver();
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });
  const started = manager.start("user_loop2", { prompt: "click the button", roleId: "main", fullAuto: true });
  for (let i = 0; i < 100 && !manager.isActiveRun("user_loop2", started.runId); i++) await sleep(10);
  await sleep(300);

  const denied = await manager.requestToolApproval("user_loop2", started.runId, "mcp__computer__click", { y: 300, x: 412 });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason ?? "", /Loop breaker: .*Do NOT repeat that same call/s);

  const again = await manager.requestToolApproval("user_loop2", started.runId, "mcp__computer__click", CLICK);
  assert.equal(again.decision, "allow", "the nudge is one-shot");
  driver.release();
});
