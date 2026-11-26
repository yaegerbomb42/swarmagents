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
import type { ExecOptions, ExecResult, VmHandle } from "../../../lib/vm/types";
import { POST } from "./tasks/route";
import * as fx from "./dispatch-fixtures";

const USER = "dispatch-unit";

/** Fake VM driver that replays the recorded transcript without spawning. */
class ScriptedDispatchDriver extends fx.RecordingDispatchDriver {
  protected override async execAgent(_handle: VmHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult | null> {
    if (cmd[0] !== "claude") return null;
    for (const line of fx.recordedLines("sess_unit_1")) opts.onStdout?.(`${JSON.stringify(line)}\n`);
    return { exitCode: 0 };
  }
}

fx.useRuntimeCleanup();

test("dispatch streams run.created..run.finished in order with gapless SSE ids", { timeout: 30_000 }, async () => {
  const driver = new ScriptedDispatchDriver();
  fx.installRuntime(driver, fx.gatewayRouter());

  const post = await POST(fx.dispatchTaskRequest("run the dispatch", USER));
  const events = await fx.dispatchEvents(post, USER);

  fx.assertDispatchOrdering(events);

  fx.assertDispatchLifecycle(events, "sess_unit_1");

  fx.assertAgentExec(driver.calls, "claude", "run the dispatch", ["sk-test-gw-key-0000"]);
});
