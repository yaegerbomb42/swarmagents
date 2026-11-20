/**
 * General improvement (b) — the run's history keeps the user's original
 * prompt after a role switch: the phase continuation prompt is what claude
 * is resumed with, but RunSummary must still show the ask.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager, type RunSummary } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { FAKE_CLAUDE_TRANSCRIPT_LINES } from "../vm/fake-claude";
import { ApprovalStore, setApprovalStoreForTesting } from "../harness/approvals";
import { telemetryBus, type SequencedEvent } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SESSION_ID = "sess_initial_prompt";

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  model: "m1",
});

function switchLine(toRoleId: string, id = "toolu_switch_1"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: `msg_${id}`,
      role: "assistant",
      model: "m1",
      content: [
        {
          type: "tool_use",
          id,
          name: "mcp__roles__set_role",
          input: { role_id: toRoleId, reason: "task needs it" },
        },
      ],
    },
  });
}

interface ClaudeBehavior {
  lines: string[];
  exitCode: number;
}

class ScriptedDriver extends FakeVmDriver {
  calls: string[][] = [];

  constructor(private readonly behavior: (callIndex: number) => ClaudeBehavior) {
    super();
  }

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    const index = this.calls.length;
    this.calls.push(cmd);
    const { lines, exitCode } = this.behavior(index);
    if (opts?.signal?.aborted) return { exitCode: 130 };
    for (const line of lines) opts?.onStdout?.(`${line}\n`);
    return { exitCode };
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

test("history keeps the original prompt after a role switch", async () => {
  const store = new ApprovalStore({ ttlMs: 5_000 });
  setApprovalStoreForTesting(store);
  try {
    const driver = new ScriptedDriver((index) =>
      index === 0
        ? { lines: [INIT_LINE, switchLine("researcher")], exitCode: 0 }
        : { lines: [...FAKE_CLAUDE_TRANSCRIPT_LINES], exitCode: 0 },
    );
    const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });
    const events: SequencedEvent[] = [];
    const started = manager.start("erin", { prompt: "research this", roleId: "main" });
    assert.equal(started.accepted, true);
    telemetryBus.subscribe(started.runId, 0, (event) => events.push(event));

    const run = await waitForRun(manager, "erin", started.runId);
    assert.equal(run.status, "finished");
    assert.equal(driver.calls.length, 2, "expected two phases: switch, then resume");
    // The switch actually happened (otherwise this test is vacuous).
    assert.equal(events.some((event) => event.type === "role.changed"), true);
    // The resumed phase got the continuation prompt, not the original ask.
    assert.ok(
      driver.calls[1].join(" ").includes("[role switch]"),
      "the second phase must resume with the continuation prompt",
    );
    // ...but the recorded history still shows the user's original prompt.
    assert.equal(run.prompt, "research this");
  } finally {
    setApprovalStoreForTesting(null);
  }
});
