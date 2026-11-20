"use client";

/**
 * useBoard — the SwarmBoard as the workspace sees it.
 *
 * Polls the board snapshot (GET /api/mcp/swarm-board) and exposes the three
 * writes the UI makes, each through the board's own JSON-RPC tools. A write
 * updates the list from the task the board returns, so the row changes the
 * moment the server confirms it rather than on the next poll.
 *
 * It also remembers, in this browser, which run was started for which task,
 * so a task row and the conversation can point at each other.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SwarmTask } from "../../../lib/mcp-types";
import { usePersisted } from "../store";
import {
  askBoard,
  claimBoardTask,
  createBoardTask,
  fetchBoard,
  linkTaskRun,
  submitBoardTask,
  taskFromMessage,
  type BoardAgentTurn,
  type BoardCounts,
  type BoardResult,
  type SubmitTaskInput,
  type TaskRunLink,
  type TaskRunLinks,
} from "../../../lib/client/board";

const POLL_VISIBLE_MS = 5000;
/** Off screen the board still refreshes, slowly, to keep the header's open count honest. */
const POLL_BACKGROUND_MS = 30_000;

const NO_COUNTS: BoardCounts = { tasks: 0, open: 0, claimed: 0, in_review: 0, completed: 0 };

export interface BoardError {
  message: string;
  /** True when trying again can help (storage briefly unavailable, network). */
  retryable: boolean;
}

export interface Board {
  /** "loading" until the first answer; "error" only when nothing has loaded. */
  status: "loading" | "ready" | "error";
  tasks: SwarmTask[];
  counts: BoardCounts;
  /** False when the server cannot save the board. */
  writable: boolean;
  /** The last refresh failed. Tasks, if any, are the last good snapshot. */
  error?: BoardError;
  refresh: () => Promise<void>;
  ask: (message: string) => Promise<BoardResult<BoardAgentTurn>>;
  /** Files the message as a task directly. Does not call the board-agent. */
  addTask: (message: string) => Promise<BoardResult<SwarmTask>>;
  claim: (taskId: string, agentName: string) => Promise<BoardResult<SwarmTask>>;
  submit: (input: SubmitTaskInput) => Promise<BoardResult<SwarmTask>>;
  links: TaskRunLinks;
  linkRun: (link: TaskRunLink) => void;
}

export function countTasks(tasks: readonly SwarmTask[]): BoardCounts {
  const counts: BoardCounts = { ...NO_COUNTS, tasks: tasks.length };
  for (const task of tasks) {
    if (task.status === "open") counts.open += 1;
    else if (task.status === "claimed") counts.claimed += 1;
    else if (task.status === "in_review") counts.in_review += 1;
    else if (task.status === "completed") counts.completed += 1;
  }
  return counts;
}

/** Replace a task in the list (or add it), newest first. */
export function upsertTask(tasks: readonly SwarmTask[], task: SwarmTask): SwarmTask[] {
  const index = tasks.findIndex((existing) => existing.id === task.id);
  if (index === -1) return [task, ...tasks];
  const next = [...tasks];
  next[index] = task;
  return next;
}

export function useBoard(visible: boolean): Board {
  const [status, setStatus] = useState<Board["status"]>("loading");
  const [tasks, setTasks] = useState<SwarmTask[]>([]);
  const [writable, setWritable] = useState(true);
  const [error, setError] = useState<BoardError>();
  const [links, setLinks] = usePersisted<TaskRunLinks>("sa.taskRuns", {});
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const conversationId = useRef<string | undefined>(undefined);

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchBoard({ signal });
    if (signal?.aborted) return;
    if (result.ok) {
      setTasks(result.value.tasks);
      setWritable(result.value.writable);
      setError(undefined);
      setStatus("ready");
      return;
    }
    setError({ message: result.error, retryable: result.retryable });
    setStatus((prev) => (prev === "ready" ? prev : "error"));
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "hidden") await load(ctrl.signal);
      if (stopped) return;
      timer = setTimeout(() => void tick(), visibleRef.current ? POLL_VISIBLE_MS : POLL_BACKGROUND_MS);
    };
    void tick();
    return () => {
      stopped = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  // Opening the board shows current data, not a snapshot up to 30 s old.
  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const apply = useCallback((result: BoardResult<SwarmTask>): BoardResult<SwarmTask> => {
    if (result.ok) {
      setTasks((prev) => upsertTask(prev, result.value));
      setStatus("ready");
    }
    return result;
  }, []);

  const ask = useCallback(async (message: string) => {
    const result = await askBoard(message, { conversationId: conversationId.current });
    if (result.ok) {
      if (result.value.conversationId) conversationId.current = result.value.conversationId;
      if (result.value.task) {
        setTasks((prev) => upsertTask(prev, result.value.task as SwarmTask));
        setStatus("ready");
      }
    }
    return result;
  }, []);

  const addTask = useCallback(async (message: string) => {
    const draft = taskFromMessage(message);
    if (!draft) return { ok: false as const, error: "Describe the task first.", retryable: false };
    return apply(await createBoardTask(draft));
  }, [apply]);

  const claim = useCallback(
    async (taskId: string, agentName: string) => apply(await claimBoardTask({ taskId, agentName })),
    [apply],
  );

  const submit = useCallback(async (input: SubmitTaskInput) => apply(await submitBoardTask(input)), [apply]);

  const linkRun = useCallback(
    (link: TaskRunLink) => setLinks((prev) => linkTaskRun(prev, link)),
    [setLinks],
  );

  const refresh = useCallback(() => load(), [load]);
  const counts = useMemo(() => countTasks(tasks), [tasks]);

  return { status, tasks, counts, writable, error, refresh, ask, addTask, claim, submit, links, linkRun };
}
