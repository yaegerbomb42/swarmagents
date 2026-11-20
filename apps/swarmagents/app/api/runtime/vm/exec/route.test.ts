/**
 * Tests for POST/DELETE /api/runtime/vm/exec using the fake VM driver.
 *
 * The route runs the command through the RuntimeManager's VmManager (argv
 * form), streams output to the telemetry bus under a "shell" run, and gates
 * dangerous commands with the risk classifier. DELETE (and a dropped POST
 * request) aborts the in-flight command via the exec signal. Auth is the
 * middleware-set x-swarm-user header.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { DELETE, POST } from "./route";
import { RuntimeManager, getRuntimeManager, setRuntimeManagerForTesting } from "../../../../../lib/runtime/manager";
import { VmManager } from "../../../../../lib/vm/manager";
import { FakeVmDriver } from "../../../../../lib/vm/fake-driver";
import { telemetryBus } from "../../../../../lib/telemetry/index";
import type { ExecOptions, ExecResult, VmHandle, VmDriver } from "../../../../../lib/vm/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A fake driver that records every exec call (argv form) for assertions. */
class RecordingFakeVm extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];
  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, opts: opts ?? {} });
    if (opts?.signal?.aborted) return { exitCode: 130 };
    return super.exec(h, cmd, opts);
  }
}

function request(path: string, init: RequestInit = {}, user: string | null = "alice"): NextRequest {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("x-swarm-user", user);
  return new NextRequest(`http://localhost${path}`, { ...init, headers, signal: init.signal ?? undefined });
}

function postExec(body: unknown, user: string | null = "alice"): Promise<Response> {
  return POST(request("/api/runtime/vm/exec", { method: "POST", body: JSON.stringify(body) }, user));
}

async function json(res: Response): Promise<any> {
  return res.json();
}

function install(driver: VmDriver): RuntimeManager {
  const manager = new RuntimeManager({ vm: new VmManager({ customDriver: driver }) });
  setRuntimeManagerForTesting(manager);
  return manager;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
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

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
});

test("exec: auth guard returns 401", async () => {
  install(new RecordingFakeVm());
  const res = await postExec({ cmd: "ls" }, null);
  assert.equal(res.status, 401);
});

test("exec: validation rejects bad bodies", async () => {
  install(new RecordingFakeVm());
  assert.equal((await postExec("not json")).status, 400);
  assert.equal((await postExec([])).status, 400);
  assert.equal((await postExec({})).status, 400);
  assert.equal((await postExec({ cmd: "" })).status, 400);
  assert.equal((await postExec({ cmd: "   " })).status, 400);
  assert.equal((await postExec({ cmd: 42 })).status, 400);
  assert.equal((await postExec({ cmd: [""] })).status, 400);
  assert.equal((await postExec({ cmd: [42] })).status, 400);
  assert.equal((await postExec({ cmd: "echo \0" })).status, 400);
  assert.equal((await postExec({ cmd: ["a".repeat(3000)] })).status, 400);
  assert.equal((await postExec({ cmd: Array.from({ length: 101 }, () => "x") })).status, 400);
  assert.equal((await postExec({ cmd: "x".repeat(9000) })).status, 400);
  // A raw shell line is one bash argument, so quotes need not balance it in
  // the API layer (bash reports the syntax error itself).
  assert.equal((await postExec({ cmd: "echo 'unterminated" })).status, 201);
  assert.equal((await postExec({ cmd: "echo " + "x".repeat(3000) })).status, 201);
  assert.equal((await postExec({ cmd: "ls", extra: "y" })).status, 201);

  const big = { cmd: "x".repeat(80 * 1024) };
  assert.equal((await postExec(big)).status, 413);
});

test("exec: risk classifier refuses deny and ask commands without executing", async () => {
  const driver = new RecordingFakeVm();
  install(driver);

  // deny: system credential files are off-limits.
  const deny = await postExec({ cmd: "cat /etc/passwd" });
  assert.equal(deny.status, 403);
  assert.equal((await json(deny)).level, "deny");
  assert.equal(driver.calls.length, 0);

  // ask: destructive root deletion requires approval — refused from the
  // terminal (take it to the agent prompt instead).
  const ask = await postExec({ cmd: "rm -rf /" });
  assert.equal(ask.status, 403);
  assert.equal((await json(ask)).level, "ask");
  assert.equal(driver.calls.length, 0);
});

test("exec: a raw command line runs through bash -lc unchanged", async () => {
  const driver = new RecordingFakeVm();
  install(driver);

  const line = `echo "hello world" | tr a-z A-Z && printf '%s\\n' '$HOME'`;
  const res = await postExec({ cmd: line });
  assert.equal(res.status, 201);
  const { runId } = await json(res);
  assert.match(runId, /^run_[A-Za-z0-9_-]{1,64}$/);

  const started = await waitForEvent(runId, "shell.cmd");
  assert.equal(started.data.command, line);
  assert.deepEqual(started.data.argv, ["bash", "-lc", line]);

  const finished = await waitForEvent(runId, "run.finished");
  assert.equal(finished.exitCode, 0);

  // Quotes and pipes survive: they are interpreted by the VM's bash, not
  // split into argv on the server. The exec runs in the background, so we
  // only assert the fake driver's calls once the run has finished.
  assert.equal(driver.calls.length, 1);
  assert.deepEqual(driver.calls[0].cmd, ["bash", "-lc", line]);

  // The run is owned by the user and listed with kind shell.
  const manager = getRuntimeManager();
  assert.ok(manager.ownsRun("alice", runId));
  const runs = manager.list("alice");
  const shell = runs.find((r) => r.runId === runId);
  assert.equal(shell?.kind, "shell");
  assert.equal(shell?.status, "finished");
  assert.equal(shell?.exitCode, 0);
  assert.equal(shell?.prompt, line);
});

test("exec: the shell run.created event is marked kind shell (thread filter)", async () => {
  install(new RecordingFakeVm());

  const res = await postExec({ cmd: "ls /workspace" });
  assert.equal(res.status, 201);
  const { runId } = await json(res);

  // The durable run log replays this event into the run summary; the thread
  // lists agent runs only, so the marker is what keeps a typed command from
  // showing up as a user message with an empty reply.
  const created = await waitForEvent(runId, "run.created");
  assert.equal(created.data.prompt, "ls /workspace");
  assert.equal(created.data.kind, "shell");
  await waitForEvent(runId, "run.finished");
});

test("exec: a simple raw command still runs through bash -lc", async () => {
  const driver = new RecordingFakeVm();
  install(driver);

  const res = await postExec({ cmd: 'echo "hello world" -n' });
  assert.equal(res.status, 201);
  const { runId } = await json(res);
  // The exec runs in the background; wait for it to finish before asserting.
  await waitForEvent(runId, "run.finished");
  assert.deepEqual(driver.calls[0].cmd, ["bash", "-lc", 'echo "hello world" -n']);
});

test("exec: array cmd runs as-is", async () => {
  const driver = new RecordingFakeVm();
  install(driver);

  const res = await postExec({ cmd: ["echo", "hi"] });
  assert.equal(res.status, 201);
  const { runId } = await json(res);
  // The exec runs in the background; wait for it to finish before asserting.
  await waitForEvent(runId, "run.finished");
  assert.deepEqual(driver.calls[0].cmd, ["echo", "hi"]);
});

test("exec: exec failure streams run.error on the shell run", async () => {
  class FailingFakeVm extends FakeVmDriver {
    override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      void h;
      void cmd;
      void opts;
      throw new Error("boom");
    }
  }
  install(new FailingFakeVm());

  // The POST starts the run immediately (the exec runs in the background, like
  // agent runs), so the failure surfaces as a run.error event on the bus.
  const res = await postExec({ cmd: "ls" });
  assert.equal(res.status, 201);
  const { runId } = await json(res);
  const error = await waitForEvent(runId, "run.error");
  assert.match(error.message, /boom/);

  const manager = getRuntimeManager();
  const runs = manager.list("alice");
  const shell = runs.find((r) => r.runId === runId);
  assert.equal(shell?.kind, "shell");
  assert.equal(shell?.status, "error");
});


/** A fake VM whose commands block until the exec abort signal fires. */
class BlockingFakeVm extends FakeVmDriver {
  started = false;
  aborted = false;

  override async exec(h: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    void h;
    void cmd;
    this.started = true;
    return new Promise<ExecResult>((_resolve, reject) => {
      const abort = () => {
        this.aborted = true;
        reject(new Error("Aborted"));
      };
      if (opts?.signal?.aborted) {
        abort();
        return;
      }
      opts?.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

test("exec cancel: DELETE stops an in-flight shell run and aborts the VM process", async () => {
  const driver = new BlockingFakeVm();
  install(driver);

  const res = await postExec({ cmd: "sleep 30" });
  assert.equal(res.status, 201);
  const { runId } = await json(res);
  await waitFor(() => driver.started);

  const cancel = await DELETE(request(`/api/runtime/vm/exec?runId=${runId}`, { method: "DELETE" }));
  assert.equal(cancel.status, 200);
  assert.deepEqual(await json(cancel), { ok: true, runId });

  const cancelled = await waitForEvent(runId, "run.cancelled");
  assert.equal(cancelled.reason, "user");
  await waitFor(() => driver.aborted);

  const manager = getRuntimeManager();
  const shell = manager.list("alice").find((r) => r.runId === runId);
  assert.equal(shell?.kind, "shell");
  assert.equal(shell?.status, "cancelled");
  assert.equal(shell?.cancelledReason, "user");

  // Cancelling a finished/unknown run is a 404.
  const again = await DELETE(request(`/api/runtime/vm/exec?runId=${runId}`, { method: "DELETE" }));
  assert.equal(again.status, 404);
});

test("exec cancel: auth and runId validation", async () => {
  install(new RecordingFakeVm());

  const unauth = await DELETE(
    request("/api/runtime/vm/exec?runId=run_x", { method: "DELETE" }, null),
  );
  assert.equal(unauth.status, 401);

  const missing = await DELETE(request("/api/runtime/vm/exec", { method: "DELETE" }));
  assert.equal(missing.status, 400);

  const bad = await DELETE(request("/api/runtime/vm/exec?runId=../../etc", { method: "DELETE" }));
  assert.equal(bad.status, 400);

  const unknown = await DELETE(request("/api/runtime/vm/exec?runId=run_missing", { method: "DELETE" }));
  assert.equal(unknown.status, 404);
});

test("exec: aborting the POST request cancels the run it started", async () => {
  const driver = new BlockingFakeVm();
  install(driver);

  const controller = new AbortController();
  const res = await POST(
    request(
      "/api/runtime/vm/exec",
      { method: "POST", body: JSON.stringify({ cmd: "sleep 30" }), signal: controller.signal },
    ),
  );
  assert.equal(res.status, 201);
  const { runId } = await json(res);
  await waitFor(() => driver.started);

  controller.abort();

  const cancelled = await waitForEvent(runId, "run.cancelled");
  assert.equal(cancelled.reason, "user");
  await waitFor(() => driver.aborted);
});
