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
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./tasks/route";
import { GET as streamGET } from "./stream/[runId]/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../lib/runtime/manager";
import { createRouter } from "../../../lib/providers";
import { VmManager } from "../../../lib/vm/manager";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../../../lib/vm/types";
import type { SequencedEvent } from "../../../lib/telemetry/bus";

const USER = "dispatch-unit";

// A recorded stream-json transcript: init, assistant text + tool_use, tool
// result, then the final result envelope (same shape as the e2e fixture).
const RECORDED_LINES = [
  { type: "system", subtype: "init", session_id: "sess_unit_1", model: "claude-sonnet-5-5" },
  { type: "assistant", message: { content: [{ type: "text", text: "checking the repo" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_unit", name: "Bash", input: { command: "ls" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_unit", content: "app\nlib", is_error: false }] } },
  { type: "result", subtype: "success", session_id: "sess_unit_1", cost_usd: 0.02, duration_ms: 42, num_turns: 2 },
];

interface DispatchEvent extends SequencedEvent {
  sessionId?: string;
  model?: string;
  text?: string;
  exitCode?: number;
}

/** Fake VM driver that replays the recorded transcript without spawning. */
class ScriptedDispatchDriver extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];

  override async exec(handle: VmHandle, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ cmd, opts });
    if (cmd[0] !== "claude") return super.exec(handle, cmd, opts);
    for (const line of RECORDED_LINES) opts.onStdout?.(`${JSON.stringify(line)}\n`);
    return { exitCode: 0 };
  }
}

function taskRequest(prompt: string): NextRequest {
  return new NextRequest("http://localhost/api/runtime/tasks", {
    method: "POST",
    headers: new Headers({ "x-swarm-user": USER }),
    body: JSON.stringify({ prompt }),
  });
}

function streamRequest(runId: string): NextRequest {
  return new NextRequest(`http://localhost/api/runtime/stream/${runId}`, {
    headers: new Headers({ "x-swarm-user": USER }),
  });
}

/** Read SSE frames from the handler until the terminal event arrives. */
async function readUntil(res: Response, terminal: string): Promise<DispatchEvent[]> {
  assert.ok(res.body, "SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: DispatchEvent[] = [];
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue; // keep-alive comment
        const event = JSON.parse(data.slice("data: ".length)) as DispatchEvent;
        events.push(event);
        if (event.type === "stream.error") {
          throw new Error(`SSE stream aborted with error: ${JSON.stringify(event.data)}`);
        }
        if (event.type === terminal) return events;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`SSE stream ended before ${terminal}: ${JSON.stringify(events)}`);
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

  const post = await POST(taskRequest("run the dispatch"));
  assert.equal(post.status, 201);
  const { runId } = (await post.json()) as { runId: string };
  assert.match(runId, /^run_[A-Za-z0-9_-]+$/);

  const res = await streamGET(streamRequest(runId), { params: Promise.resolve({ runId }) });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const events = await readUntil(res, "run.finished");

  const types = events.filter((event) => event.type !== "run.mode").map((event) => event.type);
  // run.created is published synchronously by POST; the VM is brought up,
  // then the run lifecycle starts and finishes, in that order.
  assert.equal(types[0], "run.created");
  assert.equal(types[1], "vm.starting");
  assert.equal(types[2], "vm.ready");
  assert.equal(types[3], "run.started");
  assert.equal(types[types.length - 1], "run.finished");
  assert.ok(types.indexOf("run.started") < types.indexOf("assistant.text"));
  assert.ok(types.indexOf("assistant.text") < types.indexOf("run.finished"));
  assert.ok(!types.includes("run.error"));
  assert.ok(!types.includes("vm.error"));

  const started = events.find((event) => event.type === "run.started");
  assert.equal(started?.sessionId, "sess_unit_1");
  assert.equal(started?.model, "claude-sonnet-5-5");

  const text = events.find((event) => event.type === "assistant.text");
  assert.equal(text?.text, "checking the repo");

  const finished = events.find((event) => event.type === "run.finished");
  assert.equal(finished?.exitCode, 0);
  assert.equal(finished?.sessionId, "sess_unit_1");

  // SSE ids are monotonic and gapless for a fresh run.
  for (let i = 0; i < events.length; i++) assert.equal(events[i].seq, i + 1);

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
