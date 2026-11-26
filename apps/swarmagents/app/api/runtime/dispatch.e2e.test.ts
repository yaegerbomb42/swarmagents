/**
 * End-to-end dispatch test: real API handlers + fake VM driver + fake claude
 * binary + the SSE stream handler.
 *
 * A recorded `claude --output-format stream-json` transcript is written to an
 * executable "claude" script on disk. The fake VM driver spawns that script so
 * the whole loop is exercised: POST /api/runtime/tasks -> RuntimeManager ->
 * ClaudeCodeRunner -> fake VM -> telemetry bus -> GET /api/runtime/stream.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST } from "./tasks/route";
import { GET as streamGET } from "./stream/[runId]/route";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../lib/runtime/manager";
import { VmManager } from "../../../lib/vm/manager";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import type { ExecOptions, ExecResult, VmHandle } from "../../../lib/vm/types";
import type { SequencedEvent } from "../../../lib/telemetry/bus";

const USER = "e2e-dispatch";

// Spawns a real fake-`claude` child and blocks on the SSE stream for
// run.finished, which can hang in sandboxed worker environments. Opt in with
// SWARM_RUN_DISPATCH_E2E=1 (see README "Running tests"); the default suite
// proves the same ordering invariants in dispatch.test.ts with a scripted
// driver that never spawns and never leaves the event loop open.
const RUN_DISPATCH_E2E = process.env.SWARM_RUN_DISPATCH_E2E === "1";
const DISPATCH_E2E_TIMEOUT_MS = 120_000;

// A recorded stream-json transcript: init, assistant text + tool_use, tool
// result, then the final result envelope.
const RECORDED_LINES = [
  { type: "system", subtype: "init", session_id: "sess_e2e_1", model: "claude-sonnet-5-5" },
  { type: "assistant", message: { content: [{ type: "text", text: "checking the repo" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_e2e", name: "Bash", input: { command: "ls" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_e2e", content: "app\nlib", is_error: false }] } },
  { type: "result", subtype: "success", session_id: "sess_e2e_1", cost_usd: 0.02, duration_ms: 42, num_turns: 2 },
];

interface DispatchEvent extends SequencedEvent {
  sessionId?: string;
  model?: string;
  text?: string;
  exitCode?: number;
}

/** Fake VM driver that actually spawns the recorded fake claude binary. */
class BinaryFakeVmDriver extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];

  constructor(private readonly claudeBin: string) {
    super();
  }

  override async exec(handle: VmHandle, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ cmd, opts });
    if (cmd[0] !== this.claudeBin) return super.exec(handle, cmd, opts);

    return new Promise<ExecResult>((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), {
        // `opts.cwd` is the VM-relative workspace path (e.g. /workspace),
        // which does not exist on the host. This driver runs the recorded
        // transcript on the host, so let the child inherit the host cwd.
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onAbort = () => child.kill("SIGTERM");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => opts.onStdout?.(chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => opts.onStderr?.(chunk.toString("utf8")));
      child.on("error", (error) => {
        opts.signal?.removeEventListener("abort", onAbort);
        opts.onStderr?.(`${error.message}\n`);
        resolve({ exitCode: 1 });
      });
      child.on("close", (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode: code ?? 1 });
      });
    });
  }
}

function makeFakeClaude(dir: string): string {
  const fixture = join(dir, "stream-json.fixture");
  writeFileSync(fixture, `${RECORDED_LINES.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  const bin = join(dir, "claude");
  // Read prompt from the argument after `--` (kept for harness contract parity).
  writeFileSync(
    bin,
    `#!/bin/sh
prompt=""
seen=""
for arg in "$@"; do
  if [ "$seen" = "1" ]; then prompt="$arg"; break; fi
  if [ "$arg" = "--" ]; then seen="1"; fi
done
exec cat "${fixture}"
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return bin;
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
          // The server aborted before a terminal state; surface the reason
          // instead of a cryptic "stream ended" timeout.
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

test(
  "POST dispatches to the fake claude binary and SSE streams started..finished in order",
  { skip: !RUN_DISPATCH_E2E, timeout: DISPATCH_E2E_TIMEOUT_MS },
  async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-e2e-"));
  const previousBin = process.env.CLAUDE_BIN;
  try {
    const claudeBin = makeFakeClaude(dir);
    process.env.CLAUDE_BIN = claudeBin;
    const driver = new BinaryFakeVmDriver(claudeBin);
    setRuntimeManagerForTesting(new RuntimeManager({ vm: new VmManager({ customDriver: driver }) }));

    const post = await POST(taskRequest("run the e2e dispatch"));
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

    const ready = events.find((event) => event.type === "vm.ready");
    const readyData = ready?.data as { ms?: number } | undefined;
    assert.equal(typeof readyData?.ms, "number");

    const started = events.find((event) => event.type === "run.started");
    assert.equal(started?.sessionId, "sess_e2e_1");
    assert.equal(started?.model, "claude-sonnet-5-5");

    const text = events.find((event) => event.type === "assistant.text");
    assert.equal(text?.text, "checking the repo");

    const finished = events.find((event) => event.type === "run.finished");
    assert.equal(finished?.exitCode, 0);
    assert.equal(finished?.sessionId, "sess_e2e_1");

    // SSE ids are monotonic and gapless for a fresh run.
    for (let i = 0; i < events.length; i++) assert.equal(events[i].seq, i + 1);

    // The driver really invoked the fake binary (the RunReporter's background
    // workspace listing/screenshot execs are filtered out), with the prompt in
    // argv and provider keys kept out of argv.
    const agentCalls = driver.calls.filter((call) => call.cmd[0] === claudeBin);
    assert.equal(agentCalls.length, 1);
    const cmd = agentCalls[0].cmd;
    assert.deepEqual(cmd.slice(0, 5), [claudeBin, "-p", "--output-format", "stream-json", "--verbose"]);
    assert.deepEqual(cmd.slice(-2), ["--", "run the e2e dispatch"]);
  } finally {
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    rmSync(dir, { recursive: true, force: true });
  }
  },
);