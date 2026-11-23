/**
 * Bug 26 — per-run role escalation policy, end to end through RuntimeManager.
 *
 * The agent's `set_role` calls are replayed as real stream-json tool_use
 * blocks. The authoritative `onRoleSwitch` must:
 *  - reject a researcher -> deployer escalation unless the user approves it,
 *  - resume the run under the new role when the user does approve,
 *  - admit a subset switch without asking,
 *  - admit a pre-granted role without asking,
 *  - never widen beyond the roles the user's catalog actually contains.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager, type RunSummary } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import { FAKE_CLAUDE_TRANSCRIPT_LINES } from "../vm/fake-claude";
import { ApprovalStore, setApprovalStoreForTesting, type PendingApproval } from "../harness/approvals";
import { telemetryBus } from "../telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SESSION_ID = "sess_role_policy";

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

function managerWith(driver: ScriptedDriver): RuntimeManager {
  return new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router: null });
}

async function waitFor<T>(read: () => T | undefined, what: string, steps = 500): Promise<T> {
  for (let i = 0; i < steps; i++) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForRun(manager: RuntimeManager, userId: string, runId: string): Promise<RunSummary> {
  return waitFor(
    () => {
      const run = manager.list(userId).find((candidate) => candidate.runId === runId);
      return run && run.status !== "running" && run.status !== "queued" ? run : undefined;
    },
    "run to finish",
  );
}

/** The bus republishes harness events flat: {type, ...payload}. */
interface RunEvent {
  type: string;
  approval?: unknown;
  from?: { id: string; name: string };
  to?: { id: string; name: string };
  [key: string]: unknown;
}

function eventsFor(runId: string): RunEvent[] {
  const events: RunEvent[] = [];
  telemetryBus.subscribe(runId, 0, (event) => events.push(event as unknown as RunEvent));
  return events;
}

function pendingRoleApproval(events: readonly RunEvent[]): PendingApproval | undefined {
  for (const event of events) {
    if (event.type !== "approval.required") continue;
    const approval = event.approval as PendingApproval | undefined;
    // Events are already scoped to one run's bus; the card payload omits the
    // runId, so match on kind alone.
    if (approval?.kind === "role_escalation") return approval;
  }
  return undefined;
}

test("researcher -> deployer is rejected when the user does not approve", async () => {
  const store = new ApprovalStore({ ttlMs: 5_000 });
  setApprovalStoreForTesting(store);
  try {
    const driver = new ScriptedDriver(() => ({ lines: [INIT_LINE, switchLine("deployer")], exitCode: 0 }));
    const manager = managerWith(driver);
    const started = manager.start("alice", { prompt: "ship it", roleId: "researcher" });
    assert.equal(started.accepted, true);
    const events = eventsFor(started.runId);

    const approval = await waitFor(
      () => pendingRoleApproval(events),
      "role escalation approval",
    );
    assert.equal(approval.kind, "role_escalation");
    assert.equal(approval.fromRole?.id, "researcher");
    assert.equal(approval.toRole?.id, "deployer");
    assert.ok((approval.addedPermissions ?? []).includes("allowBash"));
    assert.ok((approval.addedTools ?? []).includes("bash"));
    assert.ok((approval.addedMcpServers ?? []).includes("github-mcp"));

    store.resolve(approval.id, "denied");
    await waitForRun(manager, "alice", started.runId);

    // No restart under the new role: exactly one claude invocation.
    assert.equal(driver.calls.length, 1);
    const types = events.map((event) => event.type);
    assert.ok(!types.includes("role.changed"), "a denied escalation must not change the role");
    assert.ok(types.includes("approval.resolved"));
  } finally {
    setApprovalStoreForTesting(null);
  }
});

test("an approved researcher -> deployer escalation resumes the run as deployer", async () => {
  const store = new ApprovalStore({ ttlMs: 5_000 });
  setApprovalStoreForTesting(store);
  try {
    const driver = new ScriptedDriver((index) =>
      index === 0
        ? { lines: [INIT_LINE, switchLine("deployer")], exitCode: 0 }
        : { lines: [...FAKE_CLAUDE_TRANSCRIPT_LINES], exitCode: 0 },
    );
    const manager = managerWith(driver);
    const started = manager.start("bob", { prompt: "ship it", roleId: "researcher" });
    assert.equal(started.accepted, true);
    const events = eventsFor(started.runId);

    const approval = await waitFor(
      () => pendingRoleApproval(events),
      "role escalation approval",
    );
    store.resolve(approval.id, "approved");

    const run = await waitForRun(manager, "bob", started.runId);
    assert.equal(run.status, "finished");
    assert.equal(driver.calls.length, 2, "the approved switch restarts claude once");

    const second = driver.calls[1];
    assert.ok(second.includes("--resume"), "the new role continues the same conversation");
    assert.equal(second[second.indexOf("--resume") + 1], SESSION_ID);

    const changed = events.find((event) => event.type === "role.changed");
    assert.ok(changed, "role.changed is emitted for an applied switch");
    if (changed && changed.type === "role.changed") {
      assert.equal(changed.from?.id, "researcher");
      assert.equal(changed.to?.id, "deployer");
    }
  } finally {
    setApprovalStoreForTesting(null);
  }
});

test("a subset switch (main -> orchestrator) is allowed without an approval", async () => {
  const store = new ApprovalStore({ ttlMs: 5_000 });
  setApprovalStoreForTesting(store);
  try {
    const driver = new ScriptedDriver((index) =>
      index === 0
        ? { lines: [INIT_LINE, switchLine("orchestrator")], exitCode: 0 }
        : { lines: [...FAKE_CLAUDE_TRANSCRIPT_LINES], exitCode: 0 },
    );
    const manager = managerWith(driver);
    const started = manager.start("carol", { prompt: "research this", roleId: "main" });
    assert.equal(started.accepted, true);
    const events = eventsFor(started.runId);

    const run = await waitForRun(manager, "carol", started.runId);
    assert.equal(run.status, "finished");
    assert.equal(driver.calls.length, 2);
    assert.equal(events.some((event) => event.type === "approval.required"), false);
    assert.equal(events.some((event) => event.type === "role.changed"), true);
  } finally {
    setApprovalStoreForTesting(null);
  }
});

test("a pre-granted broader role is allowed without an approval", async () => {
  const store = new ApprovalStore({ ttlMs: 5_000 });
  setApprovalStoreForTesting(store);
  try {
    const driver = new ScriptedDriver((index) =>
      index === 0
        ? { lines: [INIT_LINE, switchLine("deployer")], exitCode: 0 }
        : { lines: [...FAKE_CLAUDE_TRANSCRIPT_LINES], exitCode: 0 },
    );
    const manager = managerWith(driver);
    const started = manager.start("dana", {
      prompt: "ship it",
      roleId: "researcher",
      grantedRoleIds: ["deployer"],
    });
    assert.equal(started.accepted, true);
    const events = eventsFor(started.runId);

    const run = await waitForRun(manager, "dana", started.runId);
    assert.equal(run.status, "finished");
    assert.equal(driver.calls.length, 2);
    assert.equal(events.some((event) => event.type === "approval.required"), false);
  } finally {
    setApprovalStoreForTesting(null);
  }
});

test("a pre-grant the user's catalog does not contain is ignored", async () => {
  const store = new ApprovalStore({ ttlMs: 5_000 });
  setApprovalStoreForTesting(store);
  try {
    const driver = new ScriptedDriver(() => ({
      lines: [INIT_LINE, switchLine("no-such-role")],
      exitCode: 0,
    }));
    const manager = managerWith(driver);
    const started = manager.start("erin", {
      prompt: "escalate",
      roleId: "researcher",
      grantedRoleIds: ["no-such-role"],
    });
    assert.equal(started.accepted, true);
    const events = eventsFor(started.runId);

    await waitForRun(manager, "erin", started.runId);
    assert.equal(driver.calls.length, 1);
    assert.equal(events.some((event) => event.type === "approval.required"), false);
    assert.equal(events.some((event) => event.type === "role.changed"), false);
  } finally {
    setApprovalStoreForTesting(null);
  }
});
