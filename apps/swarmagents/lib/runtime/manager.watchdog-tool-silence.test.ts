/**
 * FIX-18: watchdog tool-in-flight signal.
 *
 * A started run that goes silent while a tool is still in flight (tool.call
 * seen, no tool.result yet) gets the longer tool-silence window: the silence
 * most likely means work is running inside the VM (a big build, a long test
 * suite) with nothing to report, not a wedge. Silence with no tool in
 * flight still dies at the plain silence window, a tool that hangs past
 * even the long window is still declared stuck, and once the tool result
 * lands the plain window applies again.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeManager } from "./manager";
import { VmManager } from "../vm/manager";
import { FakeVmDriver } from "../vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../vm/types";
import type { RunSummary } from "./manager";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess_tool",
  model: "claude-test",
});
const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "sess_tool",
  cost_usd: 0,
  duration_ms: 1,
  num_turns: 1,
});
// A read of a workspace file classifies "allow", so the fake stream never
// trips the approval gate; what matters here is the call/result pairing.
const TOOL_CALL_LINE = JSON.stringify({
  type: "assistant",
  message: {
    id: "msg_tool",
    role: "assistant",
    model: "claude-test",
    content: [
      {
        type: "tool_use",
        id: "toolu_slow",
        name: "Read",
        input: { file_path: "/workspace/build.log" },
      },
    ],
  },
  session_id: "sess_tool",
});
const TOOL_RESULT_LINE = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_slow", content: "file contents" }],
  },
  session_id: "sess_tool",
});

async function waitFor(
  manager: RuntimeManager,
  userId: string,
  pred: (runs: RunSummary[]) => boolean,
  steps = 400,
): Promise<RunSummary[]> {
  for (let i = 0; i < steps; i++) {
    const runs = manager.list(userId);
    if (pred(runs)) return runs;
    await sleep(10);
  }
  throw new Error("timed out waiting for run state");
}

/**
 * Sleep in small steps so an aborted exec returns promptly. Resolves true
 * when the full delay elapsed, false when the abort landed first.
 */
async function sleepUnlessAborted(opts: ExecOptions | undefined, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (opts?.signal?.aborted) return false;
    await sleep(Math.min(20, deadline - Date.now()));
  }
  return !opts?.signal?.aborted;
}

test("a silent run with a tool in flight survives past the silence window", async () => {
  // The tool runs silently for 400ms — past the 150ms plain silence window,
  // well inside the tool-silence window. Without the tool-in-flight signal
  // the watchdog finalizes the run mid-tool.
  class SlowToolDriver extends FakeVmDriver {
    override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
      opts?.onStdout?.(`${INIT_LINE}\n`);
      opts?.onStdout?.(`${TOOL_CALL_LINE}\n`);
      if (!(await sleepUnlessAborted(opts, 400))) return { exitCode: 130 };
      opts?.onStdout?.(`${TOOL_RESULT_LINE}\n`);
      opts?.onStdout?.(`${RESULT_LINE}\n`);
      return { exitCode: 0 };
    }
  }

  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: new SlowToolDriver() }),
    router: null,
    startGraceMs: 5000,
    silenceMs: 150,
    toolSilenceMs: 5000,
    watchdogSweepMs: 20,
  });

  const started = manager.start("alice", { prompt: "long silent tool" });
  assert.equal(started.accepted, true);

  const runs = await waitFor(manager, "alice", (all) =>
    all.find((run) => run.runId === started.runId)?.status === "finished",
  );
  assert.equal(runs.find((run) => run.runId === started.runId)?.status, "finished");
});

test("a silent run with no tool in flight is still killed at the silence window", async () => {
  // Same silence, no tool.call: the plain window applies and the run is
  // declared stuck exactly as before.
  class SilentDriver extends FakeVmDriver {
    override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
      opts?.onStdout?.(`${INIT_LINE}\n`);
      await sleepUnlessAborted(opts, 5000);
      return { exitCode: 130 };
    }
  }

  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: new SilentDriver() }),
    router: null,
    startGraceMs: 5000,
    silenceMs: 150,
    toolSilenceMs: 5000,
    watchdogSweepMs: 20,
  });

  const started = manager.start("alice", { prompt: "silent, no tool" });
  assert.equal(started.accepted, true);

  const runs = await waitFor(manager, "alice", (all) =>
    all.find((run) => run.runId === started.runId)?.status === "error",
  );
  const run = runs.find((candidate) => candidate.runId === started.runId);
  assert.ok((run?.error ?? "").includes("silent for too long"), `unexpected error: ${run?.error}`);
});

test("a tool silent past the tool-silence cap is still declared stuck", async () => {
  // The extension is capped: the run survives the plain window while the
  // tool is in flight, but once silence passes the tool-silence cap the
  // watchdog finalizes it — a hung tool does not hold the slot forever.
  class HungToolDriver extends FakeVmDriver {
    override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
      opts?.onStdout?.(`${INIT_LINE}\n`);
      opts?.onStdout?.(`${TOOL_CALL_LINE}\n`);
      await sleepUnlessAborted(opts, 5000);
      return { exitCode: 130 };
    }
  }

  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: new HungToolDriver() }),
    router: null,
    startGraceMs: 5000,
    silenceMs: 150,
    toolSilenceMs: 500,
    watchdogSweepMs: 20,
  });

  const started = manager.start("alice", { prompt: "hung tool" });
  assert.equal(started.accepted, true);

  // Past the plain silence window (150ms) the run must still be alive: a
  // tool is in flight, so the 500ms tool-silence cap governs.
  await sleep(300);
  assert.equal(
    manager.list("alice").find((run) => run.runId === started.runId)?.status,
    "running",
  );

  const runs = await waitFor(manager, "alice", (all) =>
    all.find((run) => run.runId === started.runId)?.status === "error",
  );
  const run = runs.find((candidate) => candidate.runId === started.runId);
  assert.ok((run?.error ?? "").includes("silent for too long"), `unexpected error: ${run?.error}`);
});

test("once the tool result lands, silence kills at the plain window again", async () => {
  // The in-flight mark is cleared by tool.result: a run that goes silent
  // after its tool completed dies at the plain window, not the long one.
  class QuickToolThenSilentDriver extends FakeVmDriver {
    override async exec(handle: VmHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
      opts?.onStdout?.(`${INIT_LINE}\n`);
      opts?.onStdout?.(`${TOOL_CALL_LINE}\n`);
      opts?.onStdout?.(`${TOOL_RESULT_LINE}\n`);
      await sleepUnlessAborted(opts, 5000);
      return { exitCode: 130 };
    }
  }

  const manager = new RuntimeManager({
    vm: new VmManager({ customDriver: new QuickToolThenSilentDriver() }),
    router: null,
    startGraceMs: 5000,
    silenceMs: 150,
    toolSilenceMs: 5000,
    watchdogSweepMs: 20,
  });

  const started = manager.start("alice", { prompt: "quick tool, then silence" });
  assert.equal(started.accepted, true);

  const t0 = Date.now();
  const runs = await waitFor(manager, "alice", (all) =>
    all.find((run) => run.runId === started.runId)?.status === "error",
  );
  assert.ok(
    Date.now() - t0 < 2000,
    "run should die at the plain silence window once no tool is in flight",
  );
  const run = runs.find((candidate) => candidate.runId === started.runId);
  assert.ok((run?.error ?? "").includes("silent for too long"), `unexpected error: ${run?.error}`);
});
