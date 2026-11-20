// Team Mode — lane-level checkpoint coverage (F1 time travel).
//
// The auto-checkpoint taker is wired into VmTeamHarness.runLane (see
// lib/team/harness.ts): created once per lane invocation, handed to
// evaluateToolApproval through the lane's synchronous approval handler.
// The taker itself is unit tested in lib/runtime/checkpoints.test.ts, but
// nothing exercised the real lane path end to end — team tests use
// FakeHarness, not VmTeamHarness.runLane. These tests drive the real
// VmTeamHarness over the fake VM and simulate the in-VM PreToolUse hook
// POSTing a tool call, the way vm-image/hooks/pre-tool-use.mjs does in
// production.
//
// The fake VM cannot run the hook script, so the tests invoke the same
// lookup the hook endpoint uses (RuntimeManager.requestToolApproval ->
// requestRegisteredApproval) while the lane is live. The hook calls are
// fired from the lane's first event: that proves runLane has registered
// its handler for the running lane, and the fake transcript replays in
// milliseconds, so there is no later moment to fire them from.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ApprovalStore, getApprovalStore, setApprovalStoreForTesting } from "../harness/approvals";
import type { ToolApprovalDecision } from "../harness/tool-approval";
import type { TelemetryEvent as HarnessEvent } from "../harness/types";
import { parseCheckpointVmLabel } from "../runtime/checkpoints";
import { requestRegisteredApproval } from "../runtime/tool-approval-bridge";
import { FAKE_CLAUDE_APPROVAL_TRIGGER } from "../vm/fake-claude";
import { FakeVmDriver } from "../vm/fake-driver";
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

/** Fail fast instead of hanging the suite when a promise never settles. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const RUN_A = "run_11111111-2222-3333-4444-555555555555";
const RUN_B = "run_22222222-3333-4444-5555-666666666666";
const USER_ID = "lane-checkpoint-user";

/** A simulated hook POST: one ask-classified tool call the lane is about to run. */
interface HookCall {
  toolName: string;
  input: unknown;
}

const RISKY_BASH: HookCall = { toolName: "Bash", input: { command: FAKE_CLAUDE_APPROVAL_TRIGGER } };
// Routine ask-classified call (package-manager mutation): a second lane step.
const INSTALL_FLASK: HookCall = { toolName: "Bash", input: { command: "pip install flask" } };

let dataDir = "";
let previousApprovalBaseUrl: string | undefined;
let previousSessionSecret: string | undefined;

before(() => {
  // The provider store keeps the user's settings and providers here.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-team-lane-checkpoints-"));
  process.env.SWARM_HOME = dataDir;
  setLaneSpendLedgerForTesting(new LaneSpendLedger());
  // The lane only registers its synchronous approval handler (and therefore
  // its checkpoint taker) when the VM can reach an approval endpoint and a
  // per-run token can be signed. Neither URL is ever fetched here — the fake
  // VM has no hook script — but runLane needs both configured to take the
  // hook path at all.
  previousApprovalBaseUrl = process.env.SWARM_VM_APPROVAL_BASE_URL;
  previousSessionSecret = process.env.SWARM_SESSION_SECRET;
  process.env.SWARM_VM_APPROVAL_BASE_URL = "http://127.0.0.1:1";
  process.env.SWARM_SESSION_SECRET = "test-secret-for-checkpoint-tests";
});

after(() => {
  setApprovalStoreForTesting(null);
  setLaneSpendLedgerForTesting(null);
  if (previousApprovalBaseUrl === undefined) delete process.env.SWARM_VM_APPROVAL_BASE_URL;
  else process.env.SWARM_VM_APPROVAL_BASE_URL = previousApprovalBaseUrl;
  if (previousSessionSecret === undefined) delete process.env.SWARM_SESSION_SECRET;
  else process.env.SWARM_SESSION_SECRET = previousSessionSecret;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

interface LaneCheckpointRun {
  result: { ok: boolean; error?: string };
  events: HarnessEvent[];
  decisions: ToolApprovalDecision[];
  snapshotLabels: string[];
}

/**
 * Run one real lane over the fake VM, firing the given simulated hook calls
 * the moment the lane starts streaming, and resolving every approval card
 * they open with `verdict`. Returns once the lane and every hook call have
 * settled, so checkpoint events and snapshots are final when it returns.
 */
async function runLaneWithHookCalls(
  runId: string,
  hookCalls: HookCall[],
  verdict: "approved" | "denied",
): Promise<LaneCheckpointRun> {
  setApprovalStoreForTesting(new ApprovalStore({ ttlMs: 60_000 }));
  const vm = new VmManager({ customDriver: new FakeVmDriver() });
  const harness = new VmTeamHarness({ vm, routerForUser: () => null });
  const events: HarnessEvent[] = [];
  const decisions: ToolApprovalDecision[] = [];
  let hookFired = false;
  let hookMissed = false;

  const lanePromise = harness.lane({
    runId,
    userId: USER_ID,
    agentId: "a1",
    role: workerRole(0),
    // The prompt makes the fake claude replay the risky-call transcript, so
    // the lane really is the one whose tool call the hook is gating.
    prompt: `Clean up the sandbox root by running ${FAKE_CLAUDE_APPROVAL_TRIGGER} on it.`,
    cwd: `/workspace/team/${runId}/a1`,
    onEvent: (event) => {
      events.push(event);
      if (!hookFired) {
        hookFired = true;
        for (const call of hookCalls) {
          const decision = requestRegisteredApproval(USER_ID, runId, call.toolName, call.input);
          if (!decision) {
            // The lane's handler was not registered: the hook has nothing to
            // call, so the lane path under test did not take the hook branch.
            hookMissed = true;
            continue;
          }
          void decision.then((resolved) => decisions.push(resolved));
        }
      }
      if (event.type === "approval.required") {
        getApprovalStore().resolve(event.approval.id, verdict);
      }
    },
  });

  // The hook calls settle on their own: the lane never awaits them, so
  // waiting for the lane alone would race the checkpoint telemetry.
  await waitFor(() => hookMissed || decisions.length === hookCalls.length);
  assert.equal(hookMissed, false, "the lane must register its synchronous approval handler");
  const result = await withTimeout(lanePromise, 10_000, "the lane to finish");
  const snapshotLabels = (await vm.listSnapshots(USER_ID)).map((snapshot) => snapshot.label);
  return { result, events, decisions, snapshotLabels };
}

function checkpointEvents(events: HarnessEvent[]) {
  return events.filter((event) => event.type === "checkpoint.created");
}

test("an approved ask in a lane creates a checkpoint before the tool runs", async () => {
  const { result, events, decisions, snapshotLabels } = await runLaneWithHookCalls(RUN_A, [RISKY_BASH], "approved");

  assert.equal(result.ok, true, "an approved lane finishes normally");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.decision, "allow");

  // The approval card is for the same ask-classified call the hook gated.
  const request = events.find((event) => event.type === "approval.required");
  assert.ok(request && request.type === "approval.required", "the lane must ask for approval");
  assert.equal(request.approval.tool, "Bash");
  assert.match(request.approval.action, /rm -rf \//);

  const checkpoints = checkpointEvents(events);
  assert.equal(checkpoints.length, 1, "exactly one checkpoint for one approved ask");
  const checkpoint = checkpoints[0];
  assert.ok(checkpoint && checkpoint.type === "checkpoint.created");
  assert.equal(checkpoint.label, "auto-pre-step-1");
  assert.equal(checkpoint.vmLabel, `${RUN_A}-a1-step-1`);
  assert.equal(checkpoint.stepSeq, 1);
  assert.equal(checkpoint.tool, "Bash");
  assert.deepEqual(parseCheckpointVmLabel(checkpoint.vmLabel), {
    runId: RUN_A,
    laneId: "a1",
    stepSeq: 1,
  });

  // The snapshot itself landed in the VM, under the checkpoint's VM label.
  assert.ok(
    snapshotLabels.includes(`${RUN_A}-a1-step-1`),
    `expected a snapshot labelled ${RUN_A}-a1-step-1, got ${JSON.stringify(snapshotLabels)}`,
  );
});

test("each lane step gets its own checkpoint, counted per lane", async () => {
  const { result, events, decisions, snapshotLabels } = await runLaneWithHookCalls(
    RUN_A,
    [RISKY_BASH, INSTALL_FLASK],
    "approved",
  );

  assert.equal(result.ok, true);
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every((decision) => decision.decision === "allow"));

  const checkpoints = checkpointEvents(events);
  assert.equal(checkpoints.length, 2, "one checkpoint per approved ask");
  const seqs = checkpoints
    .map((event) => (event.type === "checkpoint.created" ? event.stepSeq : -1))
    .sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2], "the lane's per-lane counter counts its own steps");
  const labels = checkpoints
    .map((event) => (event.type === "checkpoint.created" ? event.label : ""))
    .sort();
  assert.deepEqual(labels, ["auto-pre-step-1", "auto-pre-step-2"]);
  assert.ok(snapshotLabels.includes(`${RUN_A}-a1-step-1`));
  assert.ok(snapshotLabels.includes(`${RUN_A}-a1-step-2`));
});

test("a denied ask in a lane creates no checkpoint", async () => {
  const { result, events, decisions, snapshotLabels } = await runLaneWithHookCalls(RUN_B, [RISKY_BASH], "denied");

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.decision, "deny");

  const blocked = events.find((event) => event.type === "tool.blocked");
  assert.ok(blocked, "the denied call must surface as tool.blocked");

  assert.equal(
    checkpointEvents(events).length,
    0,
    "a call that never executes must not snapshot the VM",
  );
  assert.deepEqual(
    snapshotLabels.filter((label) => label.startsWith(`${RUN_B}-`)),
    [],
    "no snapshot may land for the denied run",
  );
  // The lane itself still finishes: the denial applies to the simulated hook
  // call, while the fake transcript replays its fixed outcome regardless.
  assert.equal(result.ok, true);
});
