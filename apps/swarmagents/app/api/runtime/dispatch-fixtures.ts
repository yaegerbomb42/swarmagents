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
