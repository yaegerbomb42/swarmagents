// Resume seam: the one place the runtime reaches into the agent to run a task.
//
// The runtime deliberately does NOT import lib/agent.ts directly. Instead, the agent
// core registers an adapter here once at startup:
//
//   import { setAgentAdapter } from "@/lib/runtime/resume";
//   setAgentAdapter({
//     run(sessionId, prompt, hooks) { ... return summary ... },
//     stop(sessionId) { ... },
//   });
//
// This keeps the two layers decoupled: the agent owns model I/O, the runtime owns
// durability, budgets and scheduling. Either can change without breaking the other, and
// the runtime is fully unit-testable with a fake adapter.

import type { Task } from "./types";

export interface RunHooks {
  /** Called on each model turn with usage, so the ledger and budget checks stay current. */
  onTurn(usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd?: number; provider?: string; model?: string }): void;
  /** Called for each tool invocation. */
  onTool(name: string, ok: boolean): void;
  /** Called with free-form progress notes ("waited 90s on quota"). */
  onNote(text: string): void;
  /** Called when the agent pauses on a rate limit; the runtime records a wait reason. */
  onQuotaWait(ms: number, message: string): void;
  /** Aborting this signal stops the underlying run. */
  signal: AbortSignal;
}

export interface RunOutcome {
  /** The agent's final summary for the user. */
  summary: string;
  /** Absolute paths of files the agent wants surfaced as artifacts. */
  outputs?: { path: string; title?: string }[];
  /** Did the agent verify its own work? */
  verified?: boolean;
  /** If the agent stopped because it needs the user, say so; the task becomes blocked. */
  needs?: { kind: "approval" | "input"; message: string };
}

export interface AgentAdapter {
  /** Run a task's prompt in its session to completion, streaming usage through hooks. */
  run(task: Task, hooks: RunHooks): Promise<RunOutcome>;
  /** Abort an in-flight run for this session, if any. */
  stop(sessionId: string): void;
  /** Is a run currently active for this session? */
  isRunning(sessionId: string): boolean;
}

let adapter: AgentAdapter | null = null;

export function setAgentAdapter(a: AgentAdapter): void {
  adapter = a;
}

export function getAgentAdapter(): AgentAdapter | null {
  return adapter;
}

/** Thrown when the runtime is asked to run but the agent core never registered an adapter. */
export class NoAdapterError extends Error {
  constructor() {
    super("The agent adapter is not registered. Import lib/runtime/bootstrap and call it, or setAgentAdapter().");
    this.name = "NoAdapterError";
  }
}

export function requireAdapter(): AgentAdapter {
  if (!adapter) throw new NoAdapterError();
  return adapter;
}