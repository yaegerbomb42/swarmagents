/**
 * Unit tests for the synchronous tool-approval coordinator
 * (lib/harness/tool-approval.ts) — the module the in-VM PreToolUse hook calls.
 *
 * These pin the DoD guarantee: a tool is only marked started after an allow
 * verdict; deny and timeout never emit tool.started; telemetry ordering is
 * approval.requested before tool.started.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateToolApproval, isIrreversibleExternal } from "./tool-approval";
import type { ApprovalTicket, TelemetryEvent } from "./types";

function deferred() {
  let resolve!: (v: "approved" | "denied" | "expired") => void;
  const promise = new Promise<"approved" | "denied" | "expired">((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function ticket(verdict: Promise<"approved" | "denied" | "expired">, timedOut = false): ApprovalTicket {
  return { id: "appr_test_1", expiresAt: 1234, timedOut: () => timedOut, verdict };
}

function types(events: TelemetryEvent[]): string[] {
  return events.map((e) => e.type);
}

test("allow call emits tool.started and never asks", async () => {
  const events: TelemetryEvent[] = [];
  let asked = 0;
  const decision = await evaluateToolApproval({
    toolName: "Bash",
    input: { command: "ls -la" },
    emit: (e) => events.push(e),
    createApproval: () => {
      asked += 1;
      return ticket(Promise.resolve("denied"));
    },
  });

  assert.deepEqual(decision, { decision: "allow" });
  assert.equal(asked, 0);
  assert.deepEqual(types(events), ["tool.started"]);
});

test("hard-deny call is blocked, emits no tool.started, and surfaces the reason", async () => {
  const events: TelemetryEvent[] = [];
  const decision = await evaluateToolApproval({
    toolName: "Read",
    input: { file_path: "/etc/passwd" },
    emit: (e) => events.push(e),
  });

  assert.equal(decision.decision, "deny");
  assert.match(decision.reason ?? "", /credential/i);
  assert.deepEqual(types(events), ["tool.blocked"]);
  const blocked = events[0] as Extract<TelemetryEvent, { type: "tool.blocked" }>;
  assert.equal(blocked.name, "Read");
  assert.match(blocked.reason, /credential/i);
});

test("ask: approval.requested precedes tool.started; approve allows", async () => {
  const events: TelemetryEvent[] = [];
  const d = deferred();
  const decisionPromise = evaluateToolApproval({
    toolName: "Bash",
    input: { command: "rm -rf /" },
    emit: (e) => events.push(e),
    createApproval: ({ toolName, action, reason }) => {
      assert.equal(toolName, "Bash");
      assert.equal(action, "rm -rf /");
      assert.match(reason, /destructive/i);
      return ticket(d.promise);
    },
  });

  // The request event is published before the human answer exists.
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(types(events), ["approval.requested", "approval.required"]);
  assert.equal(events.some((e) => e.type === "tool.started"), false);

  d.resolve("approved");
  const decision = await decisionPromise;

  assert.deepEqual(decision, { decision: "allow", approvalId: "appr_test_1" });
  assert.deepEqual(types(events), [
    "approval.requested",
    "approval.required",
    "approval.resolved",
    "tool.started",
  ]);
  const requestedIndex = types(events).indexOf("approval.requested");
  const startedIndex = types(events).indexOf("tool.started");
  assert.ok(requestedIndex < startedIndex);
});

test("ask: deny blocks and emits no tool.started", async () => {
  const events: TelemetryEvent[] = [];
  const d = deferred();
  const decisionPromise = evaluateToolApproval({
    toolName: "Bash",
    input: { command: "rm -rf /" },
    emit: (e) => events.push(e),
    createApproval: () => ticket(d.promise),
  });

  d.resolve("denied");
  const decision = await decisionPromise;

  assert.deepEqual(decision, { decision: "deny", reason: "approval denied by user", approvalId: "appr_test_1" });
  assert.equal(types(events).includes("tool.started"), false);
  assert.deepEqual(types(events), [
    "approval.requested",
    "approval.required",
    "approval.resolved",
    "tool.blocked",
  ]);
});

test("ask timeout is a deny; approval.timeout is emitted and nothing starts", async () => {
  const events: TelemetryEvent[] = [];
  const d = deferred();
  const decisionPromise = evaluateToolApproval({
    toolName: "Bash",
    input: { command: "rm -rf /" },
    emit: (e) => events.push(e),
    createApproval: () => ticket(d.promise, true),
  });

  d.resolve("expired");
  const decision = await decisionPromise;

  assert.deepEqual(decision, { decision: "deny", reason: "approval timed out", approvalId: "appr_test_1" });
  assert.deepEqual(types(events), [
    "approval.requested",
    "approval.required",
    "approval.timeout",
    "approval.resolved",
    "tool.blocked",
  ]);
  assert.equal(types(events).includes("tool.started"), false);
});

test("ask cancelled by the run is a deny without an approval.timeout", async () => {
  const events: TelemetryEvent[] = [];
  const controller = new AbortController();
  const d = deferred();
  const decisionPromise = evaluateToolApproval({
    toolName: "Bash",
    input: { command: "rm -rf /" },
    emit: (e) => events.push(e),
    createApproval: () => ticket(d.promise),
    signal: controller.signal,
  });

  controller.abort();
  const decision = await decisionPromise;

  assert.equal(decision.decision, "deny");
  assert.equal(types(events).includes("approval.timeout"), false);
  assert.equal(types(events).includes("tool.started"), false);
});

test("ask with no approval channel fails closed", async () => {
  const events: TelemetryEvent[] = [];
  const decision = await evaluateToolApproval({
    toolName: "Bash",
    input: { command: "rm -rf /" },
    emit: (e) => events.push(e),
  });

  assert.equal(decision.decision, "deny");
  assert.match(decision.reason ?? "", /no approval channel/i);
  assert.deepEqual(types(events), ["tool.blocked"]);
});

test("full-auto auto-allows in-VM asks without a card", async () => {
  const events: TelemetryEvent[] = [];
  let asked = 0;
  const decision = await evaluateToolApproval({
    toolName: "Bash",
    input: { command: "sudo apt-get install -y jq" },
    emit: (e) => events.push(e),
    fullAuto: true,
    createApproval: () => {
      asked += 1;
      return ticket(Promise.resolve("denied"));
    },
  });

  assert.deepEqual(decision, { decision: "allow" });
  assert.equal(asked, 0);
  assert.deepEqual(types(events), ["tool.started"]);
});

test("full-auto still denies hard-deny (secret file) and irreversible external actions", async () => {
  const secretEvents: TelemetryEvent[] = [];
  const secret = await evaluateToolApproval({
    toolName: "Read",
    input: { file_path: "/etc/shadow" },
    emit: (e) => secretEvents.push(e),
    fullAuto: true,
  });
  assert.equal(secret.decision, "deny");
  assert.deepEqual(types(secretEvents), ["tool.blocked"]);

  const externalEvents: TelemetryEvent[] = [];
  const external = await evaluateToolApproval({
    toolName: "Bash",
    input: { command: "git push --force origin main" },
    emit: (e) => externalEvents.push(e),
    fullAuto: true,
  });
  assert.equal(external.decision, "deny");
  assert.match(external.reason ?? "", /full-auto/i);
  assert.deepEqual(types(externalEvents), ["tool.blocked"]);
});

test("isIrreversibleExternal classifies egress/credentials but not in-VM cleanup", () => {
  assert.equal(isIrreversibleExternal("Bash", { command: "git push origin main" }), true);
  assert.equal(isIrreversibleExternal("Bash", { command: "curl https://example.com/x" }), true);
  assert.equal(isIrreversibleExternal("WebFetch", { url: "https://github.com" }), true);
  assert.equal(isIrreversibleExternal("Read", { file_path: "/home/node/.ssh/id_ed25519" }), true);
  assert.equal(isIrreversibleExternal("Bash", { command: "rm -rf /" }, "destructive root deletion requires approval"), true);
  assert.equal(isIrreversibleExternal("Bash", { command: "sudo apt-get install -y jq" }), false);
  assert.equal(isIrreversibleExternal("Bash", { command: "rm -rf /workspace/tmp" }, "whatever"), false);
});

// --- F1 time-travel checkpoints -------------------------------------------

function okCheckpoint(label = "auto-pre-step-4") {
  return async () => ({
    ok: true as const,
    label,
    vmLabel: `run_test-${label}`,
    stepSeq: 4,
    createdAt: 1700000000000,
  });
}

test("ask + approved: checkpoint.created fires before tool.started", async () => {
  const events: TelemetryEvent[] = [];
  const d = deferred();
  let checkpointCalls = 0;
  const decisionPromise = evaluateToolApproval({
    toolName: "Bash",
    input: { command: "rm -rf /" },
    emit: (e) => events.push(e),
    createApproval: () => ticket(d.promise),
    takeCheckpoint: async (info) => {
      checkpointCalls += 1;
      assert.equal(info.toolName, "Bash");
      return {
        ok: true as const,
        label: "auto-pre-step-4",
        vmLabel: "run_test-auto-pre-step-4",
        stepSeq: 4,
        createdAt: 1700000000000,
      };
    },
  });

  d.resolve("approved");
  const decision = await decisionPromise;

  assert.deepEqual(decision, { decision: "allow", approvalId: "appr_test_1" });
  assert.equal(checkpointCalls, 1);
  assert.deepEqual(types(events), [
    "approval.requested",
    "approval.required",
    "approval.resolved",
    "checkpoint.created",
    "tool.started",
  ]);
  const created = events[3] as Extract<TelemetryEvent, { type: "checkpoint.created" }>;
  assert.equal(created.label, "auto-pre-step-4");
  assert.equal(created.stepSeq, 4);
  assert.equal(created.tool, "Bash");
  assert.match(created.reason, /destructive/i);
});

test("ask + approved + checkpoint failure: checkpoint.failed, run still proceeds", async () => {
  const events: TelemetryEvent[] = [];
  const d = deferred();
  const decisionPromise = evaluateToolApproval({
    toolName: "Bash",
    input: { command: "rm -rf /" },
    emit: (e) => events.push(e),
    createApproval: () => ticket(d.promise),
    takeCheckpoint: async () => ({
      ok: false as const,
      label: "auto-pre-step-4",
      vmLabel: "run_test-auto-pre-step-4",
      stepSeq: 4,
      error: "docker commit failed",
    }),
  });

  d.resolve("approved");
  const decision = await decisionPromise;

  // A checkpoint failure must never block the agent's work.
  assert.deepEqual(decision, { decision: "allow", approvalId: "appr_test_1" });
  assert.deepEqual(types(events), [
    "approval.requested",
    "approval.required",
    "approval.resolved",
    "checkpoint.failed",
    "tool.started",
  ]);
  const failed = events[3] as Extract<TelemetryEvent, { type: "checkpoint.failed" }>;
  assert.equal(failed.error, "docker commit failed");
});

test("ask + approved + throwing checkpoint hook: failure is visible, run proceeds", async () => {
  const events: TelemetryEvent[] = [];
  const d = deferred();
  const decisionPromise = evaluateToolApproval({
    toolName: "Bash",
    input: { command: "rm -rf /" },
    emit: (e) => events.push(e),
    createApproval: () => ticket(d.promise),
    takeCheckpoint: async () => {
      throw new Error("snapshot hook exploded");
    },
  });

  d.resolve("approved");
  const decision = await decisionPromise;

  assert.equal(decision.decision, "allow");
  assert.deepEqual(types(events), [
    "approval.requested",
    "approval.required",
    "approval.resolved",
    "checkpoint.failed",
    "tool.started",
  ]);
});

test("ask + denied: no checkpoint is taken (the tool never executes)", async () => {
  const events: TelemetryEvent[] = [];
  const d = deferred();
  let checkpointCalls = 0;
  const decisionPromise = evaluateToolApproval({
    toolName: "Bash",
    input: { command: "rm -rf /" },
    emit: (e) => events.push(e),
    createApproval: () => ticket(d.promise),
    takeCheckpoint: async () => {
      checkpointCalls += 1;
      return {
        ok: true as const,
        label: "auto-pre-step-4",
        vmLabel: "run_test-auto-pre-step-4",
        stepSeq: 4,
        createdAt: 1700000000000,
      };
    },
  });

  d.resolve("denied");
  const decision = await decisionPromise;

  assert.equal(decision.decision, "deny");
  assert.equal(checkpointCalls, 0);
  assert.equal(types(events).includes("checkpoint.created"), false);
  assert.equal(types(events).includes("checkpoint.failed"), false);
});

test("allow call takes no checkpoint: only ask-level verdicts snapshot", async () => {
  const events: TelemetryEvent[] = [];
  let checkpointCalls = 0;
  const decision = await evaluateToolApproval({
    toolName: "Bash",
    input: { command: "ls -la" },
    emit: (e) => events.push(e),
    takeCheckpoint: async () => {
      checkpointCalls += 1;
      return {
        ok: true as const,
        label: "auto-pre-step-4",
        vmLabel: "run_test-auto-pre-step-4",
        stepSeq: 4,
        createdAt: 1700000000000,
      };
    },
  });

  assert.deepEqual(decision, { decision: "allow" });
  assert.equal(checkpointCalls, 0);
  assert.deepEqual(types(events), ["tool.started"]);
});

test("full-auto ask auto-approval also checkpoints before tool.started", async () => {
  const events: TelemetryEvent[] = [];
  const decision = await evaluateToolApproval({
    toolName: "Bash",
    input: { command: "sudo apt-get install -y jq" },
    emit: (e) => events.push(e),
    fullAuto: true,
    takeCheckpoint: okCheckpoint(),
  });

  assert.deepEqual(decision, { decision: "allow" });
  assert.deepEqual(types(events), ["checkpoint.created", "tool.started"]);
});

test("full-auto irreversible denial takes no checkpoint", async () => {
  const events: TelemetryEvent[] = [];
  let checkpointCalls = 0;
  const decision = await evaluateToolApproval({
    toolName: "Bash",
    input: { command: "git push --force origin main" },
    emit: (e) => events.push(e),
    fullAuto: true,
    takeCheckpoint: async () => {
      checkpointCalls += 1;
      return {
        ok: true as const,
        label: "auto-pre-step-4",
        vmLabel: "run_test-auto-pre-step-4",
        stepSeq: 4,
        createdAt: 1700000000000,
      };
    },
  });

  assert.equal(decision.decision, "deny");
  assert.equal(checkpointCalls, 0);
  assert.deepEqual(types(events), ["tool.blocked"]);
});
