/**
 * Shared fixtures and SSE helpers for the dispatch tests: the unit-level
 * `dispatch.test.ts` (default suite) and the opt-in spawn-based
 * `dispatch.e2e.test.ts` (`SWARM_RUN_DISPATCH_E2E=1`). One source of truth
 * keeps the recorded transcript, request builders, and the stream reader from
 * drifting apart between the two dispatch suites.
 */

import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { SequencedEvent } from "../../../lib/telemetry/bus";

export interface DispatchEvent extends SequencedEvent {
  sessionId?: string;
  model?: string;
  text?: string;
  exitCode?: number;
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

/**
 * The dispatch ordering invariants both dispatch suites must prove: the run
 * lifecycle arrives in order, terminal state is run.finished, and SSE ids are
 * gapless. Fixture-specific details (session id, model, text, exit code) are
 * asserted by each suite.
 */
export function assertDispatchOrdering(events: DispatchEvent[]): void {
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
