/**
 * Integration tests for the harness risk gate (approval.required pause).
 *
 * A scripted VM replays a stream-json transcript containing an ask-classified
 * Bash call (rm -rf /). Tests cover: approve resumes the run; deny halts it;
 * expiry halts it; deny-classified calls block immediately; and the default
 * (no gateway) path is unchanged.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeRunner } from "./runner";
import type { ApprovalGateway, ApprovalRequest, TelemetryEvent, VmExec, VmExecOpts } from "./types";

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "sess_gate", model: "claude-sonnet-5-5" });
const ASK_TEXT = JSON.stringify({
  type: "assistant",
  message: { id: "m1", content: [{ type: "text", text: "I will clean up." }] },
});
const ASK_TOOL = JSON.stringify({
  type: "assistant",
  message: { id: "m2", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "rm -rf /" } }] },
});
const TOOL_RESULT = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }],
  },
});
const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "sess_gate",
  cost_usd: 0.01,
  duration_ms: 10,
  num_turns: 1,
});
const FIXTURE = [INIT, ASK_TEXT, ASK_TOOL, TOOL_RESULT, RESULT].join("\n") + "\n";

class ScriptedVm implements VmExec {
  calls: Array<{ cmd: string[]; opts: VmExecOpts }> = [];
  constructor(private readonly output: string) {}
  async exec(cmd: string[], opts?: VmExecOpts): Promise<{ exitCode: number }> {
    this.calls.push({ cmd, opts: opts ?? {} });
    if (opts?.signal?.aborted) return { exitCode: 130 };
    opts?.onStdout?.(this.output);
    return { exitCode: 0 };
  }
}

function deferredVerdict() {
  let resolve!: (v: "approved" | "denied" | "expired") => void;
  const promise = new Promise<"approved" | "denied" | "expired">((r) => { resolve = r; });
  return { promise, resolve };
}

function makeGateway() {
  const requests: ApprovalRequest[] = [];
  const resolvers: Array<(v: "approved" | "denied" | "expired") => void> = [];
  const gateway: ApprovalGateway = async (req) => {
    requests.push(req);
    const { promise, resolve } = deferredVerdict();
    resolvers.push(resolve);
    return { id: `appr_test_${requests.length}`, verdict: promise };
  };
  return { gateway, requests, resolvers };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

test("ask + approve: run pauses on approval.required and resumes to finished", async () => {
  const { gateway, requests, resolvers } = makeGateway();
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcomePromise = runner.run({ prompt: "clean up", env: {}, vm: new ScriptedVm(FIXTURE), approvalGateway: gateway }, (e) => events.push(e));

  await until(() => events.some((e) => e.type === "approval.required"));
  const required = events.find((e) => e.type === "approval.required") as Extract<TelemetryEvent, { type: "approval.required" }>;
  assert.ok(required.approval.id.startsWith("appr_"));
  assert.equal(required.approval.tool, "Bash");
  assert.equal(required.approval.action, "rm -rf /");
  assert.ok(required.approval.reason.length > 0);
  assert.equal(requests.length, 1);
  // Still paused: no terminal event yet.
  assert.equal(events.some((e) => e.type === "run.finished"), false);

  resolvers[0]("approved");
  const outcome = await outcomePromise;
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.aborted, false);
  const resolved = events.filter((e) => e.type === "approval.resolved");
  assert.equal(resolved.length, 1);
  assert.deepEqual(resolved[0], { type: "approval.resolved", id: required.approval.id, verdict: "approved" });
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
});

test("ask + deny: run halts with an error after approval.resolved(denied)", async () => {
  const { gateway, resolvers } = makeGateway();
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcomePromise = runner.run({ prompt: "clean up", env: {}, vm: new ScriptedVm(FIXTURE), approvalGateway: gateway }, (e) => events.push(e));

  await until(() => events.some((e) => e.type === "approval.required"));
  resolvers[0]("denied");
  const outcome = await outcomePromise;

  assert.equal(outcome.exitCode, 0);
  const resolved = events.find((e) => e.type === "approval.resolved") as Extract<TelemetryEvent, { type: "approval.resolved" }>;
  assert.equal(resolved.verdict, "denied");
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Extract<TelemetryEvent, { type: "run.error" }>).message, /approval denied by user/);
  assert.equal(events.some((e) => e.type === "run.finished"), false);
});

test("ask + expire: undecided approval times out and halts the run", async () => {
  const { gateway, resolvers } = makeGateway();
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcomePromise = runner.run({ prompt: "clean up", env: {}, vm: new ScriptedVm(FIXTURE), approvalGateway: gateway }, (e) => events.push(e));

  await until(() => events.some((e) => e.type === "approval.required"));
  resolvers[0]("expired");
  const outcome = await outcomePromise;

  const resolved = events.find((e) => e.type === "approval.resolved") as Extract<TelemetryEvent, { type: "approval.resolved" }>;
  assert.equal(resolved.verdict, "expired");
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Extract<TelemetryEvent, { type: "run.error" }>).message, /approval timed out/);
});

test("deny-classified call blocks immediately: tool.blocked + run.error, no approval flow", async () => {
  const fixture = [INIT, JSON.stringify({
    type: "assistant",
    message: { id: "m2", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo ${API_KEY}" } }] },
  }), TOOL_RESULT, RESULT].join("\n") + "\n";
  const { gateway, requests } = makeGateway();
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run({ prompt: "x", env: {}, vm: new ScriptedVm(fixture), approvalGateway: gateway }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  assert.equal(requests.length, 0, "no approval should be requested for a deny");
  assert.equal(events.some((e) => e.type === "approval.required"), false);
  const blocked = events.find((e) => e.type === "tool.blocked") as Extract<TelemetryEvent, { type: "tool.blocked" }>;
  assert.ok(blocked);
  assert.equal(blocked.name, "Bash");
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Extract<TelemetryEvent, { type: "run.error" }>).message, /Halted by harness risk policy/);
});

test("no gateway configured: ask-classified calls pass through without pausing", async () => {
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run({ prompt: "clean up", env: {}, vm: new ScriptedVm(FIXTURE) }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  assert.equal(events.some((e) => e.type === "approval.required"), false);
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
});

test("with the synchronous hook, the runner does not re-gate stdout (ask)", async () => {
  // The hook already blocked/allowed the call before execution. Re-gating the
  // resulting stream would open a second approval card or halt a run whose
  // tool was handled synchronously.
  const { gateway, requests } = makeGateway();
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run(
    { prompt: "clean up", env: {}, vm: new ScriptedVm(FIXTURE), approvalGateway: gateway, approvalHook: true },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(requests.length, 0, "the hook path must not ask a second time");
  assert.equal(events.some((e) => e.type === "approval.required"), false);
  assert.equal(events.some((e) => e.type === "run.error"), false);
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
});

test("with the synchronous hook, the runner does not halt on a stdout deny", async () => {
  const fixture = [INIT, JSON.stringify({
    type: "assistant",
    message: { id: "m2", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat /etc/passwd" } }] },
  }), TOOL_RESULT, RESULT].join("\n") + "\n";
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run({ prompt: "x", env: {}, vm: new ScriptedVm(fixture), approvalHook: true }, (e) => events.push(e));

  assert.equal(outcome.exitCode, 0);
  assert.equal(events.some((e) => e.type === "tool.blocked"), false);
  assert.equal(events.some((e) => e.type === "run.error"), false);
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
});

test("legacy full-auto auto-approves in-VM asks without a card", async () => {
  const fixture = [INIT, JSON.stringify({
    type: "assistant",
    message: { id: "m2", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sudo touch /tmp/marker" } }] },
  }), TOOL_RESULT, RESULT].join("\n") + "\n";
  const { gateway, requests } = makeGateway();
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run(
    { prompt: "x", env: {}, vm: new ScriptedVm(fixture), approvalGateway: gateway, autoApprove: true },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(requests.length, 0);
  assert.equal(events.some((e) => e.type === "approval.required"), false);
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
});

test("legacy full-auto still asks for irreversible external actions", async () => {
  const fixture = [INIT, JSON.stringify({
    type: "assistant",
    message: { id: "m2", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git push --force origin main" } }] },
  }), TOOL_RESULT, RESULT].join("\n") + "\n";
  const { gateway, requests, resolvers } = makeGateway();
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcomePromise = runner.run(
    { prompt: "x", env: {}, vm: new ScriptedVm(fixture), approvalGateway: gateway, autoApprove: true },
    (e) => events.push(e),
  );

  await until(() => events.some((e) => e.type === "approval.required"));
  assert.equal(requests.length, 1);
  resolvers[0]("approved");
  const outcome = await outcomePromise;
  assert.equal(outcome.exitCode, 0);
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
});
