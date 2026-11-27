"use client";

/**
 * useAgentSession — the workspace's one connection to the run control plane.
 *
 * It owns everything the three surfaces (chat, screen, board) need to agree
 * on: which conversation is open, its turns (one per run), the run that is
 * active right now, that run's live event stream, and the actions that start,
 * stop and resume runs. Chat, screen and board all read the same state, so a
 * run started anywhere shows up everywhere.
 *
 * Data comes only from the existing routes:
 *   GET  /api/runtime/threads          conversations (history)
 *   GET  /api/runtime/runs             the account's recent runs + one thread's runs
 *   GET  /api/runtime/stream/[runId]   live events (replayed for a finished run)
 *   GET  /api/runtime/questions|handoffs   prompts still waiting on the user
 *   POST/DELETE /api/runtime/tasks     start, queue, stop, resume, new thread
 *
 * A conversation is keyed by the harness session id. A brand-new chat has no
 * session until its first run reports one, so until then it is keyed by that
 * run's id and by the runs started from this page; the key moves to the
 * session id as soon as the server knows it.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Attachment } from "../data";
import { uid } from "../data";
import { usePersisted } from "../store";
import { formatTestsPrompt, parseSlashCommand } from "../../../lib/test-writer/slash";
import { uploadAttachments } from "../../../lib/client/upload";
import {
  EMPTY_THREAD,
  threadReducer,
  type ThreadEntry,
  type ThreadRunInput,
  type ThreadSummary,
} from "../../../lib/client/thread";
import { isTerminalRunEvent, useRunStream, type RunStreamItem } from "../../../lib/client/useRunStream";
import { extractApprovals, pendingApprovals, type ApprovalEntry } from "../../../lib/client/runTimeline";
import { buildConversation, splitUploadedFiles, type ConversationEntry } from "../../../lib/client/conversation";
import { deriveRunPhase, isRunActive, type RunPhase } from "../../../lib/client/runPhase";
import {
  fetchRuns,
  resumeRun,
  startNewThread,
  startRun,
  steerRun,
  stopRun,
  withUploadManifest,
  type RunTier,
  type RunsResult,
} from "../../../lib/client/runs";
import {
  closeOpenPrompts,
  countWaitingOnUser,
  currentActivity,
  titleFromPrompt,
  withOpenPrompts,
  type OpenHandoff,
  type OpenQuestion,
} from "../../../lib/client/turns";

const THREADS_LIMIT = 30;
const ACCOUNT_RUNS_LIMIT = 20;
const THREAD_RUNS_LIMIT = 50;
/** Runs kept in memory across the conversations opened in this visit. */
const STORE_LIMIT = 300;
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 6000;
const THREADS_POLL_MS = 10_000;
const PROMPTS_POLL_MS = 5000;
/** Full prompts remembered in this browser (the API stores a 300-char preview). */
const PROMPT_CACHE_MAX = 100;

const NO_ITEMS: RunStreamItem[] = [];

export interface AgentSessionOptions {
  /** The agent's standing instructions, sent with every run. */
  agentCard: string;
  /** True: tool calls run without asking. False: risky calls wait for approval. */
  fullAuto: boolean;
  /** "cloud" or "computer:<id>"; undefined uses the account default. */
  computeTarget?: string;
  /** Model routing tier intent ("fast" | "balanced" | "deep"). */
  tier?: RunTier;
}

/** A message the user sent that the server has not accepted as a run yet. */
export interface PendingTurn {
  id: string;
  text: string;
  attachments: string[];
  ts: number;
}

export interface PromptDisplay {
  text: string;
  attachments: string[];
}

export type SendResult = { ok: true; runId: string; queued: boolean } | { ok: false; error: string };

export interface SendOptions {
  /** Shown in the conversation instead of the full prompt (e.g. a board task title). */
  displayText?: string;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export interface AgentSession {
  /** True once the first poll has answered (the page knows what exists). */
  ready: boolean;
  /** The API answered 401: the visitor has to sign in. */
  signedOut: boolean;
  /** The last poll could not reach the server. */
  offline: boolean;

  threads: ThreadSummary[];
  threadsState: "loading" | "ready" | "error";
  /** The open conversation; "" is a new chat with nothing sent yet. */
  threadKey: string;
  title: string;
  selectThread: (id: string) => void;
  newChat: () => void;

  /** The open conversation's runs, oldest first. */
  turns: ThreadEntry[];
  turnsLoading: boolean;
  /** The message being sent right now (uploading, then starting the run). */
  pending?: PendingTurn;
  promptFor: (entry: ThreadEntry) => PromptDisplay;
  /** Any run this page has seen, in any conversation. */
  runById: (runId: string) => ThreadEntry | undefined;

  /** The account's running (else next queued) run, in whichever conversation. */
  activeRun?: ThreadEntry;
  /** True when the active run belongs to the open conversation. */
  activeInView: boolean;
  /** The run the header describes: the active one, else the latest in view. */
  headRun?: ThreadEntry;
  phase: RunPhase | null;
  /** A run is starting, queued, running or waiting on the user. */
  busy: boolean;
  /** What the agent is doing right now, in a few words. */
  activity?: string;

  /** The run whose event stream is attached. */
  liveRunId?: string;
  liveItems: RunStreamItem[];
  liveEntries: ConversationEntry[];
  /** True while the live stream is reconnecting after a drop. */
  reconnecting: boolean;
  /** Approvals waiting on the user for the active run. */
  approvals: ApprovalEntry[];
  /** Desktop handoffs (ask_human_desktop) still waiting on the user. */
  handoffs: OpenHandoff[];

  send: (text: string, attachments?: Attachment[], options?: SendOptions) => Promise<SendResult>;
  /** l9: interrupt the active run and continue its session with new instructions. */
  steer: (text: string, attachments?: Attachment[]) => Promise<SendResult>;
  stop: (runId?: string) => Promise<ActionResult>;
  resume: (runId: string) => Promise<ActionResult>;
  answerQuestion: (id: string, answer: string) => Promise<boolean>;
  /** Resolve a pending desktop handoff (the user handed the desktop back). */
  handBack: (id: string) => Promise<boolean>;
  markHandedBack: (id: string) => void;
  showActiveRun: () => void;
  refresh: () => void;
}

function isLive(status: string | undefined): boolean {
  return status === "running" || status === "queued";
}

/** The account's running run, else the queued run that will start next. */
/**
 * Which run Stop acts on: the one named, else the account's active run, else
 * the run a send still in flight is about to create. A send that fails starts
 * nothing, so there is nothing to stop and nothing to report.
 */
export async function resolveStopTarget(
  runId: string | undefined,
  activeRunId: string | undefined,
  sending: Promise<{ ok: true; runId: string } | { ok: false }> | null,
): Promise<{ kind: "run"; runId: string } | { kind: "nothing-started" } | { kind: "none" }> {
  const known = runId ?? activeRunId;
  if (known) return { kind: "run", runId: known };
  if (!sending) return { kind: "none" };
  const sent = await sending.catch(() => ({ ok: false as const }));
  return sent.ok ? { kind: "run", runId: sent.runId } : { kind: "nothing-started" };
}

export function pickActiveRunId(runsNewestFirst: readonly ThreadRunInput[]): string | undefined {
  const agentRuns = runsNewestFirst.filter((run) => run.kind !== "shell");
  const running = agentRuns.find((run) => run.status === "running");
  if (running) return running.runId;
  const queued = agentRuns.filter((run) => run.status === "queued");
  return queued[queued.length - 1]?.runId;
}

/** Which stored runs belong to the open conversation. */
export function runsInThread(
  entries: readonly ThreadEntry[],
  threadKey: string,
  localRunIds: readonly string[],
): ThreadEntry[] {
  const local = new Set(localRunIds);
  return entries.filter(
    (entry) =>
      local.has(entry.runId) || (threadKey !== "" && (entry.sessionId === threadKey || entry.runId === threadKey)),
  );
}

/** The session a follow-up should continue: the newest one this conversation knows. */
export function sessionToContinue(turns: readonly ThreadEntry[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const sessionId = turns[i].sessionId;
    if (sessionId) return sessionId;
  }
  return undefined;
}

function sameEntry(a: ThreadEntry, b: ThreadEntry): boolean {
  const keys = Object.keys(b) as Array<keyof ThreadEntry>;
  if (Object.keys(a).length !== keys.length) return false;
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (x === y) continue;
    if (x && y && typeof x === "object" && typeof y === "object" && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return true;
}

/**
 * Keep the previous object for a run that did not change. Every poll rebuilds
 * the list; without this, every turn would re-render every two seconds.
 */
export function stabilizeEntries(prev: readonly ThreadEntry[], next: readonly ThreadEntry[]): ThreadEntry[] {
  const byId = new Map(prev.map((entry) => [entry.runId, entry]));
  let changed = prev.length !== next.length;
  const out = next.map((entry, index) => {
    const old = byId.get(entry.runId);
    if (old && sameEntry(old, entry)) {
      if (prev[index] !== old) changed = true;
      return old;
    }
    changed = true;
    return entry;
  });
  return changed ? out : (prev as ThreadEntry[]);
}

function rememberPrompt(
  cache: Record<string, PromptDisplay>,
  runId: string,
  prompt: PromptDisplay,
): Record<string, PromptDisplay> {
  const next = { ...cache, [runId]: prompt };
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - PROMPT_CACHE_MAX))) delete next[id];
  return next;
}

export function useAgentSession(options: AgentSessionOptions): AgentSession {
  const [store, dispatch] = useReducer(threadReducer, EMPTY_THREAD);
  const [accountRuns, setAccountRuns] = useState<ThreadRunInput[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsState, setThreadsState] = useState<"loading" | "ready" | "error">("loading");
  // null: nothing chosen yet (restore the latest conversation). "": new chat.
  const [storedKey, setStoredKey] = usePersisted<string | null>("sa.thread", null);
  const [localRunIds, setLocalRunIds] = useState<string[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState<PendingTurn>();
  const [dispatching, setDispatching] = useState(false);
  const [promptCache, setPromptCache] = usePersisted<Record<string, PromptDisplay>>("sa.prompts", {});
  const [questions, setQuestions] = useState<OpenQuestion[]>([]);
  const [handoffs, setHandoffs] = useState<OpenHandoff[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [handedBack, setHandedBack] = useState<Record<string, boolean>>({});

  const threadKey = storedKey ?? "";
  const restoring = storedKey === null;

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const threadKeyRef = useRef(threadKey);
  threadKeyRef.current = threadKey;

  // ---- Derived view ----

  const stableRef = useRef<ThreadEntry[]>([]);
  const entries = useMemo(() => {
    stableRef.current = stabilizeEntries(stableRef.current, store.entries);
    return stableRef.current;
  }, [store.entries]);

  const turns = useMemo(() => runsInThread(entries, threadKey, localRunIds), [entries, threadKey, localRunIds]);

  const activeRunId = useMemo(() => pickActiveRunId(accountRuns), [accountRuns]);
  const activeRun = useMemo(
    () => (activeRunId ? entries.find((entry) => entry.runId === activeRunId) : undefined),
    [entries, activeRunId],
  );
  const activeInView = Boolean(activeRun && turns.some((turn) => turn.runId === activeRun.runId));
  const latestTurn = turns[turns.length - 1];
  const headRun = activeRun ?? latestTurn;
  const liveRunId = headRun?.runId;

  // ---- Live stream ----

  const stream = useRunStream(liveRunId);
  // The stream hook clears its buffer in an effect, so for one render after
  // the run changes it still holds the previous run's events. Never show them.
  const [streamRunId, setStreamRunId] = useState(liveRunId);
  useEffect(() => setStreamRunId(liveRunId), [liveRunId]);
  const liveItems = streamRunId === liveRunId ? stream.items : NO_ITEMS;

  const liveIsActive = Boolean(activeRunId && liveRunId === activeRunId);
  const liveEntries = useMemo(() => {
    const built = withOpenPrompts(buildConversation(liveItems), { questions, handoffs, answers, handedBack });
    return liveIsActive ? built : closeOpenPrompts(built);
  }, [liveItems, questions, handoffs, answers, handedBack, liveIsActive]);

  const approvals = useMemo(
    () => (liveIsActive ? pendingApprovals(extractApprovals(liveItems)) : []),
    [liveIsActive, liveItems],
  );

  const terminalEvent = useMemo(() => {
    for (let i = liveItems.length - 1; i >= 0; i -= 1) {
      if (isTerminalRunEvent(liveItems[i].kind)) return liveItems[i].kind;
    }
    return undefined;
  }, [liveItems]);

  const phase = deriveRunPhase({
    status: headRun?.status,
    terminalEvent,
    pendingApprovals: approvals.length,
    pendingQuestions: liveIsActive ? countWaitingOnUser(liveEntries) : 0,
    dispatching,
  });
  const busy = isRunActive(phase);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const activity = useMemo(
    () => (liveIsActive ? currentActivity(liveEntries) : undefined),
    [liveIsActive, liveEntries],
  );

  // ---- Polling ----

  const refreshRuns = useCallback(async (signal?: AbortSignal) => {
    const key = threadKeyRef.current;
    const [account, keyed] = await Promise.all([
      fetchRuns(`limit=${ACCOUNT_RUNS_LIMIT}`, { signal }),
      key
        ? fetchRuns(`limit=${THREAD_RUNS_LIMIT}&sessionId=${encodeURIComponent(key)}`, { signal })
        : Promise.resolve<RunsResult>({ ok: true, runs: [] }),
    ]);
    if (signal?.aborted) return;
    if ((!account.ok && account.status === 401) || (!keyed.ok && keyed.status === 401)) {
      setSignedOut(true);
      setReady(true);
      return;
    }
    const runs = [...(account.ok ? account.runs : []), ...(keyed.ok ? keyed.runs : [])];
    if (runs.length > 0) dispatch({ type: "merge", runs, limit: STORE_LIMIT });
    if (account.ok) setAccountRuns(account.runs);
    // A 400 for the keyed query means the key is not a usable id: treat the
    // conversation as loaded (and empty) rather than loading forever.
    if (keyed.ok || keyed.status === 400) setLoadedKey(key);
    setOffline(!account.ok && account.status === undefined);
    if (account.ok) {
      setSignedOut(false);
      setReady(true);
    }
  }, []);

  const refreshThreads = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/runtime/threads?limit=${THREADS_LIMIT}`, { signal, cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401) setSignedOut(true);
        setThreadsState((prev) => (prev === "ready" ? prev : "error"));
        return;
      }
      const body = (await res.json().catch(() => null)) as { threads?: unknown } | null;
      if (signal?.aborted) return;
      setThreads(Array.isArray(body?.threads) ? (body.threads as ThreadSummary[]) : []);
      setThreadsState("ready");
    } catch {
      if (!signal?.aborted) setThreadsState((prev) => (prev === "ready" ? prev : "error"));
    }
  }, []);

  // Runs: fast while something is active, slow when idle, paused in a hidden tab.
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      if (document.visibilityState !== "hidden") await refreshRuns(ctrl.signal);
      inFlight = false;
      if (stopped) return;
      timer = setTimeout(() => void tick(), busyRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshRuns]);

  useEffect(() => {
    const ctrl = new AbortController();
    void refreshThreads(ctrl.signal);
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void refreshThreads();
    }, THREADS_POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [refreshThreads]);

  const refresh = useCallback(() => {
    void refreshRuns();
    void refreshThreads();
  }, [refreshRuns, refreshThreads]);

  // Opening another conversation loads it right away.
  useEffect(() => {
    if (threadKey) void refreshRuns();
  }, [threadKey, refreshRuns]);

  // The stream reports the outcome before the next poll does: fetch the
  // final summary (reply text, report) as soon as it lands.
  useEffect(() => {
    if (terminalEvent) refresh();
  }, [terminalEvent, refresh]);

  // ---- Conversation key housekeeping ----

  // First visit (nothing chosen): open the most recent conversation, or a
  // new chat when there is none (or history could not be read).
  useEffect(() => {
    if (!restoring || threadsState === "loading") return;
    setStoredKey(threadsState === "ready" ? (threads[0]?.id ?? "") : "");
  }, [restoring, threadsState, threads, setStoredKey]);

  // A provisional key (a run id) moves to the session id once it is known.
  useEffect(() => {
    const sessionId = sessionToContinue(turns);
    if (!sessionId || sessionId === threadKey) return;
    const provisional = threadKey === "" || turns.some((turn) => turn.runId === threadKey);
    if (provisional) setStoredKey(sessionId);
  }, [turns, threadKey, setStoredKey]);

  // A remembered conversation that no longer exists becomes a new chat.
  useEffect(() => {
    if (threadKey && loadedKey === threadKey && turns.length === 0) setStoredKey("");
  }, [threadKey, loadedKey, turns.length, setStoredKey]);

  // ---- Prompts waiting on the user (questions, desktop handoffs) ----

  useEffect(() => {
    if (!activeRunId) {
      setQuestions([]);
      setHandoffs([]);
      return;
    }
    const ctrl = new AbortController();
    const query = `?runId=${encodeURIComponent(activeRunId)}`;
    const load = async () => {
      try {
        const [questionsRes, handoffsRes] = await Promise.all([
          fetch(`/api/runtime/questions${query}`, { signal: ctrl.signal, cache: "no-store" }),
          fetch(`/api/runtime/handoffs${query}`, { signal: ctrl.signal, cache: "no-store" }),
        ]);
        if (questionsRes.ok) {
          const body = (await questionsRes.json().catch(() => null)) as { questions?: OpenQuestion[] } | null;
          if (Array.isArray(body?.questions)) setQuestions(body.questions);
        }
        if (handoffsRes.ok) {
          const body = (await handoffsRes.json().catch(() => null)) as { handoffs?: OpenHandoff[] } | null;
          if (Array.isArray(body?.handoffs)) setHandoffs(body.handoffs);
        }
      } catch {
        // The stream also carries these events; this fetch only covers a reload.
      }
    };
    void load();
    const timer = setInterval(() => void load(), PROMPTS_POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [activeRunId]);

  // ---- Actions ----

  const viewRef = useRef({ turns, localRunIds, activeRunId });
  viewRef.current = { turns, localRunIds, activeRunId };

  // Shared send preamble: trim, filter file attachments, show the optimistic
  // pending turn, upload attachments. Used by both dispatchRun (send) and
  // steer, which previously duplicated this block verbatim (Sonar S4144).
  // The empty check runs on the raw text: a /tests rewrite only ever adds
  // content, so it cannot turn an empty message into a non-empty one.
  const prepareDispatch = useCallback(
    async (
      rawText: string,
      attachments: Attachment[],
      displayText?: string,
    ): Promise<
      | { ok: false; error: string }
      | {
          ok: true;
          typed: string;
          display: PromptDisplay;
          pendingId: string;
          fail: (error: string) => { ok: false; error: string };
          uploadedFiles: Array<{ path: string; size: number }>;
        }
    > => {
      const typed = rawText.trim();
      const files = attachments.filter((attachment) => attachment.file);
      if (!typed && files.length === 0) return { ok: false, error: "Type a message first." };
      const display: PromptDisplay = {
        text: displayText ?? typed,
        attachments: files.map((file) => file.name),
      };
      const pendingId = uid();
      setPending({ id: pendingId, ...display, ts: Date.now() });
      setDispatching(true);
      // A failed send never becomes a turn: the caller keeps the draft and
      // shows the error where the user typed it.
      const fail = (error: string): { ok: false; error: string } => {
        setPending((prev) => (prev?.id === pendingId ? undefined : prev));
        setDispatching(false);
        return { ok: false, error };
      };

      let uploadedFiles: Array<{ path: string; size: number }> = [];
      if (files.length > 0) {
        try {
          const upload = await uploadAttachments(
            files.map((file) => ({ name: file.name, size: file.size, type: file.type, file: file.file as File })),
          );
          // The manifest names each stored path with its exact byte size so the
          // agent can find the files and verify they arrived intact.
          uploadedFiles = upload.uploaded.map((uploaded) => ({ path: uploaded.path, size: uploaded.size }));
        } catch (err) {
          return fail(`Could not upload the attachments. ${err instanceof Error ? err.message : ""}`.trim());
        }
      }
      return { ok: true, typed, display, pendingId, fail, uploadedFiles };
    },
    [],
  );

  const dispatchRun = useCallback(
    async (rawText: string, attachments: Attachment[] = [], sendOptions: SendOptions = {}): Promise<SendResult> => {
      const typed = rawText.trim();
      let prompt = typed;
      const slash = parseSlashCommand(typed);
      if (slash?.kind === "tests") {
        if (!slash.target) return { ok: false, error: "Usage: /tests <path> [--max=N]" };
        prompt = formatTestsPrompt(slash.target, slash.maxIterations ?? 3);
      }
      const prep = await prepareDispatch(rawText, attachments, sendOptions.displayText);
      if (!prep.ok) return prep;
      const { display, pendingId, fail, uploadedFiles } = prep;

      const view = viewRef.current;
      const key = threadKeyRef.current;
      // The first message of a new chat opens a new session. The server call
      // that does this also cancels the account's active run, so it is skipped
      // while one is going (the message then queues behind it instead).
      const freshChat = key === "" && view.localRunIds.length === 0;
      if (freshChat && !view.activeRunId) {
        const cleared = await startNewThread();
        if (!cleared.ok) return fail(`Could not start a new chat. ${cleared.error ?? ""}`.trim());
      }
      const sessionId = freshChat ? undefined : sessionToContinue(view.turns);
      const fullPrompt = withUploadManifest(prompt, uploadedFiles);
      const { agentCard, fullAuto, computeTarget, tier } = optionsRef.current;
      const result = await startRun({ prompt: fullPrompt, sessionId, agentCard, fullAuto, computeTarget, tier });
      if (!result.ok) return fail(result.error);

      // Show the run at once; the next poll replaces this with the server's row.
      const started: ThreadRunInput = {
        runId: result.runId,
        prompt: fullPrompt,
        status: result.queued ? "queued" : "running",
        createdAt: Date.now(),
        ...(sessionId ? { sessionId } : {}),
      };
      dispatch({ type: "merge", runs: [started], limit: STORE_LIMIT });
      setAccountRuns((prev) => [started, ...prev.filter((run) => run.runId !== result.runId)]);
      setLocalRunIds((prev) => [...prev, result.runId]);
      if (key === "") setStoredKey(sessionId ?? result.runId);
      setPromptCache((prev) => rememberPrompt(prev, result.runId, display));
      setPending((prev) => (prev?.id === pendingId ? undefined : prev));
      setDispatching(false);
      refresh();
      return { ok: true, runId: result.runId, queued: result.queued };
    },
    [prepareDispatch, refresh, setPromptCache, setStoredKey],
  );

  // The send in flight, if any. Stop is on screen from the moment a message
  // is sent, before the server has created the run; pressed in that window it
  // waits for this and stops the run it creates.
  const sendingRef = useRef<Promise<SendResult> | null>(null);
  const send = useCallback(
    (rawText: string, attachments: Attachment[] = [], sendOptions: SendOptions = {}): Promise<SendResult> => {
      const sending = dispatchRun(rawText, attachments, sendOptions);
      sendingRef.current = sending;
      void sending.finally(() => {
        if (sendingRef.current === sending) sendingRef.current = null;
      });
      return sending;
    },
    [dispatchRun],
  );

  const stop = useCallback(
    async (runId?: string): Promise<ActionResult> => {
      const found = await resolveStopTarget(runId, viewRef.current.activeRunId, sendingRef.current);
      if (found.kind === "nothing-started") return { ok: true };
      if (found.kind === "none") return { ok: false, error: "No run is active." };
      const target = found.runId;
      const result = await stopRun(target);
      if (!result.ok) {
        refresh();
        return { ok: false, error: result.error ?? "The run could not be stopped." };
      }
      const stopped: ThreadRunInput = { runId: target, status: "cancelled", finishedAt: Date.now() };
      dispatch({ type: "merge", runs: [stopped], limit: STORE_LIMIT });
      setAccountRuns((prev) => prev.map((run) => (run.runId === target ? { ...run, ...stopped } : run)));
      refresh();
      return { ok: true };
    },
    [refresh],
  );

  const resume = useCallback(
    async (runId: string): Promise<ActionResult> => {
      const result = await resumeRun(runId);
      if (!result.ok) return { ok: false, error: result.error };
      setLocalRunIds((prev) => (prev.includes(result.runId) ? prev : [...prev, result.runId]));
      refresh();
      return { ok: true };
    },
    [refresh],
  );

  // l9 — steer: same upload + optimistic-turn flow as a send, but the server
  // interrupts the active run and continues its session instead of queueing
  // behind it. The superseded run is marked cancelled locally at once; the
  // new run continues the same session, so the thread key does not change.
  const steer = useCallback(
    async (rawText: string, attachments: Attachment[] = []): Promise<SendResult> => {
      const prep = await prepareDispatch(rawText, attachments);
      if (!prep.ok) return prep;
      const { typed, display, pendingId, fail, uploadedFiles } = prep;
      const fullPrompt = withUploadManifest(typed, uploadedFiles);
      const result = await steerRun(fullPrompt);
      if (!result.ok) return fail(result.error);
      const stopped: ThreadRunInput = {
        runId: result.steeredFrom,
        status: "cancelled",
        finishedAt: Date.now(),
      };
      const started: ThreadRunInput = {
        runId: result.runId,
        prompt: fullPrompt,
        status: result.queued ? "queued" : "running",
        createdAt: Date.now(),
        steeredFrom: result.steeredFrom,
      };
      dispatch({ type: "merge", runs: [stopped, started], limit: STORE_LIMIT });
      setAccountRuns((prev) => [
        started,
        ...prev.map((run) => (run.runId === result.steeredFrom ? { ...run, ...stopped } : run)),
      ]);
      setLocalRunIds((prev) => [...prev, result.runId]);
      setPromptCache((prev) => rememberPrompt(prev, result.runId, display));
      setPending((prev) => (prev?.id === pendingId ? undefined : prev));
      setDispatching(false);
      refresh();
      return { ok: true, runId: result.runId, queued: result.queued };
    },
    [prepareDispatch, refresh, setPromptCache],
  );

  const answerQuestion = useCallback(async (id: string, answer: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/runtime/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, answer }),
      });
      if (!res.ok) return false;
      setAnswers((prev) => ({ ...prev, [id]: answer }));
      setQuestions((prev) => prev.filter((question) => question.id !== id));
      return true;
    } catch {
      return false;
    }
  }, []);

  const markHandedBack = useCallback((id: string) => {
    setHandedBack((prev) => ({ ...prev, [id]: true }));
    setHandoffs((prev) => prev.filter((handoff) => handoff.id !== id));
  }, []);

  const handBack = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/runtime/handoffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) return false;
    } catch {
      return false;
    }
    markHandedBack(id);
    return true;
  }, [markHandedBack]);

  const openThread = useCallback(
    (id: string) => {
      setLocalRunIds([]);
      setPending(undefined);
      setLoadedKey(null);
      setStoredKey(id);
    },
    [setStoredKey],
  );

  const selectThread = useCallback(
    (id: string) => {
      if (id !== threadKeyRef.current) openThread(id);
    },
    [openThread],
  );

  const newChat = useCallback(() => openThread(""), [openThread]);

  const showActiveRun = useCallback(() => {
    const run = activeRun;
    if (!run || activeInView) return;
    openThread(run.sessionId ?? run.runId);
  }, [activeRun, activeInView, openThread]);

  const promptFor = useCallback(
    (entry: ThreadEntry): PromptDisplay => promptCache[entry.runId] ?? splitUploadedFiles(entry.prompt),
    [promptCache],
  );

  const runById = useCallback((runId: string) => entries.find((entry) => entry.runId === runId), [entries]);

  const title =
    threads.find((thread) => thread.id === threadKey)?.title ||
    titleFromPrompt(turns[0] ? promptFor(turns[0]).text : pending?.text) ||
    "New chat";

  return {
    ready: ready && !restoring,
    signedOut,
    offline,
    threads,
    threadsState,
    threadKey,
    title,
    selectThread,
    newChat,
    turns,
    turnsLoading: threadKey !== "" && turns.length === 0 && loadedKey !== threadKey,
    pending,
    promptFor,
    runById,
    activeRun,
    activeInView,
    headRun,
    phase,
    busy,
    activity,
    liveRunId,
    liveItems,
    liveEntries,
    reconnecting: stream.status === "reconnecting",
    approvals,
    handoffs,
    send,
    steer,
    stop,
    resume,
    answerQuestion,
    handBack,
    markHandedBack,
    showActiveRun,
    refresh,
  };
}
