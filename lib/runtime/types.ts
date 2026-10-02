// Runtime control-plane types: the durable layer that keeps long-running work alive
// across restarts, quota waits and process crashes.
//
// This module is deliberately independent of lib/types.ts (which the agent core owns)
// so the runtime can evolve without contending with the agent loop.

/** Lifecycle of a unit of work the agent must eventually finish. */
export type TaskStatus =
  | "queued" // waiting for a slot
  | "running" // a session is actively working on it
  | "waiting" // paused (quota/backoff/needs input); will resume automatically
  | "blocked" // needs the user (approval or a decision); will not resume on its own
  | "done"
  | "failed"
  | "cancelled";

/** Why a task is not currently running, so the UI can explain the pause. */
export interface WaitReason {
  kind: "quota" | "backoff" | "approval" | "input" | "schedule";
  message: string;
  /** Epoch ms at which we will retry. Absent for approval/input waits. */
  resumeAt?: number;
  /** For approval waits: the exact action hash the user must approve. Lets Approve authorise one action. */
  token?: string;
}

export interface TaskBudget {
  /** Hard wall-clock limit for the whole task, in ms. 0 means no limit. */
  maxDurationMs: number;
  /** Soft cap on total model tokens (input+output) before we pause and ask. 0 = no cap. */
  maxTokens: number;
  /** Cap on total spend in USD before we pause and ask. 0 = no cap. */
  maxCostUsd: number;
  /** How many attempts to allow before declaring failure. 0 = rely on the agent. */
  maxAttempts: number;
}

export const DEFAULT_BUDGET: TaskBudget = { maxDurationMs: 0, maxTokens: 0, maxCostUsd: 0, maxAttempts: 0 };

/** A durable work item. Everything the runtime needs to resume it after a restart. */
export interface Task {
  id: string;
  /** The session that carries this task's chat history and files. */
  sessionId: string;
  title: string;
  /** The original instruction, kept verbatim so a resume never loses intent. */
  prompt: string;
  /** Absolute paths of uploaded inputs, if any. */
  inputs: string[];
  status: TaskStatus;
  wait?: WaitReason;
  /** 1-based attempt counter; incremented each time the loop is (re)started. */
  attempts: number;
  budget: TaskBudget;
  /** Accumulated usage across every attempt. */
  usage: RunUsage;
  /** How the task ended, once terminal. */
  result?: TaskResult;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Set when the task is created by a schedule rather than a human. */
  origin?: "human" | "schedule" | "subagent";
  priority: number;
  tags: string[];
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
  wallMs: number;
}

export const EMPTY_USAGE: RunUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, turns: 0, toolCalls: 0, wallMs: 0 };

export interface TaskResult {
  summary: string;
  /** Artifact ids produced by this task. */
  artifactIds: string[];
  /** True if the agent's own verification steps passed. */
  verified: boolean;
  outcome: "success" | "failed" | "cancelled";
}

/** One attempt to run a task. Kept so the ledger can show a real timeline. */
export interface RunRecord {
  id: string;
  taskId: string;
  sessionId: string;
  attempt: number;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "failed" | "interrupted";
  usage: RunUsage;
  provider?: string;
  model?: string;
  /** Non-fatal notes the runtime wants the user to see (e.g. "waited 90s on quota"). */
  notes: string[];
}

/** A single distilled step in the ledger (a turn or a tool call). */
export interface StepRecord {
  id: string;
  runId: string;
  taskId: string;
  ts: number;
  kind: "turn" | "tool" | "notice" | "checkpoint";
  label: string;
  detail?: string;
  ok?: boolean;
  tokens?: number;
  costUsd?: number;
}

/** A first-class result object. Any file, image, diff, url or text the agent produced. */
export type ArtifactKind = "file" | "image" | "diff" | "url" | "text" | "log" | "data";

export interface Artifact {
  id: string;
  taskId: string;
  runId?: string;
  kind: ArtifactKind;
  title: string;
  /** Where the bytes live on disk, if this points at a file. */
  path?: string;
  /** Inline payload for small text/data artifacts. */
  text?: string;
  /** For urls or provenance. */
  url?: string;
  mime?: string;
  size?: number;
  createdAt: number;
  /** Has the user kept this as a deliverable vs. a scratch output. */
  kept?: boolean;
}

/** Runtime-wide settings the user can steer without touching provider config. */
export interface RuntimeSettings {
  /** Keep working automatically across quota waits instead of stopping. */
  autoResume: boolean;
  /** Max parallel tasks the scheduler will run. */
  concurrency: number;
  /** Default budget applied to new human tasks. */
  defaultBudget: TaskBudget;
  /** If true, the agent is asked to verify its own work before a task is marked done. */
  requireVerification: boolean;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  autoResume: true,
  concurrency: 1,
  defaultBudget: DEFAULT_BUDGET,
  requireVerification: true,
};