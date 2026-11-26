/**
 * Shared fixtures and SSE helpers for the dispatch tests: the unit-level
 * `dispatch.test.ts` (default suite) and the opt-in spawn-based
 * `dispatch.e2e.test.ts` (`SWARM_RUN_DISPATCH_E2E=1`). One source of truth
 * keeps the recorded transcript, request builders, and the stream reader from
 * drifting apart between the two dispatch suites.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { createRouter } from "../../../lib/providers";
import { RuntimeManager, setRuntimeManagerForTesting } from "../../../lib/runtime/manager";
import type { SequencedEvent } from "../../../lib/telemetry/bus";
import { FakeVmDriver } from "../../../lib/vm/fake-driver";
import { VmManager } from "../../../lib/vm/manager";
import type { ExecOptions, ExecResult, VmHandle } from "../../../lib/vm/types";

export interface DispatchEvent extends SequencedEvent {
  sessionId?: string;
  model?: string;
  text?: string;
  exitCode?: number;
}

/** The gateway router both dispatch suites run against. */
export function gatewayRouter(): ReturnType<typeof createRouter> {
  return createRouter({
    providers: [
      { id: "gw-a", kind: "anthropic", rank: 0, baseUrl: "http://gw", keys: ["sk-test-gw-key-0000"] },
    ],
  });
}

/**
 * Base driver that records every exec call; a subclass serves the agent
 * command itself (replaying a transcript or spawning a binary) and returns
 * null for everything else, deferring to the base fake VM.
 */
export abstract class RecordingDispatchDriver extends FakeVmDriver {
  calls: Array<{ cmd: string[]; opts: ExecOptions }> = [];

  override async exec(handle: VmHandle, cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ cmd, opts });
    const agentResult = await this.execAgent(handle, cmd, opts);
    return agentResult === null ? super.exec(handle, cmd, opts) : agentResult;
  }

  protected abstract execAgent(handle: VmHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult | null>;
}

/** Point the runtime at a custom driver (and optional provider router). */
export function installRuntime(driver: FakeVmDriver, router?: ReturnType<typeof createRouter>): void {
  setRuntimeManagerForTesting(new RuntimeManager({ vm: new VmManager({ customDriver: driver }), router }));
}

/** Standard post-test runtime reset shared by both dispatch suites. */
export function useRuntimeCleanup(): void {
  test.afterEach(() => {
    setRuntimeManagerForTesting(null);
  });
}

/** A recorded stream-json transcript: init, assistant text + tool_use, tool result, final result. */
export function recordedLines(sessionId: string): unknown[] {
  return [
    { type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5-5" },
    { type: "assistant", message: { content: [{ type: "text", text: "checking the repo" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_dispatch", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_dispatch", content: "app\nlib", is_error: false }] } },
    { type: "result", subtype: "success", session_id: sessionId, cost_usd: 0.02, duration_ms: 42, num_turns: 2 },
  ];
}

export function dispatchTaskRequest(prompt: string, user: string): NextRequest {
  return new NextRequest("http://localhost/api/runtime/tasks", {
    method: "POST",
    headers: new Headers({ "x-swarm-user": user }),
    body: JSON.stringify({ prompt }),
  });
}

export function dispatchStreamRequest(runId: string, user: string): NextRequest {
  return new NextRequest(`http://localhost/api/runtime/stream/${runId}`, {
    headers: new Headers({ "x-swarm-user": user }),
  });
}

/** Read SSE frames from the handler until the terminal event arrives. */
export async function readUntil(res: Response, terminal: string): Promise<DispatchEvent[]> {
  assert.ok(res.body, "SSE response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: DispatchEvent[] = [];
  let carry = "";
  // Parse one SSE frame; returns true when the terminal event has arrived.
  const consumeFrame = (frame: string): boolean => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!data) return false; // keep-alive comment
    const event = JSON.parse(data.slice("data: ".length)) as DispatchEvent;
    events.push(event);
    if (event.type === "stream.error") {
      // The server aborted before a terminal state; surface the reason
      // instead of a cryptic "stream ended" timeout.
      throw new Error(`SSE stream aborted with error: ${JSON.stringify(event.data)}`);
    }
    return event.type === terminal;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const frames = carry.split("\n\n");
      carry = frames.pop() ?? "";
      if (frames.some(consumeFrame)) return events;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`SSE stream ended before ${terminal}: ${JSON.stringify(events)}`);
}

/**
 * The dispatch ordering invariants both dispatch suites must prove: the run
 * lifecycle arrives in order, terminal state is run.finished, and SSE ids are
 * gapless. Fixture-specific details (session id, model, text, exit code) are
 * asserted by each suite.
 */
export function assertDispatchOrdering(events: DispatchEvent[]): void {
  const indexOf = (type: string) => events.findIndex((event) => event.type === type);
  // run.created is published synchronously by POST; the VM is brought up,
  // then the run lifecycle starts and finishes, in that order.
  assert.equal(events[0]?.type, "run.created");
  for (const [earlier, later] of [
    ["run.created", "vm.starting"],
    ["vm.starting", "vm.ready"],
    ["vm.ready", "run.started"],
    ["run.started", "assistant.text"],
    ["assistant.text", "run.finished"],
  ] as const) {
    assert.ok(indexOf(earlier) < indexOf(later), `${earlier} must precede ${later}`);
  }
  assert.equal(events[events.length - 1]?.type, "run.finished");
  assert.equal(indexOf("run.error"), -1, "run.error must not appear");
  assert.equal(indexOf("vm.error"), -1, "vm.error must not appear");
  // SSE ids are monotonic and gapless for a fresh run.
  for (let i = 0; i < events.length; i++) assert.equal(events[i].seq, i + 1);
}

/**
 * Fixture-level lifecycle details both dispatch suites assert: the harness
 * session and model arrive with run.started, the assistant text is relayed,
 * and run.finished carries the exit code and session.
 */
export function assertDispatchLifecycle(events: DispatchEvent[], sessionId: string): void {
  const started = events.find((event) => event.type === "run.started");
  assert.equal(started?.sessionId, sessionId);
  assert.equal(started?.model, "claude-sonnet-5-5");

  const text = events.find((event) => event.type === "assistant.text");
  assert.equal(text?.text, "checking the repo");

  const finished = events.find((event) => event.type === "run.finished");
  assert.equal(finished?.exitCode, 0);
  assert.equal(finished?.sessionId, sessionId);
}

/**
 * Drive one dispatch end to end and return the SSE events up to
 * run.finished: assert the run was created, then read the stream for this
 * user's run id with the SSE content-type the handler must set.
 */
export async function dispatchEvents(post: Response, user: string): Promise<DispatchEvent[]> {
  assert.equal(post.status, 201);
  const { runId } = (await post.json()) as { runId: string };
  assert.match(runId, /^run_[A-Za-z0-9_-]+$/);
  const { GET: streamGET } = await import("./stream/[runId]/route");
  const res = await streamGET(dispatchStreamRequest(runId, user), { params: Promise.resolve({ runId }) });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  return readUntil(res, "run.finished");
}

/**
 * The harness contract for the agent exec: exactly one claude invocation,
 * stream-json argv shape, prompt after `--`, and provider keys never in argv.
 */
export function assertAgentExec(
  calls: Array<{ cmd: string[] }>,
  bin: string,
  prompt: string,
  secrets: readonly string[] = [],
): void {
  const agentCalls = calls.filter((call) => call.cmd[0] === bin);
  assert.equal(agentCalls.length, 1);
  const cmd = agentCalls[0].cmd;
  assert.deepEqual(cmd.slice(0, 5), [bin, "-p", "--output-format", "stream-json", "--verbose"]);
  assert.deepEqual(cmd.slice(-2), ["--", prompt]);
  for (const secret of secrets) {
    assert.equal(cmd.some((arg) => arg.includes(secret)), false);
  }
}
