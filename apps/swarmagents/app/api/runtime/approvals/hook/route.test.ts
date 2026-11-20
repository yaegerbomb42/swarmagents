/**
 * Tests for the in-VM PreToolUse hook endpoint
 * (POST /api/runtime/approvals/hook).
 *
 * A hanging fake VM keeps a run active so the route can consult the real
 * RuntimeManager. The route is authenticated with the per-run HMAC token, not
 * a browser session. These tests cover: allow, ask -> approve, ask -> deny,
 * timeout -> deny (no tool.started), hard deny, and auth failures.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST as POST_HOOK } from "./route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../../lib/runtime/manager";
import { signRunToken } from "../../../../../lib/runtime/run-token";
import { VmManager } from "../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../lib/vm/fake-driver";
import { telemetryBus } from "../../../../../lib/telemetry/index";
import { ApprovalStore, getApprovalStore, setApprovalStoreForTesting } from "../../../../../lib/harness/approvals";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../../../../../lib/vm/types";
import type { SequencedEvent } from "../../../../../lib/telemetry/bus";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SECRET = "test-session-secret-for-approval-hook-route";

class HangingFakeVm extends FakeVmDriver {
  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") {
      opts?.onStdout?.(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess_hook", model: "m" })}\n`,
      );
      return new Promise<ExecResult>((resolve) => {
        const finish = () => resolve({ exitCode: 130 });
        if (opts?.signal?.aborted) finish();
        else opts?.signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return super.exec(h, cmd, opts);
  }
}

function install(driver: VmDriver, ttlMs = 60_000): RuntimeManager {
  setApprovalStoreForTesting(new ApprovalStore({ ttlMs }));
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }) });
  setRuntimeManagerForTesting(manager);
  return manager;
}

function hookRequest(body: unknown, token: string): NextRequest {
  return new NextRequest("http://localhost/api/runtime/approvals/hook", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function startRun(manager: RuntimeManager, prompt = "do a thing"): Promise<string> {
  const result = manager.start("alice", { prompt });
  assert.equal(result.accepted, true);
  return result.runId;
}

/** Subscribe to the bus and resolve once an event satisfying `pred` arrives. */
function watch(runId: string): { events: SequencedEvent[]; stop: () => void } {
  const events: SequencedEvent[] = [];
  const stop = telemetryBus.subscribe(runId, 0, (e) => events.push(e));
  return { events, stop };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

function withSecret<T>(fn: () => Promise<T>): Promise<T> {
  process.env.SWARM_SESSION_SECRET = SECRET;
  return fn();
}

test.afterEach(() => {
  try {
    setRuntimeManagerForTesting(null);
  } finally {
    setApprovalStoreForTesting(null);
    delete process.env.SWARM_SESSION_SECRET;
    delete process.env.SWARM_VM_APPROVAL_BASE_URL;
  }
});

test("hook route: allow-classified call returns allow and emits tool.started", async () => {
  await withSecret(async () => {
    const manager = install(new HangingFakeVm());
    const runId = await startRun(manager);
    const token = signRunToken("alice", runId);
    const { events, stop } = watch(runId);

    const res = await POST_HOOK(hookRequest({ tool_name: "Bash", tool_input: { command: "ls -la" } }, token));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.decision, "allow");

    await until(() => events.some((e) => e.type === "tool.started"));
    assert.equal(events.some((e) => e.type === "approval.requested"), false);
    stop();
    manager.cancel("alice");
  });
});

test("hook route: ask blocks until approval; requested precedes started", async () => {
  await withSecret(async () => {
    const manager = install(new HangingFakeVm());
    const runId = await startRun(manager);
    const token = signRunToken("alice", runId);
    const { events, stop } = watch(runId);

    const pending = POST_HOOK(
      hookRequest({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }, token),
    );

    await until(() => events.some((e) => e.type === "approval.requested"));
    const requested = events.find((e) => e.type === "approval.requested") as any;
    assert.equal(requested.approval.tool, "Bash");
    assert.equal(requested.approval.action, "rm -rf /");
    assert.ok(requested.approval.id.startsWith("appr_"));
    // Nothing has started while the human is deciding.
    assert.equal(events.some((e) => e.type === "tool.started"), false);

    getApprovalStore().resolve(requested.approval.id, "approved");
    const body = await (await pending).json();

    assert.equal(body.decision, "allow");
    await until(() => events.some((e) => e.type === "tool.started"));
    const requestedSeq = requested.seq;
    const started = events.find((e) => e.type === "tool.started") as SequencedEvent;
    assert.ok(requestedSeq < started.seq, "approval.requested must precede tool.started");
    stop();
    manager.cancel("alice");
  });
});

test("hook route: ask denied returns deny, no tool.started", async () => {
  await withSecret(async () => {
    const manager = install(new HangingFakeVm());
    const runId = await startRun(manager);
    const token = signRunToken("alice", runId);
    const { events, stop } = watch(runId);

    const pending = POST_HOOK(
      hookRequest({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }, token),
    );
    await until(() => events.some((e) => e.type === "approval.requested"));
    const requested = events.find((e) => e.type === "approval.requested") as any;
    getApprovalStore().resolve(requested.approval.id, "denied");

    const body = await (await pending).json();
    assert.equal(body.decision, "deny");
    assert.match(body.reason, /denied/i);
    assert.equal(events.some((e) => e.type === "tool.started"), false);
    assert.equal(events.some((e) => e.type === "tool.blocked"), true);
    stop();
    manager.cancel("alice");
  });
});

test("hook route: an unanswered ask times out as deny (default deny)", async () => {
  await withSecret(async () => {
    const manager = install(new HangingFakeVm(), 80);
    const runId = await startRun(manager);
    const token = signRunToken("alice", runId);
    const { events, stop } = watch(runId);

    const res = await POST_HOOK(
      hookRequest({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }, token),
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.decision, "deny");
    assert.match(body.reason, /timed out/i);
    assert.equal(events.some((e) => e.type === "tool.started"), false);
    assert.equal(events.some((e) => e.type === "approval.timeout"), true);
    stop();
    manager.cancel("alice");
  });
});

test("hook route: hard-deny (secret file) never starts", async () => {
  await withSecret(async () => {
    const manager = install(new HangingFakeVm());
    const runId = await startRun(manager);
    const token = signRunToken("alice", runId);
    const { events, stop } = watch(runId);

    const res = await POST_HOOK(
      hookRequest({ tool_name: "Bash", tool_input: { command: "cat /etc/passwd" } }, token),
    );
    const body = await res.json();
    assert.equal(body.decision, "deny");
    assert.match(body.reason, /credential/i);
    assert.equal(events.some((e) => e.type === "tool.started"), false);
    stop();
    manager.cancel("alice");
  });
});

test("hook route: rejects missing/invalid tokens and inactive runs", async () => {
  await withSecret(async () => {
    const manager = install(new HangingFakeVm());
    const runId = await startRun(manager);

    const noToken = await POST_HOOK(
      new NextRequest("http://localhost/api/runtime/approvals/hook", {
        method: "POST",
        body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      }),
    );
    assert.equal(noToken.status, 401);

    const badToken = await POST_HOOK(
      hookRequest({ tool_name: "Bash", tool_input: { command: "ls" } }, "rt1.nope.nope"),
    );
    assert.equal(badToken.status, 401);

    const otherRun = signRunToken("alice", "run_not_active");
    const inactive = await POST_HOOK(
      hookRequest({ tool_name: "Bash", tool_input: { command: "ls" } }, otherRun),
    );
    assert.equal(inactive.status, 401);

    const wrongUser = signRunToken("bob", runId);
    const crossUser = await POST_HOOK(
      hookRequest({ tool_name: "Bash", tool_input: { command: "ls" } }, wrongUser),
    );
    assert.equal(crossUser.status, 401);

    manager.cancel("alice");
  });
});

test("hook route: full-auto run auto-allows an in-VM ask and denies an external one", async () => {
  await withSecret(async () => {
    const manager = install(new HangingFakeVm());
    const result = manager.start("alice", { prompt: "go", fullAuto: true });
    assert.equal(result.accepted, true);
    const runId = result.runId;
    const token = signRunToken("alice", runId);

    const inVm = await POST_HOOK(
      hookRequest({ tool_name: "Bash", tool_input: { command: "sudo apt-get install -y jq" } }, token),
    );
    assert.equal((await inVm.json()).decision, "allow");

    const external = await POST_HOOK(
      hookRequest({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } }, token),
    );
    const externalBody = await external.json();
    assert.equal(externalBody.decision, "deny");
    assert.match(externalBody.reason, /full-auto/i);

    manager.cancel("alice");
  });
});
