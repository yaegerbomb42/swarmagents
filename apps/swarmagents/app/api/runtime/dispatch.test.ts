/**
 * Unit-level dispatch ordering proof: real API handlers + scripted fake VM
 * driver + the SSE stream handler, with no child process.
 *
 * This is the default-suite substitute for `dispatch.e2e.test.ts` (opt-in via
 * `SWARM_RUN_DISPATCH_E2E=1`), which spawns a real fake-`claude` binary and
 * can hang in sandboxed worker environments. Here the driver replays a
 * recorded `claude --output-format stream-json` transcript through
 * `opts.onStdout`, so the same loop is exercised — POST /api/runtime/tasks ->
 * RuntimeManager -> ClaudeCodeRunner -> FakeVmDriver -> telemetry bus ->
 * GET /api/runtime/stream — while nothing is left waiting on the event loop.
 * Shared transcript/request/stream-reader helpers live in dispatch-fixtures.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "./tasks/route";
import { GET as streamGET } from "./stream/[runId]/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../lib/runtime/manager";
import { createRouter } from "../../../lib/providers";
import { VmManager } from "../../../lib/vm/manager";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../../../lib/vm/types";
import {
  assertDispatchLifecycle,
  assertDispatchOrdering,
  dispatchStreamRequest,
  dispatchTaskRequest,
  readUntil,
  recordedLines,
} from "./dispatch-fixtures";

const USER = "dispatch-unit";

/** Fake VM driver that replays the recorded transcript without spawning. */
class ScriptedDispatchDriver extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];

  override async exec(handle: VmHandle, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ cmd, opts });
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    for (const line of recordedLines("sess_unit_1")) opts.onStdout?.(`${JSON.stringify(line)}\n`);
    return { exitCode: 0 };
  }
}

test.afterEach(() => {
  setRuntimeManagerForTesting(null);
});

test("dispatch streams run.created..run.finished in order with gapless SSE ids", { timeout: 30_000 }, async () => {
  const router = createRouter({
    providers: [
      { id: "gw-a", kind: "anthropic", baseUrl: "http://gw", rank: 0, keys: ["sk-test-gw-key-0000"] },
    ],
  });
  const driver = new ScriptedDispatchDriver();
  setRuntimeManagerForTesting(new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router }));

  const post = await POST(dispatchTaskRequest("run the dispatch", USER));
  assert.equal(post.status, 201);
  const { runId } = (await post.json()) as { runId: string };
  assert.match(runId, /^run_[A-Za-z0-9_-]+$/);

  const res = await streamGET(dispatchStreamRequest(runId, USER), { params: Promise.resolve({ runId }) });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events = await readUntil(res, "run.finished");

  assertDispatchOrdering(events);

  assertDispatchLifecycle(events, "sess_unit_1");

  // The driver received exactly one agent exec (the RunReporter's background
  // workspace listing/screenshot execs are filtered out), with the prompt in
  // argv, the harness contract flags in order, and provider keys kept out of
  // argv.
  const agentCalls = driver.calls.filter((call) => call.cmd[0] === "claude");
  assert.equal(agentCalls.length, 1);
  const cmd = agentCalls[0].cmd;
  assert.deepEqual(cmd.slice(0, 5), ["claude", "-p", "--output-format", "stream-json", "--verbose"]);
  assert.deepEqual(cmd.slice(-2), ["--", "run the dispatch"]);
  assert.equal(cmd.some((arg) => arg.includes("sk-test-gw-key-0000")), false);
});
