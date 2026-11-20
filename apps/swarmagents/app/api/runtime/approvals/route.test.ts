/**
 * End-to-end tests for the approval decision flow:
 *
 *   POST /api/runtime/tasks (risky prompt)
 *     -> tool.call classified "ask" emits approval.required
 *     -> the run pauses (no terminal event)
 *     -> POST /api/runtime/approvals/{id} {decision:"approve"} resumes it
 *     -> run finishes; denial halts it with an error.
 *
 * Uses the fake VM driver + ScriptedFakeVm replay like the tasks route tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as POST_TASK, GET as GET_TASKS } from "../tasks/route";
import { POST as POST_APPROVAL } from "./[id]/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../lib/runtime/manager";
import { VmManager } from "../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../lib/vm/fake-driver";
import { telemetryBus } from "../../../../lib/telemetry/index";
import { setApprovalStoreForTesting, ApprovalStore } from "../../../../lib/harness/approvals";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../../../../lib/vm/types";
import type { RunSummary } from "../../../../lib/runtime/manager";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const RISKY_FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_ap", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "I will clean up the vm." }] } }),
  JSON.stringify({
    type: "assistant",
    message: { id: "m2", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "rm -rf /" } }] },
  }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }] },
  }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_ap", cost_usd: 0.01, duration_ms: 10, num_turns: 1 }),
];

class ScriptedFakeVm extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];
  constructor(private readonly fixtureLines: string[] = RISKY_FIXTURE_LINES) {
    super();
  }
  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, opts: opts ?? {} });
    if (opts?.signal?.aborted) return { exitCode: 130 };
    if (cmd[0] === "claude") {
      for (const line of this.fixtureLines) opts?.onStdout?.(`${line}\n`);
      return { exitCode: 0 };
    }
    return super.exec(h, cmd, opts);
  }
}

function request(path: string, init: RequestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${path}`, { ...init, headers, signal: init.signal ?? undefined });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

async function postTask(body: unknown, user: string | null = "alice"): Promise<Response> {
  return POST_TASK(request("/api/runtime/tasks", { method: "POST", body: JSON.stringify(body) }, user));
}

function postApproval(id: string, body: unknown, user: string | null = "alice"): Promise<Response> {
  return POST_APPROVAL(
    request(`/api/runtime/approvals/${id}`, { method: "POST", body: JSON.stringify(body) }, user),
    { params: Promise.resolve({ id }) },
  );
}

function install(driver: VmDriver, ttlMs = 60_000): RuntimeManager {
  setApprovalStoreForTesting(new ApprovalStore({ ttlMs }));
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }) });
  setRuntimeManagerForTesting(manager);
  return manager;
}

async function waitForEvent(runId: string, type: string, timeoutMs = 2000): Promise<any> {
  const events: any[] = [];
  const start = Date.now();
  const unsubscribe = telemetryBus.subscribe(runId, 0, (e) => events.push(e));
  try {
    while (!events.some((e) => e.type === type)) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await sleep(5);
    }
    return events.find((e) => e.type === type)!;
  } finally {
    unsubscribe();
  }
}

async function listRuns(user = "alice"): Promise<RunSummary[]> {
  return (await json(await GET_TASKS(request("/api/runtime/tasks", {}, user)))).runs;
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
  setApprovalStoreForTesting(null);
});

test("approval flow: ask pauses the run, POST approve resumes it to finished", async () => {
  install(new ScriptedFakeVm());
  const res = await postTask({ prompt: "clean up the vm" });
  assert.equal(res.status, 201);
  const { runId } = await json(res);

  // The run emits approval.required and stays paused (no terminal event).
  const required = await waitForEvent(runId, "approval.required");
  assert.ok(required.approval.id.startsWith("appr_"));
  assert.equal(required.approval.tool, "Bash");
  assert.equal(required.approval.action, "rm -rf /");
  const runs = await listRuns();
  assert.equal(runs[0].runId, runId);
  assert.equal(runs[0].status, "running");

  // Approve through the API.
  const id = required.approval.id;
  const approveRes = await postApproval(id, { decision: "approve" });
  assert.equal(approveRes.status, 200);
  assert.deepEqual(await json(approveRes), { ok: true, status: "approved" });

  await waitForEvent(runId, "run.finished");
  const resolved = await waitForEvent(runId, "approval.resolved");
  assert.equal(resolved.verdict, "approved");

  const finished = await listRuns();
  assert.equal(finished[0].status, "finished");
  assert.equal(finished[0].exitCode, 0);
});

test("approval flow: POST deny halts the run with an error", async () => {
  install(new ScriptedFakeVm());
  const { runId } = await json(await postTask({ prompt: "clean up the vm" }));

  const required = await waitForEvent(runId, "approval.required");
  const denyRes = await postApproval(required.approval.id, { decision: "deny" });
  assert.equal(denyRes.status, 200);

  await waitForEvent(runId, "approval.resolved");
  const error = await waitForEvent(runId, "run.error");
  assert.match(error.message, /approval denied by user/);

  const runs = await listRuns();
  assert.equal(runs[0].status, "error");
  assert.ok(runs[0].error?.includes("approval denied by user"));
});

test("approval flow: unanswered approval auto-denies, emits approval.timeout and halts the run", async () => {
  install(new ScriptedFakeVm(), 200);
  const { runId } = await json(await postTask({ prompt: "clean up the vm" }));

  const required = await waitForEvent(runId, "approval.required");
  assert.ok(required.approval.expiresAt > Date.now());

  const timeout = await waitForEvent(runId, "approval.timeout");
  assert.equal(timeout.id, required.approval.id);
  assert.equal(timeout.tool, "Bash");
  assert.equal(timeout.action, "rm -rf /");

  const resolved = await waitForEvent(runId, "approval.resolved");
  assert.equal(resolved.verdict, "expired");

  const error = await waitForEvent(runId, "run.error");
  assert.match(error.message, /approval timed out/);

  const runs = await listRuns();
  assert.equal(runs[0].status, "error");
  assert.ok(runs[0].error?.includes("approval timed out"));
});

test("approval route guards: auth, unknown id, wrong owner, bad body, double decide", async () => {
  install(new ScriptedFakeVm());
  const { runId } = await json(await postTask({ prompt: "clean up" }));
  const required = await waitForEvent(runId, "approval.required");
  const id = required.approval.id;

  // Unauthenticated.
  const anon = await postApproval(id, { decision: "approve" }, null);
  assert.equal(anon.status, 401);

  // Bad body.
  const bad = await postApproval(id, "nope");
  assert.equal(bad.status, 400);
  const badDecision = await postApproval(id, { decision: "maybe" });
  assert.equal(badDecision.status, 400);

  // Unknown approval.
  const ghost = await postApproval("appr_ghost", { decision: "approve" });
  assert.equal(ghost.status, 404);

  // Wrong owner (another user cannot decide someone else's approval).
  const other = await postApproval(id, { decision: "deny" }, "mallory");
  assert.equal(other.status, 404);

  // Decide once, then a second decision is 409.
  const first = await postApproval(id, { decision: "approve" });
  assert.equal(first.status, 200);
  const second = await postApproval(id, { decision: "deny" });
  assert.equal(second.status, 409);
  assert.equal((await json(second)).status, "approved");

  await waitForEvent(runId, "run.finished");
});
