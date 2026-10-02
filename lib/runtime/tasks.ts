// Task queue: the durable state machine for units of work.
//
// A task outlives the process. It moves through a small, explicit set of states and
// every transition is persisted before it is announced, so a crash can never lose a
// task or leave it "running" forever. Subscribers get a tiny event stream the UI can
// bind to; it is intentionally separate from the agent's AgentEvent stream because it
// describes orchestration, not model output.

import { createSession, currentUser, deleteSession } from "../store";
import { loadRuntimeSettings, loadTasks, rtId, withTasks } from "./store";
import {
  DEFAULT_BUDGET,
  EMPTY_USAGE,
  type Task,
  type TaskBudget,
  type TaskResult,
  type TaskStatus,
  type WaitReason,
} from "./types";

export type RuntimeEvent =
  | { type: "task"; task: Task; userId?: string }
  | { type: "removed"; id: string; userId?: string };

const subs = new Set<(e: RuntimeEvent) => void>();

export function subscribeRuntime(fn: (e: RuntimeEvent) => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

function announce(e: RuntimeEvent) {
  let uid: string | undefined;
  try {
    uid = currentUser();
  } catch {}
  if (uid) {
    if (!e.userId) e.userId = uid;
    if (e.type === "task" && e.task && !e.task.userId) e.task.userId = uid;
  }
  for (const s of subs) {
    try {
      s(e);
    } catch {}
  }
}

export interface CreateTaskInput {
  prompt: string;
  title?: string;
  inputs?: string[];
  budget?: Partial<TaskBudget>;
  origin?: Task["origin"];
  priority?: number;
  tags?: string[];
  /** Reuse an existing session (e.g. the one the user is typing in) instead of a new one. */
  sessionId?: string;
}

function titleFrom(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 70) || "New task";
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const settings = loadRuntimeSettings();
  const sessionId = input.sessionId ?? createSession().id;
  const now = Date.now();
  const task: Task = {
    id: rtId(),
    sessionId,
    title: input.title?.trim() || titleFrom(input.prompt),
    prompt: input.prompt,
    inputs: input.inputs ?? [],
    status: "queued",
    attempts: 0,
    budget: { ...DEFAULT_BUDGET, ...settings.defaultBudget, ...input.budget },
    usage: { ...EMPTY_USAGE },
    createdAt: now,
    updatedAt: now,
    origin: input.origin ?? "human",
    priority: input.priority ?? 0,
    tags: input.tags ?? [],
    userId: (() => {
      try {
        return currentUser();
      } catch {
        return undefined;
      }
    })(),
  };
  await withTasks((tasks) => {
    tasks.push(task);
    return tasks;
  });
  // Announce only after the write has committed: a subscriber that re-reads storage to prove
  // ownership (lib/runtime/stream-filter.ts) must be able to see the row it is being told about.
  // Announcing inside withTasks() fired before saveTasks(), so a brand-new task was invisible to
  // the account's own stream until the 10s sweep — measured ~9.8s of dead latency on create.
  announce({ type: "task", task });
  return task;
}

const rank = (t: Task) =>
  t.status === "running" ? 0 : t.status === "queued" || t.status === "waiting" ? 1 : 2;

export function listTasks(): Task[] {
  return loadTasks()
    .slice()
    .sort((a, b) => rank(a) - rank(b) || b.priority - a.priority || b.createdAt - a.createdAt);
}

export function getTask(id: string): Task | null {
  return loadTasks().find((t) => t.id === id) ?? null;
}

/**
 * The live task bound to a session, if any. A task run drives a normal session, so the session's
 * stop route must find the owning task and abort it through the scheduler - otherwise stopping the
 * session lets the scheduler's run settle as "done" and the task does not actually stop.
 */
export function taskForSession(sessionId: string): Task | null {
  return loadTasks().find((t) => t.sessionId === sessionId && (t.status === "running" || t.status === "queued" || t.status === "waiting")) ?? null;
}

/** Apply a mutation to one task atomically and announce the result. */
export async function updateTask(id: string, fn: (t: Task) => void): Promise<Task | null> {
  let out: Task | null = null;
  await withTasks((tasks) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    fn(t);
    t.updatedAt = Date.now();
    out = { ...t };
  });
  // Announced after commit, not inside the write (see createTask): the stream proves ownership by
  // re-reading storage, which must already contain the update we are broadcasting.
  if (out) announce({ type: "task", task: out });
  return out;
}

export async function setStatus(id: string, status: TaskStatus, wait?: WaitReason): Promise<Task | null> {
  return updateTask(id, (t) => {
    t.status = status;
    t.wait = status === "waiting" || status === "blocked" ? wait : undefined;
    if (status === "running") {
      if (!t.startedAt) t.startedAt = Date.now();
      t.attempts += 1;
    }
    if (status === "done" || status === "failed" || status === "cancelled") t.finishedAt = Date.now();
  });
}

export async function finishTask(id: string, result: TaskResult): Promise<Task | null> {
  return updateTask(id, (t) => {
    t.status = result.outcome === "success" ? "done" : result.outcome === "cancelled" ? "cancelled" : "failed";
    t.result = result;
    t.finishedAt = Date.now();
    t.wait = undefined;
  });
}

/** Mark a task waiting with a reason; the scheduler will wake it when resumeAt passes. */
export async function waitTask(id: string, reason: WaitReason): Promise<Task | null> {
  return updateTask(id, (t) => {
    // A task that needs a human is blocked, not waiting: it must not auto-resume.
    t.status = reason.kind === "approval" || reason.kind === "input" ? "blocked" : "waiting";
    t.wait = reason;
  });
}

export async function cancelTask(id: string): Promise<Task | null> {
  return finishTask(id, {
    summary: "Cancelled by the user.",
    artifactIds: [],
    verified: false,
    outcome: "cancelled",
  });
}

/** Remove a task and (optionally) its session. Use for cleanup, not for cancelling. */
export async function deleteTask(id: string, removeSession = true): Promise<boolean> {
  let found = false;
  await withTasks((tasks) => {
    const i = tasks.findIndex((t) => t.id === id);
    if (i === -1) return;
    found = true;
    const [t] = tasks.splice(i, 1);
    if (removeSession) deleteSession(t.sessionId);
  });
  if (found) announce({ type: "removed", id }); // after commit (see createTask)
  return found;
}

/** Tasks whose wait has elapsed and can be picked up again. */
export function dueTasks(now = Date.now()): Task[] {
  return loadTasks().filter(
    (t) => t.status === "waiting" && (!t.wait?.resumeAt || t.wait.resumeAt <= now),
  );
}

/** Move a waiting task back to the queue after its wait elapses. */
export async function requeueTask(id: string): Promise<Task | null> {
  return updateTask(id, (t) => {
    if (t.status !== "waiting") return;
    t.status = "queued";
    t.wait = undefined;
  });
}

/** Running tasks, used to enforce concurrency. */
export function runningTasks(): Task[] {
  return loadTasks().filter((t) => t.status === "running");
}

/** Tasks that are eligible to start now (queued, or due waiting), highest priority first. */
export function runnableTasks(now = Date.now()): Task[] {
  return loadTasks()
    .filter((t) => t.status === "queued" || (t.status === "waiting" && (!t.wait?.resumeAt || t.wait.resumeAt <= now)))
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
}

/** Human-readable progress used by the UI and by resume summaries. */
export function progressOf(t: Task): { pct: number; label: string } {
  switch (t.status) {
    case "queued":
      return { pct: 5, label: "Queued" };
    case "running":
      return { pct: 50, label: `Working (attempt ${t.attempts})` };
    case "waiting":
      return { pct: 35, label: t.wait?.message ?? "Waiting" };
    case "blocked":
      return { pct: 35, label: t.wait?.message ?? "Needs you" };
    case "done":
      return { pct: 100, label: "Done" };
    case "failed":
      return { pct: 100, label: "Failed" };
    case "cancelled":
      return { pct: 100, label: "Cancelled" };
  }
}