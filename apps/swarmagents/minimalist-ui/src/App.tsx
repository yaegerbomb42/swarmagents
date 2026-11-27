"use client";

/**
 * App — SwarmAgents Unified Workspace
 *
 * Three components, nothing else in the main view:
 *   1. The main area: the user's VM screen (noVNC viewer, takeover,
 *      terminal view, reset) with a one-line activity summary. Before the
 *      first run it shows the brand hero instead.
 *   2. The bottom input bar: one composer, any attachment (paperclip,
 *      paste, drop).
 *   3. Settings: the top-right header icon opening the settings sheet
 *      (providers, agent, compute).
 * Chat and board stay one tap away in the header view switcher.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, MessageSquare, MonitorPlay } from "lucide-react";
import type { ProviderConfig } from "./data";
import { DEFAULT_AGENT_CARD } from "./data";
import type { LogEvent } from "./engine";
import { usePersisted, useSessionPersisted } from "./store";
import type { SwarmTask } from "../../lib/mcp-types";
import { latestVmLifecycleEvent, resolveVmDisplayStatus, usePolledVmStatus, wakeVmStatus } from "../../lib/client/vmStatus";
import { deriveComputerAction, derivePresence, lastLoopNudgeAt } from "../../lib/client/presence";
import { reduceServingModel, formatServingModel } from "../../lib/client/servingModel";
import { formatDuration, RUN_PHASE_META, type RunPhase } from "../../lib/client/runPhase";
import { resetVm, type RunTier } from "../../lib/client/runs";
import { fetchSchedules, unreadScheduledRuns, type ScheduleSummary } from "../../lib/client/schedules";
import { agentNameForUser, buildTaskPrompt, type TaskRunLink } from "../../lib/client/board";
import { useAgentSession } from "./hooks/useAgentSession";
import { useBoard } from "./hooks/useBoard";
import { devModeFromSearch, resolveView } from "./devMode";
import { forkPromptFromSearch } from "./fork-prompt";
import { firstRunSetup, useIsWide, useMe, useProviderStatus } from "./hooks/useEnvironment";
import { cn } from "./utils/cn";
import { ApprovalGate } from "./components/ApprovalGate";
import { BoardPanel } from "./components/BoardPanel";
import { FirstRunSetup } from "./components/FirstRunSetup";
import type { SampleTask } from "./lib/sampleTasks";
import { Composer, type ComposerSendResult } from "./components/Composer";
import { useComputeOptions } from "./components/ComputePicker";
import type { ComputerView } from "./components/ComputerScreen";
import { Conversation } from "./components/Conversation";
import { Header, type WorkspaceView } from "./components/Header";
import { HistoryPanel } from "./components/HistoryPanel";
import type { SettingsTab } from "./components/Settings";
import { SettingsSheet } from "./components/SettingsSheet";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { useToasts } from "./components/Toasts";
import { HandoffBanner } from "./components/dashboard/HandoffBanner";
import { ScreenFrame } from "./components/dashboard/ScreenFrame";
import { Button, Loading, Notice, type SegmentOption } from "./components/ui";
import type { Attachment } from "./data";

const NO_LOGS: LogEvent[] = [];

const STARTERS = [
  "Create a file and run a script",
  "Organize a messy folder",
  "Fetch a web page and summarize it",
];

const APP_TITLE = "SwarmAgents";

export function runCompletionToast(
  phase: RunPhase | null,
  run: { createdAt: number; finishedAt?: number },
  now = Date.now(),
): { tone: "success" | "error"; message: string } | null {
  if (phase === "finished") {
    const durationMs = Math.max(0, (run.finishedAt ?? now) - run.createdAt);
    return { tone: "success", message: `Run finished in ${formatDuration(durationMs)}.` };
  }
  if (phase === "error") return { tone: "error", message: "Run failed — see the report." };
  return null;
}

export function shouldToastRunCompletion(input: {
  phase: RunPhase | null;
  wasActive: boolean;
  view: WorkspaceView;
  alreadyNotified: boolean;
}): boolean {
  return (
    input.wasActive &&
    !input.alreadyNotified &&
    input.view !== "chat" &&
    (input.phase === "finished" || input.phase === "error")
  );
}

export type WorkspaceChord = "focusComposer" | "newChat";

/**
 * The workspace's modifier-chord shortcuts, kept pure so tests can pin the
 * mapping without a DOM. Cmd/Ctrl+K focuses the composer; Cmd/Ctrl+Shift+O
 * starts a new chat. Plain Cmd/Ctrl+O is left alone (it is the browser's
 * "open file"). Bare keys never map here — typing must be unaffected.
 */
export function workspaceChordAction(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}): WorkspaceChord | null {
  if (!(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (key === "k") return "focusComposer";
  if (key === "o" && event.shiftKey) return "newChat";
  return null;
}
/** The activity suffix under the workspace label: what the agent is doing, or the computer's state. */
function workspaceActivitySuffix(
  activity: string | undefined,
  phaseActive: boolean | undefined,
  vmLabel: string,
): string {
  if (activity) return ` · ${activity}`;
  if (phaseActive) return " · Agent is working";
  return ` · Computer ${vmLabel.toLowerCase()}`;
}

export default function App() {
  const { push: pushToast } = useToasts();
  const wide = useIsWide();
  const me = useMe();
  const providerStatus = useProviderStatus();
  const compute = useComputeOptions(undefined);
  // 24/7 badge in the header + the first-run completion flag: read the
  // account settings once on mount; the Settings toggle notifies us
  // immediately when the user flips always-on.
  const [alwaysOn247, setAlwaysOn247] = useState(false);
  const [firstRunCompleted, setFirstRunCompleted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/providers/settings', { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const body = (await res.json()) as { alwaysOn247?: unknown; firstRunCompleted?: unknown };
        if (!cancelled) {
          if (typeof body.alwaysOn247 === 'boolean') setAlwaysOn247(body.alwaysOn247);
          if (typeof body.firstRunCompleted === 'boolean') setFirstRunCompleted(body.firstRunCompleted);
        }
      } catch {
        // offline / unsigned — badges stay hidden, first-run stays unknown
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [providers, setProviders] = usePersisted<ProviderConfig[]>("ac.providers", []);
  const [agentCard, setAgentCard] = usePersisted<string>("ac.agentCard", DEFAULT_AGENT_CARD);
  const [fullAuto, setFullAuto] = usePersisted<boolean>("ac.fullAuto", true);
  const [view, setView] = usePersisted<WorkspaceView>("sa.view", "screen");
  // Dev mode gates the Board view: the board is internal build tooling, not a
  // product feature. Off by default; ?dev=1 turns it on (persisted per
  // browser), ?dev=0 turns it back off.
  const [devMode, setDevMode] = usePersisted<boolean>("sa.devMode", false);
  useEffect(() => {
    const next = devModeFromSearch(window.location.search, devMode);
    if (next !== devMode) setDevMode(next);
  }, [devMode, setDevMode]);
  // With dev mode off, a persisted "board" view (or any switch to it) falls
  // back to chat. Board data keeps polling in the background: run-task
  // linking reads it even while the view is hidden.
  const effectiveView = resolveView(view, devMode);
  const [draft, setDraft] = useSessionPersisted<string>("sa.draft", "");
  // A share link's "Try this prompt" lands here with ?prompt=<text>: fill
  // the composer once, then strip the parameter so a refresh keeps the
  // visitor's own edits instead of re-injecting the forked prompt.
  useEffect(() => {
    const forked = forkPromptFromSearch(window.location.search);
    if (forked === null) return;
    setDraft(forked);
    const url = new URL(window.location.href);
    url.searchParams.delete("prompt");
    window.history.replaceState(null, "", url);
  }, [setDraft]);
  const observedActiveRuns = useRef(new Set<string>());
  const notifiedRuns = useRef(new Set<string>());

  const [tier, setTier] = usePersisted<RunTier>("sa.tier", "balanced");
  const session = useAgentSession({ agentCard, fullAuto, computeTarget: compute.target || undefined, tier });
  const { selectThread } = session;
  const board = useBoard(view === "board");

  const [historyOpen, setHistoryOpen] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [seenScheduleRunIds, setSeenScheduleRunIds] = usePersisted<string[]>("sa.seenScheduleRunIds", []);
  // First time this browser tracks cron runs, start the unread clock now so
  // existing schedules' past runs are not all flagged unread.
  const [cronRunsSince, setCronRunsSince] = usePersisted<number>("sa.cronRunsSince", 0);
  useEffect(() => {
    if (!cronRunsSince) setCronRunsSince(Date.now());
  }, [cronRunsSince, setCronRunsSince]);
  const unreadCronRuns = useMemo(
    () => unreadScheduledRuns(schedules, seenScheduleRunIds, cronRunsSince || Number.POSITIVE_INFINITY),
    [schedules, seenScheduleRunIds, cronRunsSince],
  );
  useEffect(() => {
    if (session.signedOut) {
      setSchedules([]);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      const res = await fetchSchedules(fetch, controller.signal);
      if (!cancelled && res.ok) setSchedules(res.schedules);
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [session.signedOut]);
  const markAllCronRunsRead = useCallback(() => {
    const ids = unreadCronRuns.map((u) => u.runId);
    if (ids.length === 0) return;
    setSeenScheduleRunIds((prev) => Array.from(new Set([...prev, ...ids])).slice(-200));
  }, [unreadCronRuns, setSeenScheduleRunIds]);
  const jumpToCronRun = useCallback(
    (runId: string) => {
      setSeenScheduleRunIds((prev) => (prev.includes(runId) ? prev : [...prev, runId].slice(-200)));
      session.selectThread(runId);
      setView("chat");
    },
    [session, setSeenScheduleRunIds, setView],
  );
  const [settings, setSettings] = useState<{ open: boolean; tab: SettingsTab }>({ open: false, tab: "providers" });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [focusTaskId, setFocusTaskId] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // ---- VM screen ----

  const lifecycleEvent = latestVmLifecycleEvent(session.liveItems);
  const [vmWakeTick, setVmWakeTick] = useState(0);
  const [vmWaking, setVmWaking] = useState(false);
  const [showDesktopBeforeRun, setShowDesktopBeforeRun] = useState(false);
  const polledVm = usePolledVmStatus(undefined, `${session.busy}:${lifecycleEvent ?? ""}:${vmWakeTick}`);
  const [vmResetting, setVmResetting] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [screenView, setScreenView] = useState<ComputerView>("desktop");
  const vmDisplay = resolveVmDisplayStatus({
    latestVmEvent: session.busy ? lifecycleEvent : undefined,
    polledStatus: polledVm.status,
    // Do not dial (and therefore wake) a VM before its first status arrives.
    resetting: vmResetting || (!polledVm.status && !lifecycleEvent),
  });
  const canControl = polledVm.desktop !== false && vmDisplay.state === "ready";

  useEffect(() => {
    if (polledVm.desktop === false && screenView === "desktop") setScreenView("terminal");
  }, [polledVm.desktop, screenView]);

  useEffect(() => {
    if (takingOver && (view !== "screen" || screenView !== "desktop" || polledVm.desktop === false)) {
      setTakingOver(false);
    }
  }, [takingOver, view, screenView, polledVm.desktop]);

  // ---- Run status & Telemetry ----

  const { phase, busy, headRun, activeRun } = session;
  const phaseMeta = phase ? RUN_PHASE_META[phase] : undefined;
  const activitySuffix = workspaceActivitySuffix(session.activity, phaseMeta?.active, vmDisplay.label);
  const servingModelLabel = useMemo(() => formatServingModel(reduceServingModel(session.liveItems)), [session.liveItems]);
  const needsAttention =
    phase === "approval" || phase === "question" || phase === "paused" || phase === "error" || vmDisplay.state === "error";

  useEffect(() => {
    if (activeRun && phaseMeta?.active) observedActiveRuns.current.add(activeRun.runId);
    if (!headRun || !observedActiveRuns.current.has(headRun.runId) || notifiedRuns.current.has(headRun.runId)) return;
    const notice = runCompletionToast(phase, headRun);
    if (!notice) return;
    notifiedRuns.current.add(headRun.runId);
    if (!shouldToastRunCompletion({
      phase,
      wasActive: observedActiveRuns.current.has(headRun.runId),
      view,
      alreadyNotified: false,
    })) return;
    pushToast({
      ...notice,
      action: () => {
        selectThread(headRun.sessionId ?? headRun.runId);
        setView("chat");
      },
    });
  }, [activeRun, headRun, phase, phaseMeta?.active, pushToast, selectThread, setView, view]);

  // Presence for the computer's status bar. The page owns the run's stream
  // (the conversation consumes it), so the screen is handed the summary
  // instead of opening a second SSE connection. The screen falls back to the
  // new activity line while this run's events are still being replayed.
  const screenPresence = useMemo(() => derivePresence(session.liveItems), [session.liveItems]);

  // The latest computer-use action for the desktop overlay, from the same
  // stream (the screen falls back to its own derivation when this is absent).
  const screenComputerAction = useMemo(
    () => deriveComputerAction(session.liveItems),
    [session.liveItems],
  );

  // The newest loop nudge, for the overlay's "Loop caught" chip flash.
  const screenLoopNudgeAt = useMemo(
    () => lastLoopNudgeAt(session.liveItems),
    [session.liveItems],
  );

  // The screen opens automatically on wide screens when a run starts
  const activeRunId = activeRun?.runId;
  const lastActiveRunId = useRef(activeRunId);
  useEffect(() => {
    if (activeRunId && activeRunId !== lastActiveRunId.current && wide) {
      setView((current) => (current === "chat" ? "screen" : current));
    }
    lastActiveRunId.current = activeRunId;
  }, [activeRunId, wide, setView]);

  useEffect(() => {
    document.title = phaseMeta?.active ? `${phaseMeta.label} · ${APP_TITLE}` : APP_TITLE;
    return () => {
      document.title = APP_TITLE;
    };
  }, [phaseMeta?.active, phaseMeta?.label]);

  // ---- Actions ----

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const openSettings = useCallback((tab: SettingsTab) => setSettings({ open: true, tab }), []);
  const closeSettings = useCallback(() => {
    setSettings((current) => ({ ...current, open: false }));
    providerStatus.refresh();
  }, [providerStatus]);

  const stopDuringSendRef = useRef(false);

  const handleSend = useCallback(
    async (text: string, attachments: Attachment[]): Promise<ComposerSendResult> => {
      stopDuringSendRef.current = false;
      const result = await session.send(text, attachments);
      if (!result.ok && (result.status === 429 || result.status === 503)) {
        // The composer shows the same error inline with a Retry button; the
        // toast makes sure it is seen even when the composer is scrolled away.
        // Nothing pretends the run started: no simulated engine runs.
        pushToast({ tone: "error", message: "The server could not start the run.", detail: result.error });
      }
      // The screen opens automatically on wide screens when a run starts; on
      // a phone — or when the user already clicked Stop mid-request — stay put.
      if (result.ok && !result.queued && wide && !stopDuringSendRef.current) setView("screen");
      stopDuringSendRef.current = false;
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error, ...(result.status !== undefined ? { status: result.status } : {}) };
    },
    [session, setView, wide, pushToast],
  );

  /**
   * Dispatch a first-run sample task through the normal run path. The wizard
   * (or the Settings replay entry) closes and the workspace lands on the live
   * run; completion is persisted separately when the run finishes.
   */
  const handleSampleTask = useCallback(
    async (sample: SampleTask): Promise<{ ok: boolean; error?: string }> => {
      const result = await session.send(sample.prompt, [], { displayText: sample.title });
      if (!result.ok) return { ok: false, error: result.error };
      setSetupDismissed(true);
      setSettings((current) => ({ ...current, open: false }));
      if (wide) setView("screen");
      return { ok: true };
    },
    [session, wide, setView],
  );

  const handleStop = useCallback(async () => {
    stopDuringSendRef.current = true;
    setStopping(true);
    const result = await session.stop();
    setStopping(false);
    if (!result.ok) pushToast({ tone: "error", message: "The run was not stopped.", detail: result.error });
  }, [session, pushToast]);

  const handleNewChat = useCallback(() => {
    session.newChat();
    setShowDesktopBeforeRun(false);
    setView("chat");
    focusComposer();
  }, [session, setView, focusComposer]);

  const handleOpenLiveDesktop = useCallback(async () => {
    if (session.signedOut) {
      openSettings("account");
      return;
    }
    setShowDesktopBeforeRun(true);
    setView("screen");
    setScreenView("desktop");
    setVmWaking(true);
    try {
      await wakeVmStatus();
      setVmWakeTick((n) => n + 1);
    } finally {
      setVmWaking(false);
    }
  }, [session.signedOut, openSettings, setView]);

  // Desktop handoff (ask_human_desktop): the run is paused and the user must
  // act on the VM desktop. The banner lives above the workspace in every
  // view — the handoff card in the chat stream can scroll out of reach, and
  // the agent waiting is invisible from the board or the chat otherwise.
  const pendingHandoff = session.handoffs[0];
  const [handingBack, setHandingBack] = useState(false);

  const handleHandoffTakeControl = useCallback(() => {
    if (session.signedOut) {
      openSettings("account");
      return;
    }
    // The runtime paused the agent for the handoff, so a control-mode takeover
    // grants immediately (the takeover session treats a paused agent as a safe
    // point); if the VM is asleep the wake path runs first and the takeover
    // request is re-asserted once the screen is live.
    void handleOpenLiveDesktop().then(() => setTakingOver(true));
  }, [session.signedOut, openSettings, handleOpenLiveDesktop]);

  const handleHandoffHandBack = useCallback(async () => {
    if (!pendingHandoff || handingBack) return;
    setHandingBack(true);
    const ok = await session.handBack(pendingHandoff.id);
    setHandingBack(false);
    if (!ok) pushToast({ tone: "error", message: "Could not hand the desktop back. Try again." });
  }, [pendingHandoff, handingBack, session, pushToast]);

  const handleResetVm = useCallback(async (): Promise<string | undefined> => {
    setVmResetting(true);
    const result = await resetVm();
    setVmResetting(false);
    session.refresh();
    return result.ok ? undefined : (result.error ?? "The server refused the reset.");
  }, [session]);

  const showRun = useCallback(() => {
    session.showActiveRun();
    if (phaseMeta?.active) setView("screen");
    else if (!wide) setView("chat");
  }, [session, phaseMeta?.active, wide, setView]);

  const watchScreen = useCallback(() => setView("screen"), [setView]);

  const agentName = agentNameForUser(me);

  const runTask = useCallback(
    async (task: SwarmTask): Promise<string | undefined> => {
      const started = await session.send(buildTaskPrompt(task), [], { displayText: task.title });
      if (!started.ok) return started.error;
      const name = board.links[task.id]?.agentName ?? agentName;
      board.linkRun({ taskId: task.id, title: task.title, runId: started.runId, agentName: name, startedAt: Date.now() });
      if (task.status !== "open") return undefined;
      const claimed = await board.claim(task.id, name);
      return claimed.ok ? undefined : `The run started, but the task could not be claimed. ${claimed.error}`;
    },
    [session, board, agentName],
  );

  const viewTaskRun = useCallback(
    (link: TaskRunLink) => {
      const run = session.runById(link.runId);
      session.selectThread(run?.sessionId ?? link.runId);
      if (!wide) setView("chat");
    },
    [session, wide, setView],
  );

  const openTask = useCallback(
    (taskId: string) => {
      setFocusTaskId(taskId);
      setView("board");
    },
    [setView],
  );

  // Cmd/Ctrl+K focus (unchanged), Cmd/Ctrl+Shift+O new chat. Esc closes the
  // console's own overlays — history, settings, the shortcuts help — the way
  // every other overlay in the app closes (the Sheet component handles its own
  // Esc; this fallback covers the ones App owns). Bare keys are never handled
  // here, so typing in the composer is unaffected.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = workspaceChordAction(event);
      if (action === "focusComposer") {
        event.preventDefault();
        if (!wide) setView((current) => (current === "board" ? "chat" : current));
        focusComposer();
        return;
      }
      if (action === "newChat") {
        if (busy) return;
        event.preventDefault();
        handleNewChat();
        return;
      }
      if (event.key !== "Escape") return;
      if (shortcutsOpen) setShortcutsOpen(false);
      else if (settings.open) closeSettings();
      else if (historyOpen) setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [wide, setView, focusComposer, handleNewChat, busy, shortcutsOpen, settings.open, closeSettings, historyOpen]);

  // ---- Layout configuration ----

  const views: SegmentOption<WorkspaceView>[] = [
    { id: "chat", label: "Chat", icon: <MessageSquare className="h-3.5 w-3.5" aria-hidden /> },
    { id: "screen", label: "Computer", icon: <MonitorPlay className="h-3.5 w-3.5" aria-hidden /> },
    ...(devMode
      ? [{ id: "board" as const, label: "Board", icon: <ClipboardList className="h-3.5 w-3.5" aria-hidden />, count: board.counts.open }]
      : []),
  ];


  // A zero-provider account cannot start a run. Instead of letting the first
  // send fail, the workspace blocks the composer with the reason — and for a
  // fresh account that has not completed onboarding, the first-run wizard
  // (provider → key test → sample task) replaces the stage. "Set up later"
  // hides the wizard for the visit; the composer notice takes over.
  const setup = firstRunSetup({
    providerState: providerStatus.state,
    signedOut: session.signedOut,
    ready: session.ready,
    threadsReady: session.threadsState === "ready",
    turns: session.turns.length,
    threads: session.threads.length,
    firstRunCompleted,
  });
  const [setupDismissed, setSetupDismissed] = useState(false);
  const showFirstRun = setup.firstRun && !setupDismissed;

  // Once a run finishes, the account has seen "I watched it do something":
  // persist completion so the wizard never reappears (Settings keeps the
  // "Run a sample task" replay entry).
  useEffect(() => {
    if (firstRunCompleted || phase !== "finished") return;
    void (async () => {
      try {
        const res = await fetch("/api/providers/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstRunCompleted: true }),
        });
        if (res.ok) setFirstRunCompleted(true);
      } catch {
        // offline — next finished run tries again
      }
    })();
  }, [phase, firstRunCompleted]);

  const activeThreadId = activeRun ? (activeRun.sessionId ?? activeRun.runId) : undefined;
  const headDuration =
    headRun?.finishedAt !== undefined && headRun.finishedAt >= headRun.createdAt
      ? headRun.finishedAt - headRun.createdAt
      : undefined;

  // Before the first run there is no screen worth showing yet: the main
  // area carries the brand hero and starter chips. The screen stays
  // mounted (hidden) so its streams survive the switch.
  const showHero = effectiveView === "screen" && !headRun && session.turns.length === 0 && !showDesktopBeforeRun;

  return (
    <div
      className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-transparent text-[var(--fg)]"
      data-testid="minimal-main-page"
      data-view={effectiveView}
    >
      <div className="aura" aria-hidden="true" />
      {/* Header with brand lockup, view switcher and run indicator */}
      <Header
        title={session.title}
        onOpenHistory={() => setHistoryOpen(true)}
        onNewChat={handleNewChat}
        newChatDisabled={busy}
        views={views}
        view={effectiveView}
        onView={setView}
        wide={wide}
        run={{
          phase,
          since: headRun?.createdAt,
          durationMs: headDuration,
          activity: session.activity,
          servingModel: servingModelLabel,
          stopping,
          onStop: () => void handleStop(),
          onShow: showRun,
        }}
        onOpenSettings={() => openSettings("providers")}
        settingsNeedsAttention={providerStatus.state === "missing"}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        user={me}
        alwaysOn247={alwaysOn247}
        unreadCronCount={unreadCronRuns.length}
      />

      {session.offline && !session.signedOut && (
        <Notice tone="warn" title="Cannot reach the server" className="mx-3 mt-3 z-20" testId="offline-notice">
          Retrying. Anything already running keeps going.
        </Notice>
      )}

      {pendingHandoff && !session.signedOut && (
        <div className="mx-3 mt-3 z-20 sm:mx-4">
          <HandoffBanner
            handoff={pendingHandoff}
            total={session.handoffs.length}
            handingBack={handingBack}
            onTakeControl={handleHandoffTakeControl}
            onHandBack={() => void handleHandoffHandBack()}
          />
        </div>
      )}

      {/* The bottom padding grows below sm: the composer — and its
          bottom-left Attach button — sits flush to the viewport edge on a
          phone, where the browser chrome and any bottom-anchored badges
          would otherwise crowd it. */}
      <main className="relative z-10 flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 pb-5 sm:p-4" data-testid="workspace-main">
        {/* Component 2: the main area — the user's VM screen. */}
        <section className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-2 overflow-y-auto rounded-[28px] glass hair p-3 sm:p-5 shadow-[0_24px_80px_-28px_rgba(0,0,0,0.85)]" data-testid="stage">
          <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--mute)]" role="status" aria-live="polite" data-testid="workspace-activity">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", phaseMeta?.active ? "bg-emerald-400 animate-pulse" : "bg-white/30")} />
            <span className="truncate">{phaseMeta?.label ?? vmDisplay.label}{activitySuffix}</span>
            {effectiveView === "screen" && !headRun && session.turns.length === 0 && (
              <button
                type="button"
                data-testid="toggle-live-desktop-btn"
                onClick={() => {
                  if (showHero) {
                    void handleOpenLiveDesktop();
                  } else {
                    setShowDesktopBeforeRun(false);
                  }
                }}
                className="ml-auto shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-zinc-200 transition hover:bg-white/[0.08]"
              >
                {showHero ? (vmWaking ? "Booting VM…" : "Live Desktop") : "Overview"}
              </button>
            )}
          </div>
          {showFirstRun ? (
            <FirstRunSetup
              onRunSample={handleSampleTask}
              onLater={() => setSetupDismissed(true)}
            />
          ) : (
            <>
              {showHero && (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-10 text-center" data-testid="workspace-hero">
              <div className="neo-pill mb-5 grid h-16 w-16 place-items-center rounded-[22px] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_0_32px_-8px_rgba(0,208,240,0.4)]">
                <img src="/brand/mark-dark.svg" alt="" width={56} height={56} className="h-11 w-11" />
              </div>
              <h1 className="mb-2 bg-gradient-to-b from-white to-slate-300 bg-clip-text text-xl font-semibold tracking-tight text-transparent sm:text-3xl">Give it a task. It has its own computer.</h1>
              <p className="mb-6 max-w-md text-sm leading-relaxed text-[var(--mute)]">
                One autonomous agent in your own persistent Linux VM. Describe the work, watch every step live, take over anytime. Free — bring your own model keys.
              </p>
              {!setup.needsProvider && !session.signedOut && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {STARTERS.map((starter) => (
                    <button
                      key={starter}
                      type="button"
                      className="glass hair rounded-full px-3.5 py-1.5 text-xs text-[var(--mute)] transition-colors hover:text-[var(--fg)]"
                      onClick={() => {
                        setDraft(starter);
                        focusComposer();
                      }}
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                <button
                  type="button"
                  data-testid="launch-desktop-btn"
                  disabled={vmWaking}
                  onClick={() => void handleOpenLiveDesktop()}
                  className="inline-flex items-center gap-2 rounded-full border border-indigo-400/35 bg-indigo-500/15 px-4 py-2 text-xs font-medium text-indigo-100 shadow-sm backdrop-blur transition hover:border-indigo-300/50 hover:bg-indigo-500/25 disabled:opacity-60"
                >
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  {vmWaking ? "Booting Linux Desktop…" : "Launch live Linux desktop"}
                </button>
              </div>
            </div>
          )}
          {/* Keep the desktop and runtime streams mounted when switching workspace tabs. */}
          <div className={cn("min-h-[300px] flex-1", (effectiveView !== "screen" || showHero) && "hidden")} aria-hidden={effectiveView !== "screen" || showHero}>
            <ScreenFrame
              activeView={screenView}
              onToggleView={setScreenView}
              showDesktop={polledVm.desktop}
              logs={NO_LOGS}
              runId={session.liveRunId}
              agentId={activeRun?.agentId}
              runActive={Boolean(phaseMeta?.active && activeRun)}
              vmState={vmDisplay.state}
              vmResetting={vmResetting}
              polledVmStatus={polledVm.status}
              desktopMode={polledVm.desktop}
              activeRoleName={agentName}
              onResetVm={() => openSettings("agent")}
              onStopRun={() => void handleStop()}
              control={takingOver}
              onControlChange={setTakingOver}
              canControl={canControl}
              fitToHeight={wide}
              presence={screenPresence}
              computerAction={screenComputerAction}
              loopNudgeAt={screenLoopNudgeAt}
              activity={session.activity ? [{ text: session.activity }] : undefined}
              className={wide ? "h-full" : undefined}
            />
          </div>
          {effectiveView === "chat" && (
            !session.ready && !session.signedOut ? (
              <Loading label="Connecting to autonomous swarm..." className="min-h-0 flex-1" />
            ) : (
              <Conversation
                session={session}
                taskLinks={board.links}
                starters={setup.needsProvider ? [] : STARTERS}
                onWatchScreen={view === "screen" ? undefined : watchScreen}
                onOpenTask={openTask}
                onOpenProviders={() => openSettings("providers")}
                className="min-h-0 flex-1"
              />
            )
          )}
          {effectiveView === "board" && (
            <BoardPanel
              board={board}
              agentName={agentName}
              runFor={session.runById}
              onRunTask={runTask}
              onViewRun={viewTaskRun}
              focusTaskId={focusTaskId}
              className="flex-1"
            />
          )}
            </>
          )}
        </section>

        {/* Component 1: the bottom input bar — any attachment. Hidden while
            the first-run wizard is up: the wizard owns that space, and the
            provider notice would duplicate its "add a key" ask. */}
        {!showFirstRun && (
        <section className="mx-auto w-full max-w-3xl shrink-0 pb-3 sm:pb-0" aria-label="Ask the agent">
          {session.signedOut ? (
            <Notice
              tone="warn"
              title="Sign in to use the agent"
              className="mb-2"
              testId="signed-out-notice"
              action={
                <a
                  href="/login"
                  className="inline-flex h-8 items-center rounded-xl bg-[var(--fg)] px-3 text-[13px] font-medium text-[var(--inv)] transition-colors hover:opacity-90"
                >
                  Sign in
                </a>
              }
            >
              Your session ended or you have not signed in yet.
            </Notice>
          ) : (
            setup.needsProvider && (
              <Notice
                tone="warn"
                title="Add a model provider to start"
                className="mb-2"
                testId="provider-notice"
                action={
                  <Button size="sm" variant="primary" onClick={() => openSettings("providers")}>
                    Add provider key
                  </Button>
                }
              >
                Runs use your configured provider keys.
              </Notice>
            )
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={handleSend}
            tier={tier}
            onTierChange={setTier}
            blockedReason={
              session.signedOut ? "Sign in to send" : setup.needsProvider ? "Add a provider key to send" : undefined
            }
            inputRef={composerRef}
          />
        </section>
        )}
      </main>

      {/* Floating Approval Gate for Risky Actions */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 top-12 z-[90] flex items-start justify-center px-3 pt-2 transition-colors has-[[role=alertdialog]]:bg-black/60"
        data-testid="approval-layer"
      >
        <div className="sa-enter pointer-events-auto w-full max-w-[640px] rounded-2xl glass hair shadow-2xl empty:hidden">
          <ApprovalGate approvals={session.approvals} />
        </div>
      </div>

      {/* Slide-over Conversation History */}
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        threads={session.threads}
        state={session.threadsState}
        currentId={session.threadKey}
        activeId={activeThreadId}
        onSelect={session.selectThread}
        onNewChat={handleNewChat}
        newChatDisabled={busy}
        onRetry={session.refresh}
        unreadCronRuns={unreadCronRuns}
        onJumpToCronRun={jumpToCronRun}
        onMarkCronRunsRead={markAllCronRunsRead}
      />

      {/* Slide-over Settings & Multi-Provider Sheet */}
      <SettingsSheet
        open={settings.open}
        onClose={closeSettings}
        initialTab={settings.tab}
        providers={providers}
        setProviders={setProviders}
        serverProviderCount={providerStatus.count}
        fullAuto={fullAuto}
        onFullAutoChange={setFullAuto}
        agentCard={agentCard}
        onAgentCardChange={setAgentCard}
        compute={compute}
        busy={busy}
        onResetVm={handleResetVm}
        onAlwaysOn247Change={setAlwaysOn247}
        onRunSample={handleSampleTask}
      />

      {/* Slide-over Keyboard Shortcuts Help */}
      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
