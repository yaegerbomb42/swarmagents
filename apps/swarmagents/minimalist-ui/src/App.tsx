"use client";

/**
 * App — SwarmAgents Unified Workspace
 *
 * Implements the mynow.online aesthetic (dark glass tokens, ambient aura,
 * luminous borders, tactile ripples, and live telemetry) seamlessly wired to:
 *   1. Live VM Screen Frame (noVNC viewer, takeover, terminal view, reset).
 *   2. Real-time Run stream telemetry, tool narration, and Conversation.
 *   3. Cute Mascot animation (MascotDock) with full state sync.
 *   4. Settings sheet with complete multi-provider catalog & keys.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardList, MessageSquare, MonitorPlay, Sparkles } from "lucide-react";
import type { ProviderConfig } from "./data";
import { DEFAULT_AGENT_CARD } from "./data";
import type { LogEvent } from "./engine";
import { usePersisted, useSessionPersisted } from "./store";
import type { SwarmTask } from "../../lib/mcp-types";
import { mascotStateForRun } from "../../components/mascot/frames";
import { latestVmLifecycleEvent, resolveVmDisplayStatus, usePolledVmStatus } from "../../lib/client/vmStatus";
import { RUN_PHASE_META } from "../../lib/client/runPhase";
import { resetVm } from "../../lib/client/runs";
import { agentNameForUser, buildTaskPrompt, type TaskRunLink } from "../../lib/client/board";
import { useAgentSession } from "./hooks/useAgentSession";
import { useBoard } from "./hooks/useBoard";
import { useIsWide, useMe, useProviderStatus } from "./hooks/useEnvironment";
import { cn } from "./utils/cn";
import { ApprovalGate } from "./components/ApprovalGate";
import { BoardPanel } from "./components/BoardPanel";
import { Composer, type ComposerSendResult } from "./components/Composer";
import { useComputeOptions } from "./components/ComputePicker";
import type { ComputerView } from "./components/ComputerScreen";
import { Conversation } from "./components/Conversation";
import { Header, type WorkspaceView } from "./components/Header";
import { HistoryPanel } from "./components/HistoryPanel";
import type { SettingsTab } from "./components/Settings";
import { SettingsSheet } from "./components/SettingsSheet";
import { useToasts } from "./components/Toasts";
import { ScreenFrame } from "./components/dashboard/ScreenFrame";
import { Button, Loading, Notice, SplitHandle, clampSplitRatio, splitChatWidthCss, type SegmentOption } from "./components/ui";
import type { Attachment } from "./data";

const NO_LOGS: LogEvent[] = [];

const STARTERS = [
  "Build a small web app and show it running",
  "Research a topic and write a summary with sources",
  "Write a script, run it, and fix whatever breaks",
  "Check live system telemetry and explore running processes",
];

const APP_TITLE = "SwarmAgents";

export default function App() {
  const { push: pushToast } = useToasts();
  const wide = useIsWide();
  const me = useMe();
  const providerStatus = useProviderStatus();
  const compute = useComputeOptions(undefined);

  const [providers, setProviders] = usePersisted<ProviderConfig[]>("ac.providers", []);
  const [agentCard, setAgentCard] = usePersisted<string>("ac.agentCard", DEFAULT_AGENT_CARD);
  const [fullAuto, setFullAuto] = usePersisted<boolean>("ac.fullAuto", true);
  const [view, setView] = usePersisted<WorkspaceView>("sa.view", "chat");
  const [draft, setDraft] = useSessionPersisted<string>("sa.draft", "");
  // The chat column's share of the split row, persisted across reloads.
  const [splitRatio, setSplitRatio] = usePersisted<number>("sa.splitRatio", 0.38);
  const mainRef = useRef<HTMLElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);

  const session = useAgentSession({ agentCard, fullAuto, computeTarget: compute.target || undefined });
  const board = useBoard(view === "board");

  const [historyOpen, setHistoryOpen] = useState(false);
  const [settings, setSettings] = useState<{ open: boolean; tab: SettingsTab }>({ open: false, tab: "providers" });
  const [focusTaskId, setFocusTaskId] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // ---- VM screen ----

  const polledVm = usePolledVmStatus();
  const [vmResetting, setVmResetting] = useState(false);
  const [takingOver, setTakingOver] = useState(false);
  const [screenView, setScreenView] = useState<ComputerView>("desktop");
  const vmDisplay = resolveVmDisplayStatus({
    latestVmEvent: latestVmLifecycleEvent(session.liveItems),
    polledStatus: polledVm.status,
    resetting: vmResetting,
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
  const needsAttention =
    phase === "approval" || phase === "question" || phase === "paused" || phase === "error" || vmDisplay.state === "error";

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

  const handleSend = useCallback(
    async (text: string, attachments: Attachment[]): Promise<ComposerSendResult> => {
      const result = await session.send(text, attachments);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    [session],
  );

  const handleStop = useCallback(async () => {
    setStopping(true);
    const result = await session.stop();
    setStopping(false);
    if (!result.ok) pushToast({ tone: "error", message: "The run was not stopped.", detail: result.error });
  }, [session, pushToast]);

  const handleNewChat = useCallback(() => {
    session.newChat();
    setView("chat");
    focusComposer();
  }, [session, setView, focusComposer]);

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

  // Cmd/Ctrl+K focus
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      if (!wide) setView((current) => (current === "board" ? "chat" : current));
      focusComposer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [wide, setView, focusComposer]);

  // ---- Layout configuration ----

  const views: SegmentOption<WorkspaceView>[] = [
    { id: "chat", label: "Chat", icon: <MessageSquare className="h-3.5 w-3.5" aria-hidden /> },
    { id: "screen", label: "Screen", icon: <MonitorPlay className="h-3.5 w-3.5" aria-hidden /> },
    { id: "board", label: "Board", icon: <ClipboardList className="h-3.5 w-3.5" aria-hidden />, count: board.counts.open },
  ];

  const showStage = view !== "chat";
  const showChat = wide || view !== "board";
  const split = wide && showStage;
  const hero =
    view === "chat" && session.ready && session.turns.length === 0 && !session.pending && !session.turnsLoading;

  const activeThreadId = activeRun ? (activeRun.sessionId ?? activeRun.runId) : undefined;
  const headDuration =
    headRun?.finishedAt !== undefined && headRun.finishedAt >= headRun.createdAt
      ? headRun.finishedAt - headRun.createdAt
      : undefined;

  return (
    <div
      className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[var(--bg)] text-[var(--fg)]"
      data-testid="minimal-main-page"
      data-view={view}
    >
      {/* mynow.online ambient background aura + grain */}
      <div className="aura" />
      <div className="grain" />

      {/* Header with mascot, view switcher and telemetry indicator */}
      <Header
        title={session.title}
        mascotState={mascotStateForRun({ busy, needsAttention })}
        onOpenHistory={() => setHistoryOpen(true)}
        onNewChat={handleNewChat}
        newChatDisabled={busy}
        views={views}
        view={view}
        onView={setView}
        wide={wide}
        run={{
          phase,
          since: headRun?.createdAt,
          durationMs: headDuration,
          activity: session.activity,
          stopping,
          onStop: () => void handleStop(),
          onShow: showRun,
        }}
        onOpenSettings={() => openSettings("providers")}
        settingsNeedsAttention={providerStatus.state === "missing"}
      />

      {session.offline && !session.signedOut && (
        <Notice tone="warn" title="Cannot reach the server" className="mx-3 mt-3 z-20" testId="offline-notice">
          Retrying. Anything already running keeps going.
        </Notice>
      )}

      <main ref={mainRef} className="relative z-10 flex min-h-0 flex-1 flex-col lg:flex-row p-2 sm:p-3 gap-2 sm:gap-3">
        {/* Chat & Narration Column */}
        <div
          hidden={!showChat}
          ref={chatRef}
          style={split ? { width: splitChatWidthCss(splitRatio) } : undefined}
          className={cn(
            "order-2 flex min-h-0 min-w-0 flex-1 flex-col lg:order-1 glass rounded-[26px] p-2.5 sm:p-4 shadow-2xl hair",
            split && "lg:flex-none",
            hero && "justify-center",
            !showChat && "hidden",
          )}
          data-testid="chat-column"
        >
          {!session.ready && !session.signedOut ? (
            <Loading label="Connecting to autonomous swarm..." className="flex-1" />
          ) : hero ? (
            <div className="mx-auto w-full max-w-[640px] px-4 pb-6 text-center" data-testid="hero">
              <div className="enter flex justify-center mb-6">
                <div className="orb" data-state="idle" style={{ width: 68, height: 68 }}>
                  <div className="orb-glow" />
                  <div className="orb-core" />
                </div>
              </div>
              <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-[var(--fg)]">
                State the outcome.
              </h1>
              <p className="mx-auto mt-2 max-w-md text-sm text-[var(--mute)] leading-relaxed">
                The agent acts on its dedicated cloud computer with real tools, live browsing, and code execution. Watch the screen or step in anytime.
              </p>
            </div>
          ) : (
            <Conversation
              session={session}
              taskLinks={board.links}
              onWatchScreen={view === "screen" ? undefined : watchScreen}
              onOpenTask={openTask}
              onOpenProviders={() => openSettings("providers")}
              className="flex-1"
            />
          )}

          <div className={cn("mx-auto w-full pt-2", hero ? "max-w-[640px]" : "max-w-[760px]")}>
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
              providerStatus.state === "missing" && (
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
              blockedReason={session.signedOut ? "Sign in to send" : undefined}
              inputRef={composerRef}
            />

            {hero && (
              <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2" aria-label="Ideas to start with">
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => {
                      setDraft(starter);
                      focusComposer();
                    }}
                    className="press edge rounded-2xl hair bg-black/20 p-3 text-left transition hover:bg-white/[0.05]"
                  >
                    <div className="flex items-center gap-2 text-[12.5px] text-[var(--fg-2)] hover:text-white">
                      <Sparkles className="h-3.5 w-3.5 text-[var(--sig)] shrink-0" />
                      <span className="truncate">{starter}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Drag handle between the chat column and the stage (split view only). */}
        {split && (
          <SplitHandle
            containerRef={mainRef}
            chatRef={chatRef}
            ratio={clampSplitRatio(splitRatio)}
            onRatioChange={(next) => setSplitRatio(clampSplitRatio(next))}
          />
        )}

        {/* Live VM Screen / Board Stage */}
        {showStage && (
          <div
            className={cn(
              "sa-stage-in order-1 flex min-h-0 min-w-0 flex-col lg:order-2 lg:flex-1 glass rounded-[26px] p-2.5 sm:p-4 shadow-2xl hair overflow-hidden",
              view === "board" ? "flex-1" : "shrink-0 lg:shrink",
            )}
            data-testid="stage"
          >
            {view === "screen" ? (
              <ScreenFrame
                activeView={screenView}
                onToggleView={setScreenView}
                showDesktop={polledVm.desktop}
                logs={NO_LOGS}
                runId={session.liveRunId}
                runActive={Boolean(phaseMeta?.active && activeRun)}
                vmState={vmDisplay.state}
                vmResetting={vmResetting}
                polledVmStatus={polledVm.status}
                desktopMode={polledVm.desktop}
                activeRoleName="Agent"
                onResetVm={() => openSettings("agent")}
                onStopRun={() => void handleStop()}
                control={takingOver}
                onControlChange={setTakingOver}
                canControl={canControl}
                fitToHeight={wide}
                className={wide ? "h-full" : undefined}
              />
            ) : (
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
          </div>
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
      />
    </div>
  );
}
