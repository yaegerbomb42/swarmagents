// Bootstrap: connect the durable runtime to the agent core.
//
// This is the only file that knows both layers. It registers an AgentAdapter that drives
// a session via lib/agent's public surface, then starts the scheduler. Import it once at
// server boot (from instrumentation-node.ts) or from any runtime API route; it is
// idempotent.

import { session } from "../agent";
import { setAgentAdapter, type RunHooks, type RunOutcome } from "./resume";
import { scheduler } from "./scheduler";
import type { Task } from "./types";

/** Wait until the session reports it has stopped working, polling without a busy loop. */
async function waitUntilIdle(sessionId: string, signal: AbortSignal, onNote: (s: string) => void): Promise<void> {
  // Give the loop a moment to flip "running" true after send().
  await sleep(60, signal);
  let waited = 0;
  for (;;) {
    if (signal.aborted) return;
    const s = session(sessionId);
    if (!s) return;
    if (!s.running) return;
    if (waited > 0 && waited % 60_000 < 250) onNote(`Still working (${Math.round(waited / 60000)}m).`);
    await sleep(250, signal);
    waited += 250;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
  });

/** Pull a final summary from the session: the last assistant text, or the last notice. */
function lastSummary(sessionId: string): string {
  const s = session(sessionId);
  if (!s) return "Session not found.";
  const events = s.events.filter((e) => !(e as { hidden?: boolean }).hidden);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "text" && e.done && e.text.trim()) return e.text.trim();
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "notice") return e.text;
  }
  return "Finished.";
}

/** Did the user's own turn end with an error notice? Used for the verified/outcome flags. */
function endedWithError(sessionId: string): boolean {
  const s = session(sessionId);
  if (!s) return true;
  const tail = s.events.slice(-8);
  return tail.some((e) => e.type === "notice" && e.level === "error");
}

export function bootstrapRuntime(): void {
  const g = globalThis as unknown as { __swarmRuntimeBooted?: boolean };
  if (g.__swarmRuntimeBooted) return;
  g.__swarmRuntimeBooted = true;

  setAgentAdapter({
    async run(task: Task, hooks: RunHooks): Promise<RunOutcome> {
      const s = session(task.sessionId);
      if (!s) throw new Error(`Session ${task.sessionId} not found for task ${task.id}.`);

      // A resumed task's session may already hold prior turns; send() appends safely.
      s.send(task.prompt, []);

      // Bridge the abort signal into the session so the scheduler can stop it.
      const onAbort = () => s.stop();
      hooks.signal.addEventListener("abort", onAbort, { once: true });

      // Mirror live session events into the ledger so the Activity view stays current.
      const mirror = (op: { op: string; event?: unknown }) => {
        if (op.op !== "add") return;
        const e = op.event as import("../types").AgentEvent;
        if (e.type === "turn") {
          hooks.onTurn({
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            cachedTokens: e.cachedTokens,
            provider: e.provider,
            model: e.model,
          });
        } else if (e.type === "tool") {
          hooks.onTool(e.name, e.status === "ok");
        } else if (e.type === "notice" && e.level !== "info") {
          hooks.onNote(e.text);
        }
      };
      s.subs.add(mirror);

      try {
        await waitUntilIdle(task.sessionId, hooks.signal, hooks.onNote);
      } finally {
        s.subs.delete(mirror);
        hooks.signal.removeEventListener("abort", onAbort);
      }

      const summary = lastSummary(task.sessionId);
      const failed = endedWithError(task.sessionId);
      return {
        summary,
        verified: !failed,
        outputs: [],
      };
    },
    stop(sessionId: string) {
      session(sessionId)?.stop();
    },
    isRunning(sessionId: string) {
      return session(sessionId)?.running ?? false;
    },
  });

  scheduler().start();
}