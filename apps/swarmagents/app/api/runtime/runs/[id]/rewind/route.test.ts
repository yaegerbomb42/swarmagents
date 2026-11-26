/**
 * Tests for POST /api/runtime/runs/<id>/rewind (core-17 VM log rewind).
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
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess_rewind", model: "claude-sonnet-5-5" }),
  JSON.stringify({ type: "result", subtype: "success", session_id: "sess_rewind", cost_usd: 0, duration_ms: 1, num_turns: 1 }),
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
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    headers,
    body: init.body ?? undefined,
  });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

function rewind(runId: string, body: unknown, user: string | null = "alice"): Promise<Response> {
  return POST(
    request(`/api/runtime/runs/${runId}/rewind`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }, user),
    { params: Promise.resolve({ id: runId }) },
  );
}

/** Start a fixture run and wait for it to reach a terminal state. */
async function runFixture(manager: RuntimeManager, bus: TelemetryBus, user: string) {
  const { runId } = manager.start(user, { prompt: "original", sessionId: "sess_rewind" });
  await new Promise<void>((resolve) => {
    bus.subscribe(runId, 0, (event: SequencedEvent) => {
      if (event.type === "run.finished" || event.type === "run.error") resolve();
    });
  });
  return runId;
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
});

test("rewind rejects unauthenticated requests and invalid runIds", async () => {
  install();
  assert.equal((await rewind("run_x", { checkpointSeq: 1 }, null)).status, 401);
  assert.equal((await rewind("bad id!", { checkpointSeq: 1 })).status, 400);
});

test("rewind requires a checkpoint identifier", async () => {
  const { bus, manager } = install();
  const runId = await runFixture(manager, bus, "alice");
  const empty = await rewind(runId, {});
  assert.equal(empty.status, 400);
  const bad = await rewind(runId, { checkpointLabel: "not-a-checkpoint" });
  assert.equal(bad.status, 400);
});

test("rewind 404s an unknown run and a missing checkpoint on a known run", async () => {
  const { bus, manager } = install();
  const unknown = await rewind("run_11111111-2222-3333-4444-555555555555", { checkpointSeq: 1 });
  assert.equal(unknown.status, 404);

  const runId = await runFixture(manager, bus, "alice");
  const missing = await rewind(runId, { checkpointSeq: 7 });
  assert.equal(missing.status, 404);
  assert.match((await json(missing)).error as string, /not found/i);
});

test("rewind restores an existing checkpoint into the user's VM", async () => {
  const { bus, vm, manager } = install();
  const user = "alice";
  const runId = await runFixture(manager, bus, user);

  await vm.snapshot(user, checkpointVmLabel(runId, 2));
  await vm.writeFile(user, "/workspace/after-checkpoint.txt", "written after the checkpoint");

  const res = await rewind(runId, { checkpointLabel: "auto-pre-step-2" });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.ok, true);
  assert.equal(body.runId, runId);
  assert.equal(body.checkpointLabel, "auto-pre-step-2");
  assert.equal(body.stepSeq, 2);
  assert.equal(typeof body.restoredAt, "number");

  // The file written after the checkpoint is gone after the rewind.
  await assert.rejects(
    vm.readFile(user, "/workspace/after-checkpoint.txt"),
    (err: unknown) => err instanceof Error && /not_found|No such file/i.test(err.message),
  );
});

test("rewind refuses another user's run and refuses while a run is active", async () => {
  const { bus, vm, manager } = install();
  const runId = await runFixture(manager, bus, "alice");
  await vm.snapshot("alice", checkpointVmLabel(runId, 1));

  const stranger = await rewind(runId, { checkpointSeq: 1 }, "bob");
  assert.equal(stranger.status, 404);

  // Reuse the same harness for an active-run refusal: a queued second run
  // also blocks the rewind (same check), so exercise the active path.
  const second = manager.start("alice", { prompt: "second", sessionId: "sess_rewind" });
  assert.ok(second.accepted);
  const busy = await rewind(runId, { checkpointSeq: 1 });
  assert.equal(busy.status, 400);
  assert.match((await json(busy)).error as string, /run is active/i);
});
