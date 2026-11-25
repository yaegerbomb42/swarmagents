"use client";

/**
 * VmScreen — the computer: one frame, four views, one product.
 *
 * Layout, in every view:
 *
 *   ┌ VmFrame ────────────────────────────────────────────────┐
 *   │ [Desktop|Terminal|Browser|Files]  presence   controls    │
 *   │        stage (the active view; the others stay       │
 *   │        mounted but hidden)                          │
 *   │ ● computer · ● run + action · ● stream · ● changed   │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The frame is the same component in every view (vm/VmChrome), so switching
 * tabs changes only the stage. That is also what makes the desktop fade
 * possible: `useIdleChrome` hides the two bars (opacity, never layout) after
 * a few seconds of no pointer/keyboard activity while the desktop is on
 * stage, and the first mouse move brings them straight back.
 *
 * Every view is mounted lazily on first visit and then kept mounted and
 * hidden. That is deliberate:
 *
 *   - the desktop holds a live VNC socket; unmounting it on a tab switch
 *     re-handshakes VNC and repaints the first frame, which is exactly the
 *     "full re-render of the desktop stream" the brief forbids;
 *   - the terminal keeps its scroll position and does not replay the
 *     transcript when the user comes back;
 *   - files keeps the open file and the folder it was browsing.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Square } from "lucide-react";
import type { VmStatus } from "../../../../lib/vm/types";
import {
  deriveComputerAction,
  derivePresence,
  presenceFromActivity,
  type ComputerAction,
  type Presence,
  type PresenceRunState,
} from "../../../../lib/client/presence";
import { buildActivityLines } from "../../../../lib/client/activity";
import { getRunStreamBadge, useRunStream } from "../../../../lib/client/useRunStream";
import {
  latestVmLifecycleEvent,
  resolveVmDisplayStatus,
  type VmDisplay,
} from "../../../../lib/client/vmStatus";
import {
  EMPTY_TERMINAL_HISTORY,
  sanitizeTerminalHistory,
  terminalHistoryReducer,
  terminalHistoryValue,
} from "../../../../lib/client/terminalHistory";
import type { LogEvent } from "../../engine";
import { useSessionPersisted } from "../../store";
import { cn } from "../../utils/cn";
import type { DesktopControlMode } from "../../../../lib/client/desktopState";
import { BrowserView } from "../BrowserView";
import { DesktopView, type DesktopConnectionInfo } from "../DesktopView";
import { FilesView } from "../FilesView";
import { shortPath } from "../../design/vm-tokens";
import { useIdleChrome, VM_VIEW_TABS, VmFrame, VmStatusBar, type ComputerView } from "./VmChrome";
import { TerminalView } from "./TerminalView";

export type { ComputerView } from "./VmChrome";

export interface VmScreenProps {
  logs: LogEvent[];
  /**
   * When set, the terminal renders the live runtime SSE stream for this run
   * instead of the simulated `logs`, and presence follows the agent.
   */
  runId?: string;
  activeView: ComputerView;
  onToggleView: (view: ComputerView) => void;
  onResetVm: () => void;
  vmResetting: boolean;
  activeRoleName: string;
  /** Called when a terminal command is accepted and a shell run starts. */
  onShellRunStarted?: (runId: string) => void;
  /** Stop the live agent run (from the desktop takeover banner). */
  onStopRun?: () => void;
  /** Polled VM state from App (single poller for the page). */
  polledVmStatus?: VmStatus;
  /**
   * False once the server confirms this deployment runs with desktop mode
   * off: the desktop tab is hidden and the screen keeps the terminal,
   * browser and files views. Undefined/true keeps the desktop tab
   * (optimistic default).
   */
  desktopMode?: boolean;
  /** A workspace file to open in the Files tab. */
  filesOpenPath?: string;
  /**
   * Optional controlled desktop presence, for the frame's Take over button:
   * when `control` is defined the Desktop view does not draw its own mode
   * switch, and `onControlChange` is called instead.
   */
  control?: boolean;
  onControlChange?: (control: boolean) => void;
  canControl?: boolean;
  /**
   * Desktop connection facts (phase, latency, effective takeover mode),
   * forwarded from DesktopView so the frame's status pill and takeover
   * banner can follow the negotiated control state.
   */
  onConnection?: (info: DesktopConnectionInfo) => void;
  /** Extra controls rendered at the right end of the top bar. */
  controls?: React.ReactNode;
  className?: string;
  /**
   * The newest activity lines from the page's poll (lib/client/activity), for
   * when another consumer owns the run's SSE stream (the conversation does on
   * the main page). Presence falls back to these when this stream is empty.
   */
  activity?: ReadonlyArray<{ text: string }>;
  /**
   * Presence derived by the page from the run stream it already consumes.
   * Wins over this component's own derivation when it carries events.
   */
  presence?: Presence;
  /**
   * The agent's latest computer-use action, derived by the page from the
   * run stream it already consumes. Wins over this component's own
   * derivation when present (same pattern as `presence`).
   */
  computerAction?: ComputerAction;
}

/** The facts the status bar needs about the live desktop connection. */
interface DesktopConnInfo {
  latencyMs?: number;
  phase?: string;
  /** Effective takeover mode (requested ≠ control), for the frame pill. */
  takeover?: DesktopControlMode;
}

export function VmScreen({
  logs,
  runId,
  activeView,
  onToggleView,
  onResetVm,
  vmResetting,
  activeRoleName,
  onShellRunStarted = () => {},
  onStopRun,
  polledVmStatus,
  desktopMode = true,
  filesOpenPath,
  control,
  onControlChange,
  canControl,
  onConnection: onDesktopConnection,
  controls,
  className,
  activity,
  presence: pagePresence,
  computerAction: pageComputerAction,
}: VmScreenProps) {
  const stream = useRunStream(runId);
  const liveRun = Boolean(runId);
  const presence = useMemo<Presence>(() => derivePresence(stream.items), [stream.items]);
  // When the page's own conversation stream owns the SSE connection, this
  // hook sees nothing; the polled activity lines still say what the agent is
  // doing, so presence falls back to them instead of going blank.
  const fallbackPresence = useMemo<Presence | null>(() => {
    if (!activity || activity.length === 0) return null;
    const runState: PresenceRunState = liveRun ? "working" : "done";
    return presenceFromActivity(activity, runState);
  }, [activity, liveRun]);
  const effectivePresence: Presence =
    pagePresence && pagePresence.stats.seq > 0
      ? pagePresence
      : stream.items.length > 0
        ? presence
        : (fallbackPresence ?? presence);

  // The latest computer-use action for the desktop overlay: the page's
  // derivation wins when the page owns the run's stream, else this
  // component's own stream (same pattern as presence above).
  const streamComputerAction = useMemo(
    () => deriveComputerAction(stream.items),
    [stream.items],
  );
  const effectiveComputerAction = pageComputerAction ?? streamComputerAction;

  // VM display state: the run stream's vm.* updates (immediate while a run is
  // live) plus the polled VM state, which is the only signal that sees idle
  // hibernation. The mapping lives in lib/client/vmStatus.
  const latestVmError = [...stream.items].reverse().find((item) => item.kind === "vm.error");
  const vmErrorMessage =
    latestVmError && typeof latestVmError.data === "object" && latestVmError.data !== null
      ? (latestVmError.data as { message?: unknown }).message
      : undefined;
  const vmDisplay: VmDisplay = resolveVmDisplayStatus({
    latestVmEvent: latestVmLifecycleEvent(stream.items),
    polledStatus: polledVmStatus,
    resetting: vmResetting,
    errorMessage: typeof vmErrorMessage === "string" ? vmErrorMessage : undefined,
  });

  // Desktop mode off: hide the desktop tab and never show its stage.
  const showDesktop = desktopMode;
  const tabs = showDesktop ? VM_VIEW_TABS : VM_VIEW_TABS.filter((tab) => tab.view !== "desktop");
  const selectedView: ComputerView = showDesktop || activeView !== "desktop" ? activeView : "terminal";

  /* ── Terminal: user shell runs, input and history ─────────────────────── */

  const [shellRunId, setShellRunId] = useState<string>();
  const [runningShellRunId, setRunningShellRunId] = useState<string>();
  // Mirrored in a ref so Ctrl-C can cancel even in the same tick the POST
  // response arrives (before React re-renders).
  const runningShellRunIdRef = useRef<string | undefined>(undefined);
  // A shell run streams independently of the agent run.
  const shellStream = useRunStream(shellRunId);
  const [input, setInput] = useState("");
  const [rawHistory, setHistory] = useSessionPersisted<unknown>(
    "ac.terminalHistory",
    EMPTY_TERMINAL_HISTORY,
  );
  const historyState = sanitizeTerminalHistory(rawHistory);
  const [execBusy, setExecBusy] = useState(false);
  const [execError, setExecError] = useState<string>();
  const execAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const last = shellStream.items[shellStream.items.length - 1];
    if (last && (last.kind === "run.finished" || last.kind === "run.error" || last.kind === "run.cancelled")) {
      runningShellRunIdRef.current = undefined;
      setRunningShellRunId(undefined);
    }
  }, [shellStream.items]);

  const cancelShell = useCallback(async () => {
    const runId = runningShellRunIdRef.current;
    // Abort the POST if it is still in flight; the server sees the dropped
    // request and cancels the run it just created.
    execAbortRef.current?.abort();
    setExecBusy(false);
    setExecError(undefined);
    if (!runId) return;
    try {
      await fetch(`/api/runtime/vm/exec?runId=${encodeURIComponent(runId)}`, { method: "DELETE" });
    } catch {
      /* the run still ends locally when the stream closes */
    }
  }, []);

  const submitShell = useCallback(
    (raw: string) => {
      const cmd = raw.trim();
      if (!cmd || execBusy) return;
      setExecBusy(true);
      setExecError(undefined);
      setHistory((h: unknown) =>
        terminalHistoryReducer(sanitizeTerminalHistory(h), { type: "remember", command: cmd }),
      );
      setInput("");
      const controller = new AbortController();
      execAbortRef.current = controller;
      void (async () => {
        try {
          const res = await fetch("/api/runtime/vm/exec", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd }),
            signal: controller.signal,
          });
          const data = await res.json().catch(() => null);
          if (!res.ok || !data?.runId) {
            setExecError(data?.error ?? `exec failed (${res.status})`);
            return;
          }
          runningShellRunIdRef.current = String(data.runId);
          setShellRunId(String(data.runId));
          setRunningShellRunId(String(data.runId));
          onShellRunStarted(String(data.runId));
        } catch (err) {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            setExecError("Could not reach the runtime.");
          }
        } finally {
          if (execAbortRef.current === controller) execAbortRef.current = null;
          setExecBusy(false);
        }
      })();
    },
    [execBusy, onShellRunStarted, setHistory],
  );

  const onInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "c") {
        if (execBusy || runningShellRunIdRef.current) {
          event.preventDefault();
          setInput("");
          void cancelShell();
        }
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        const next = terminalHistoryReducer(historyState, { type: "up", draft: input });
        setHistory(next);
        setInput(terminalHistoryValue(next));
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = terminalHistoryReducer(historyState, { type: "down" });
        setHistory(next);
        setInput(terminalHistoryValue(next));
      }
    },
    [cancelShell, execBusy, historyState, input, setHistory],
  );

  /* ── Which views are mounted ──────────────────────────────────────────── */

  // Lazy on first visit, kept thereafter (see the module comment).
  const [seen, setSeen] = useState<Record<ComputerView, boolean>>(() => ({
    desktop: showDesktop,
    terminal: !showDesktop,
    browser: false,
    files: false,
  }));
  useEffect(() => {
    setSeen((current) => (current[selectedView] ? current : { ...current, [selectedView]: true }));
  }, [selectedView]);

  /* ── Shared chrome state ──────────────────────────────────────────────── */

  // The desktop steps its chrome back when the user is only watching. Its
  // own takeover control needs the bars, so idle never applies while in
  // control.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const idle = useIdleChrome(selectedView === "desktop" && !control, frameRef);

  const [conn, setConn] = useState<DesktopConnInfo>({});
  const onConnection = useCallback(
    (info: DesktopConnectionInfo) => {
      setConn(info);
      onDesktopConnection?.(info);
    },
    [onDesktopConnection],
  );

  const connection = liveRun ? { status: stream.status, reconnecting: stream.status === "reconnecting" } : null;
  const streamBadge = liveRun ? getRunStreamBadge(stream) : null;

  // The status bar stays one line: the location slot names the agent on the
  // desktop, the page in the browser and the file the agent last wrote in
  // Files. Long values truncate (shortPath), never wrap.
  const location =
    selectedView === "desktop"
      ? activeRoleName
      : selectedView === "browser"
        ? presence.action?.startsWith("Opening ")
          ? presence.action.slice("Opening ".length)
          : undefined
        : selectedView === "files"
          ? presence.wroteFile
            ? shortPath(presence.wroteFile)
            : ""
          : undefined;

  return (
    <VmFrame
      tabs={tabs}
      compactTabs
      activeView={selectedView}
      onToggleView={onToggleView}
      presence={effectivePresence}
      chromeIdle={idle}
      frameRef={frameRef}
      className={className}
      controls={
        <>
          {streamBadge && liveRun && (
            <span
              data-testid="stream-status-badge"
              className="hidden items-center rounded-full border border-sa-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-sa-fg3 sm:inline-flex"
              title={stream.error ? `Stream: ${streamBadge.label} (${stream.error})` : `Stream: ${streamBadge.label}`}
            >
              {streamBadge.label}
            </span>
          )}
          {controls}
          {liveRun && onStopRun && (
            <button
              type="button"
              onClick={onStopRun}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-sa-err/30 px-2 font-mono text-[10px] text-sa-err transition-colors hover:bg-sa-err/10"
            >
              <Square className="h-2.5 w-2.5 fill-current" /> stop
            </button>
          )}
        </>
      }
      statusBar={
        <VmStatusBar
          vm={vmDisplay}
          vmResetting={vmResetting}
          presence={effectivePresence}
          stream={connection}
          latencyMs={selectedView === "desktop" ? conn.latencyMs : undefined}
          location={location}
          stats={effectivePresence.stats}
        />
      }
    >
      <div className="relative flex min-h-0 flex-1">
        {seen.desktop && showDesktop && (
          <div
            className={cn("absolute inset-0", selectedView === "desktop" ? "block" : "hidden")}
            data-testid="vm-view-desktop"
          >
            <DesktopView
              vmState={vmDisplay.state}
              vmResetting={vmResetting}
              runActive={liveRun}
              onStopRun={onStopRun}
              presence={effectivePresence}
              computerAction={effectiveComputerAction}
              embedded
              control={control}
              onControlChange={onControlChange}
              canControl={canControl}
              onConnection={onConnection}
            />
          </div>
        )}

        {seen.terminal && (
          <div
            className={cn("absolute inset-0 flex", selectedView === "terminal" ? "" : "hidden")}
            data-testid="vm-view-terminal"
          >
            <TerminalView
              stream={liveRun ? { status: stream.status, items: stream.items } : null}
              shellStream={shellStream}
              shellRunId={shellRunId}
              logs={logs}
              runActive={liveRun}
              vmResetting={vmResetting}
              presence={effectivePresence}
              input={input}
              onInputChange={setInput}
              onInputKeyDown={onInputKeyDown}
              onSubmit={submitShell}
              onCancel={() => void cancelShell()}
              execBusy={execBusy}
              execError={execError}
              runningShellRunId={runningShellRunId}
            />
          </div>
        )}

        {seen.browser && (
          <div
            className={cn("absolute inset-0 flex", selectedView === "browser" ? "" : "hidden")}
            data-testid="vm-view-browser"
          >
            <BrowserView runId={liveRun ? runId : undefined} presence={effectivePresence} />
          </div>
        )}

        {seen.files && (
          <div
            className={cn("absolute inset-0 flex", selectedView === "files" ? "" : "hidden")}
            data-testid="vm-view-files"
          >
            <FilesView
              refreshToken={stream.items.reduce((token, item) => (item.kind === "run.finished" ? item.seq : token), 0)}
              openPath={filesOpenPath}
              changedPath={effectivePresence.wroteFile}
              changedAt={effectivePresence.changedAt}
              presence={effectivePresence}
              live={liveRun}
            />
          </div>
        )}
      </div>
    </VmFrame>
  );
}

export default VmScreen;
