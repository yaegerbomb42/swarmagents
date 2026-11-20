// Team Mode — lane safety parity with the runtime (lib/runtime/manager.ts).
//
// A lane is a run of its own: it must obey the same approval gate, the same
// env scrubbing and the same provider policy as a normal run. These tests
// drive the real ClaudeCodeRunner over the fake VM, so the risk classifier,
// the approval store and the provider router are the production ones.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ApprovalStore, getApprovalStore, setApprovalStoreForTesting } from "../harness/approvals";
import type { TelemetryEvent as HarnessEvent } from "../harness/types";
import { createRouter, updateUserSettings, writeConfiguredProviders } from "../providers";
import { FAKE_CLAUDE_APPROVAL_TRIGGER } from "../vm/fake-claude";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import { VmManager } from "../vm/manager";
import { VmTeamHarness, workerRole } from "./harness";
import { LaneSpendLedger, setLaneSpendLedgerForTesting } from "./lane-policy";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await delay(5);
  }
}

/** The fake VM with every exec recorded (argv + the env handed to the child). */
class RecordingDriver extends FakeVmDriver {
  readonly execs: { cmd: string[]; env?: Record<string, string> }[] = [];

  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ cmd: [...cmd], env: opts?.env ? { ...opts.env } : undefined });
    return super.exec(handle, cmd, opts);
  }
}

/** The claude invocations (not the mkdir/cat housekeeping execs). */
function claudeExecs(driver: RecordingDriver): { cmd: string[]; env?: Record<string, string> }[] {
  return driver.execs.filter((exec) => {
    const prog = exec.cmd[0]?.split("/").pop();
    return prog === "claude";
  });
}

function laneSpec(userId: string, runId: string, prompt: string) {
  return {
    runId,
    userId,
    agentId: "a1",
    role: workerRole(0),
    prompt,
    cwd: `/workspace/team/${runId}/a1`,
    onEvent: () => {},
  };
}

let dataDir = "";

before(() => {
  // The provider store keeps the user's settings and providers here.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-team-lane-"));
  process.env.SWARM_HOME = dataDir;
  setLaneSpendLedgerForTesting(new LaneSpendLedger());
});

after(() => {
  setApprovalStoreForTesting(null);
  setLaneSpendLedgerForTesting(null);
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a risky command in a lane is blocked until the user approves it", async () => {
  const userId = "lane-approval-user";
  setApprovalStoreForTesting(new ApprovalStore({ ttlMs: 60_000 }));
  const driver = new RecordingDriver();
  const vm = new VmManager({ customDriver: driver });
  const harness = new VmTeamHarness({ vm, routerForUser: () => null });
  const events: HarnessEvent[] = [];

  const lane = harness.lane({
    ...laneSpec(userId, "team_approval", `Clean up the sandbox root by running ${FAKE_CLAUDE_APPROVAL_TRIGGER} on it.`),
    onEvent: (event) => events.push(event),
  });

  await waitFor(() => events.some((event) => event.type === "approval.required"));
  const request = events.find((event) => event.type === "approval.required");
  assert.ok(request && request.type === "approval.required", "the lane must ask for approval");
  assert.equal(request.approval.tool, "Bash");
  assert.match(request.approval.action, /rm -rf \//);

  const store = getApprovalStore();
  const pending = store.get(request.approval.id);
  assert.equal(pending?.status, "pending");
  assert.equal(pending?.userId, userId);
  assert.equal(pending?.runId, "team_approval");

  // The flagged command must not run while nobody has decided.
  let settled = false;
  void lane.then(() => {
    settled = true;
  });
  await delay(50);
  assert.equal(settled, false, "the lane stays blocked until the approval is decided");

  store.resolve(request.approval.id, "approved");
  const result = await lane;
  assert.equal(result.ok, true, "an approved lane finishes normally");
  assert.equal(store.get(request.approval.id)?.status, "approved");
});

test("a denied approval halts the lane", async () => {
  const userId = "lane-deny-user";
  setApprovalStoreForTesting(new ApprovalStore({ ttlMs: 60_000 }));
  const driver = new RecordingDriver();
  const vm = new VmManager({ customDriver: driver });
  const harness = new VmTeamHarness({ vm, routerForUser: () => null });
  const events: HarnessEvent[] = [];

  const lane = harness.lane({
    ...laneSpec(userId, "team_deny", `Clean up the sandbox root by running ${FAKE_CLAUDE_APPROVAL_TRIGGER} on it.`),
    onEvent: (event) => events.push(event),
  });

  await waitFor(() => events.some((event) => event.type === "approval.required"));
  const request = events.find((event) => event.type === "approval.required");
  assert.ok(request && request.type === "approval.required");

  getApprovalStore().resolve(request.approval.id, "denied");
  const result = await lane;
  assert.equal(result.ok, false, "a denied lane must not report success");
  assert.match(result.error ?? "", /approval denied by user/i);
});

test("the lane env carries no host credentials", async () => {
  const userId = "lane-env-user";
  const previous = { ...process.env };
  try {
    // A planted host secret: the name passes the runner env allowlist, so
    // only the credential scrub can keep it out of the lane.
    process.env.ANTHROPIC_API_KEY = "sk-host-key";
    process.env.ANTHROPIC_FAKE_SECRET = "fake-secret-value";
    process.env.FAKE_SECRET = "fake-secret-value";

    const driver = new RecordingDriver();
    const vm = new VmManager({ customDriver: driver });
    const router = createRouter({
      providers: [
        { id: "gateway-1", kind: "openai", keys: ["sk-provider-key"], models: { balanced: "gpt-test" } },
      ],
    });
    const harness = new VmTeamHarness({ vm, routerForUser: () => router });

    const result = await harness.lane(laneSpec(userId, "team_env", "Write the summary file."));
    assert.equal(result.ok, true);

    const exec = claudeExecs(driver)[0];
    assert.ok(exec, "the lane must have run claude");
    const env = exec.env ?? {};
    assert.equal(env.ANTHROPIC_FAKE_SECRET, undefined, "a planted host secret must not reach the lane");
    assert.equal(env.FAKE_SECRET, undefined, "no host secret may reach the lane");
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "the host provider key must not reach the lane");
    assert.equal(
      env.ANTHROPIC_AUTH_TOKEN,
      "sk-provider-key",
      "the lane runs with the provider's own key",
    );
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("a paid provider is never used when allowPaidProviders is off", async () => {
  const userId = "lane-paid-user";
  updateUserSettings(userId, { allowPaidProviders: false });

  const driver = new RecordingDriver();
  const vm = new VmManager({ customDriver: driver });
  const router = createRouter({
    providers: [{ id: "paid-1", kind: "openai", keys: ["sk-paid"], models: { balanced: "gpt-test" } }],
  });
  const harness = new VmTeamHarness({ vm, routerForUser: () => router });

  const result = await harness.lane(laneSpec(userId, "team_paid", "Do the task."));
  assert.equal(result.ok, false, "the lane must not run on a paid provider");
  assert.match(result.error ?? "", /allowPaidProviders/);
  assert.equal(claudeExecs(driver).length, 0, "no claude run may happen on a paid provider");
});

test("a free provider is still used when allowPaidProviders is off", async () => {
  const userId = "lane-free-user";
  updateUserSettings(userId, { allowPaidProviders: false });
  writeConfiguredProviders(userId, [
    { id: "free-1", kind: "openai", isFree: true, keys: ["sk-free"], models: { balanced: "gpt-test" } },
  ]);

  const driver = new RecordingDriver();
  const vm = new VmManager({ customDriver: driver });
  const router = createRouter({
    providers: [
      { id: "free-1", kind: "openai", isFree: true, keys: ["sk-free"], models: { balanced: "gpt-test" } },
    ],
  });
  const harness = new VmTeamHarness({ vm, routerForUser: () => router });

  const result = await harness.lane(laneSpec(userId, "team_free", "Do the task."));
  assert.equal(result.ok, true);
  assert.equal(result.provider, "free-1");
  assert.equal(claudeExecs(driver).length, 1);
});

test("a lane stops using a paid provider once the run budget is spent", async () => {
  const userId = "lane-budget-user";
  // The recorded transcript costs $0.001, so a $0.0005 run budget is spent by
  // the first lane.
  updateUserSettings(userId, { allowPaidProviders: true, perRunBudgetUsd: 0.0005 });

  const driver = new RecordingDriver();
  const vm = new VmManager({ customDriver: driver });
  const router = createRouter({
    providers: [{ id: "paid-1", kind: "openai", keys: ["sk-paid"], models: { balanced: "gpt-test" } }],
  });
  const harness = new VmTeamHarness({ vm, routerForUser: () => router });

  const first = await harness.lane(laneSpec(userId, "team_budget", "Do the task."));
  assert.equal(first.ok, true);
  assert.equal(first.costUsd, 0.001);

  const second = await harness.lane(laneSpec(userId, "team_budget", "Do the task."));
  assert.equal(second.ok, false, "the run budget must stop the next lane");
  assert.match(second.error ?? "", /budget/i);
});
