/**
 * Tests for POST /api/runtime/runs/<id>/fork (F1 time travel).
 * Auth is the middleware-set x-swarm-user header.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../../../../lib/runtime/manager";
import { VmManager } from "../../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../../lib/vm/fake-driver";
import { TelemetryBus, type SequencedEvent } from "../../../../../../lib/telemetry/bus";
import type { ExecOptions, ExecResult, VmHandle } from "../../../../../../lib/vm/types";
import { checkpointVmLabel } from "../../../../../../lib/runtime/checkpoints";

const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_fork", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_fork", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
];

class FixtureFakeVm extends FakeVmDriver {
  override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (cmd[0] === "claude") {
      for (const line of FIXTURE_LINES) opts?.onStdout?.(`${line}\n`);
      return { exitCode: 0 };
    }
    return super.exec(handle, cmd, opts);
  }
}

function install(): { bus: TelemetryBus; vm: VmManager; manager: RuntimeManager } {
  const bus = new TelemetryBus();
  const vm = new VmManager({ customDriver: new FixtureFakeVm() });
  const manager = new RuntimeManager({ vm, bus });
  setRuntimeManagerForTesting(manager);
  return { bus, vm, manager };
}

function request(path: string, init: RequestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  // Build the init explicitly: spreading RequestInit would carry `signal:
  // AbortSignal | null`, which NextRequest does not accept.
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    headers,
    body: init.body ?? undefined,
  });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

function fork(runId: string, body: unknown, user: string | null = "alice"): Promise<Response> {
  return POST(
    request(`/api/runtime/runs/${runId}/fork`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }, user),
    { params: Promise.resolve({ id: runId }) },
  );
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
});

test("POST rejects unauthenticated requests", async () => {
  install();
  assert.equal((await fork("run_x", { checkpointSeq: 1, prompt: "hi" }, null)).status, 401);
});

test("POST rejects an invalid runId", async () => {
  install();
  assert.equal((await fork("bad id!", { checkpointSeq: 1, prompt: "hi" })).status, 400);
});

test("POST requires a checkpoint and a prompt", async () => {
  install();
  const noCheckpoint = await fork("run_abc", { prompt: "hi" });
  assert.equal(noCheckpoint.status, 400);
  const noPrompt = await fork("run_abc", { checkpointSeq: 1 });
  assert.equal(noPrompt.status, 400);
  const emptyPrompt = await fork("run_abc", { checkpointSeq: 1, prompt: "   " });
  assert.equal(emptyPrompt.status, 400);
});

test("POST 404s an unknown run", async () => {
  install();
  const res = await fork("run_11111111-2222-3333-4444-555555555555", {
    checkpointSeq: 1,
    prompt: "hi",
  });
  assert.equal(res.status, 404);
});

test("POST 404s a missing checkpoint on a known run", async () => {
  const { bus, manager } = install();
  const { runId } = manager.start("alice", { prompt: "original", sessionId: "sess_fork" });
  // The source run exists (active or finished) even though it has no checkpoints.
  const done = new Promise<void>((resolve) => {
    bus.subscribe(runId, 0, (event: SequencedEvent) => {
      if (event.type === "run.finished" || event.type === "run.error") resolve();
    });
  });
  await done;
  const res = await fork(runId, { checkpointSeq: 7, prompt: "try again" });
  assert.equal(res.status, 404);
  assert.match((await json(res)).error as string, /not found/i);
});

test("POST forks from an existing checkpoint and accepts a display label", async () => {
  const { bus, vm, manager } = install();
  const user = "alice";
  const { runId: sourceRunId } = manager.start(user, { prompt: "original", sessionId: "sess_fork" });
  const done = new Promise<void>((resolve) => {
    bus.subscribe(sourceRunId, 0, (event: SequencedEvent) => {
      if (event.type === "run.finished" || event.type === "run.error") resolve();
    });
  });
  await done;

  await vm.snapshot(user, checkpointVmLabel(sourceRunId, 2));
  const res = await fork(sourceRunId, { checkpointLabel: "auto-pre-step-2", prompt: "try another approach" });
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.equal(body.ok, true);
  assert.equal(body.sourceRunId, sourceRunId);
  assert.equal(body.checkpointLabel, "auto-pre-step-2");
  assert.equal(body.queued, false);
  assert.notEqual(body.runId, sourceRunId);
  assert.match(body.runId as string, /^run_/);

  const forkSummary = manager.list(user).find((s) => s.runId === body.runId);
  assert.deepEqual(forkSummary?.forkedFrom, {
    runId: sourceRunId,
    checkpointLabel: "auto-pre-step-2",
    stepSeq: 2,
  });
});
