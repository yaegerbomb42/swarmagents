/**
 * Runner integration tests for auto-approve + VM-only + ask_user.
 *
 * Auto-approve removes the interactive approval pause, but it must never
 * relax the VM-only policy: a tool call aimed at the host is a hard deny on
 * the server. ask_user pauses the same stream and resumes with the user's
 * answer as the tool result.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeRunner } from "./runner";
import type {
  ApprovalGateway,
  ApprovalRequest,
  QuestionGateway,
  QuestionRequest,
  TelemetryEvent,
  VmExec,
  VmExecOpts,
} from "./types";

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "sess_vm_only", model: "claude-sonnet-5-5" });
const RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "sess_vm_only",
  cost_usd: 0.01,
  duration_ms: 10,
  num_turns: 1,
});

function assistantTool(id: string, name: string, input: unknown) {
  return JSON.stringify({ type: "assistant", message: { id: `m_${id}`, content: [{ type: "tool_use", id, name, input }] } });
}

function toolResult(id: string, content: string) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] },
  });
}

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

function makeApprovalGateway() {
  const requests: ApprovalRequest[] = [];
  const gateway: ApprovalGateway = async (req) => {
    requests.push(req);
    return { id: `appr_${requests.length}`, verdict: Promise.resolve("approved") };
  };
  return { gateway, requests };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

test("auto-approve: an ask-classified call runs without any approval pause", async () => {
  const fixture = [
    INIT,
    assistantTool("t1", "Bash", { command: "pip install flask" }),
    toolResult("t1", "ok"),
    RESULT,
  ].join("\n") + "\n";
  const { gateway, requests } = makeApprovalGateway();
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run(
    { prompt: "clean scratch", env: {}, vm: new ScriptedVm(fixture), approvalGateway: gateway, autoApprove: true },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(requests.length, 0, "auto-approve must not ask for approval");
  assert.equal(events.some((e) => e.type === "approval.required"), false);
  assert.equal(events.some((e) => e.type === "tool.blocked"), false);
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
});

test("auto-approve: a host-targeted file read is still denied with no approval", async () => {
  const fixture = [
    INIT,
    assistantTool("t1", "Read", { file_path: "/host/etc/passwd" }),
    toolResult("t1", "root:x:0:0"),
    RESULT,
  ].join("\n") + "\n";
  const { gateway, requests } = makeApprovalGateway();
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run(
    { prompt: "read a host file", env: {}, vm: new ScriptedVm(fixture), approvalGateway: gateway, autoApprove: true },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(requests.length, 0);
  assert.equal(events.some((e) => e.type === "approval.required"), false);
  const blocked = events.find((e) => e.type === "tool.blocked") as Extract<TelemetryEvent, { type: "tool.blocked" }>;
  assert.ok(blocked);
  assert.equal(blocked.name, "Read");
  assert.match(blocked.reason, /VM-only policy/);
  const errors = events.filter((e) => e.type === "run.error");
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Extract<TelemetryEvent, { type: "run.error" }>).message, /Halted by harness risk policy/);
  assert.equal(events.some((e) => e.type === "run.finished"), false);
});

test("auto-approve: a host-local network service is denied even for shell commands", async () => {
  const fixture = [
    INIT,
    assistantTool("t1", "Bash", { command: "curl -s http://host.docker.internal:3000/secret" }),
    toolResult("t1", "oops"),
    RESULT,
  ].join("\n") + "\n";
  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run(
    { prompt: "curl the host", env: {}, vm: new ScriptedVm(fixture), autoApprove: true },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  const blocked = events.find((e) => e.type === "tool.blocked") as Extract<TelemetryEvent, { type: "tool.blocked" }>;
  assert.ok(blocked);
  assert.match(blocked.reason, /host\.docker\.internal/);
  assert.equal(events.filter((e) => e.type === "run.error").length, 1);
});

test("ask_user: pauses on question.required and resumes with the answer", async () => {
  const fixture = [
    INIT,
    assistantTool("t_ask", "mcp__ask__ask_user", {
      question: "Which engine should the game use?",
      options: ["Godot", "Three.js"],
      allow_free_text: true,
    }),
    toolResult("t_ask", JSON.stringify({ answer: "Godot" })),
    RESULT,
  ].join("\n") + "\n";

  const requests: QuestionRequest[] = [];
  let resolveOutcome!: (outcome: { status: "answered"; answer: string }) => void;
  const gateway: QuestionGateway = async (request) => {
    requests.push(request);
    const outcome = new Promise<{ status: "answered"; answer: string }>((resolve) => {
      resolveOutcome = resolve;
    });
    return {
      id: "q_round_trip",
      question: request.question,
      options: request.options,
      allowFreeText: request.allowFreeText,
      expiresAt: Date.now() + 60_000,
      outcome,
    };
  };

  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcomePromise = runner.run(
    { prompt: "build a game", env: {}, vm: new ScriptedVm(fixture), questionGateway: gateway, autoApprove: true },
    (e) => events.push(e),
  );

  await until(() => events.some((e) => e.type === "question.required"));
  const required = events.find((e) => e.type === "question.required") as Extract<TelemetryEvent, { type: "question.required" }>;
  assert.equal(required.question.id, "q_round_trip");
  assert.equal(required.question.question, "Which engine should the game use?");
  assert.deepEqual(required.question.options, ["Godot", "Three.js"]);
  assert.equal(required.question.allowFreeText, true);
  assert.equal(requests.length, 1);
  // The run is paused: no terminal event while the user thinks.
  assert.equal(events.some((e) => e.type === "run.finished"), false);

  resolveOutcome({ status: "answered", answer: "Godot" });
  const outcome = await outcomePromise;
  assert.equal(outcome.exitCode, 0);

  const resolved = events.find((e) => e.type === "question.resolved") as Extract<TelemetryEvent, { type: "question.resolved" }>;
  assert.ok(resolved);
  assert.equal(resolved.id, "q_round_trip");
  assert.equal(resolved.status, "answered");
  assert.equal(resolved.answer, "Godot");
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
});

test("ask_user: a cancelled question unblocks the run", async () => {
  const fixture = [
    INIT,
    assistantTool("t_ask", "ask_user", { question: "Continue?" }),
    toolResult("t_ask", JSON.stringify({ error: "question_cancelled" })),
    RESULT,
  ].join("\n") + "\n";

  const gateway: QuestionGateway = async (request) => ({
    id: "q_cancel",
    question: request.question,
    options: [],
    allowFreeText: true,
    outcome: Promise.resolve({ status: "cancelled" as const }),
  });

  const runner = new ClaudeCodeRunner({ bin: "claude" });
  const events: TelemetryEvent[] = [];
  const outcome = await runner.run(
    { prompt: "ask", env: {}, vm: new ScriptedVm(fixture), questionGateway: gateway, autoApprove: true },
    (e) => events.push(e),
  );

  assert.equal(outcome.exitCode, 0);
  const resolved = events.find((e) => e.type === "question.resolved") as Extract<TelemetryEvent, { type: "question.resolved" }>;
  assert.ok(resolved);
  assert.equal(resolved.status, "cancelled");
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1);
});
